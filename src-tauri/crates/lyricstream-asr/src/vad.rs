//! Detector de actividad de voz (VAD) basado en energia adaptativa y cruce por cero.
//!
//! Su trabajo es barato y determinista: decidir si un bloque de 20 ms contiene voz
//! para que el silencio no llegue al decodificador y los impulsos de ruido no abran
//! un segmento. No pretende competir con un clasificador neuronal (Silero, Zipformer);
//! por eso se apoya en la regla `SttEngine` de `engine.rs`, de modo que sustituirlo
//! por un VAD ONNX no toque el segmentador ni el worker.
//!
//! # Criterio de decision
//!
//! 1. **Piso de ruido adaptativo.** Durante el silencio se sigue el nivel de fondo
//!    con un seguidor lento (`noise_follow`). Asi el umbral no depende de una
//!    calibracion previa ni de un microfono concreto.
//! 2. **Puerta SNR.** Un bloque es voz si supera el piso por `snr_threshold_db`.
//!    Al estar en voz la exigencia baja a la mitad (histeresis): una consonante sorda
//!    o una pausa dentro de la frase no debe cerrar el segmento.
//! 3. **Piso absoluto.** Por debajo de `abs_threshold_db` no hay voz aunque el SNR sea
//!    alto, para que un ruido de fondo bajito no se normalice a si mismo como voz.
//! 4. **Cruce por cero (ZCR).** Banda de sanidad: descarta zumbido de red (ZCR ~ 0) y
//!    siseo (ZCR alto). Es un guardia grueso con banda muerta, no un clasificador.

/// Banda muerta del cruce por cero, como fraccion del pico del bloque.
pub const ZCR_DEADBAND: f32 = 0.1;

/// Resultado de clasificar un bloque de audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameEvent {
  /// No hay voz en este bloque.
  Silence,
  /// Primer bloque de voz de una frase; el segmento acaba de abrirse.
  SpeechStart,
  /// Voz en curso, dentro de un segmento ya abierto.
  Speech,
  /// El hangover se cumplio; el segmento se cierra aqui.
  SpeechEnd,
}

/// Parametros del detector.
#[derive(Debug, Clone, Copy)]
pub struct VadConfig {
  /// Duracion del bloque analizado. 20 ms equilibra latencia y estabilidad del RMS.
  pub frame_ms: u32,
  /// Frecuencia de muestreo de entrada (el motor trabaja a 16 kHz mono).
  pub sample_rate: u32,
  /// Voces consecutivas por encima del umbral para abrir un segmento (anti-golpes).
  pub onset_ms: u32,
  /// Minimo de voz real antes de que un segmento se considere frase.
  pub min_speech_ms: u32,
  /// Silencio sostenido que cierra el segmento.
  pub hangover_ms: u32,
  /// Suelo absoluto en dBFS. Por debajo de esto no hay voz.
  pub abs_threshold_db: f32,
  /// SNR necesario para abrir un segmento.
  pub snr_threshold_db: f32,
  /// Seguimiento del piso de ruido durante el silencio (0 = congelado, 1 = sin memoria).
  pub noise_follow: f32,
  /// Banda de sanidad del cruce por cero.
  pub min_zcr: f32,
  pub max_zcr: f32,
  /// Margen que se exige al abrir frase respecto al umbral de continuacion.
  pub onset_gain_db: f32,
}

impl Default for VadConfig {
  fn default() -> Self {
    Self {
      frame_ms: 20,
      sample_rate: 16_000,
      onset_ms: 60,
      min_speech_ms: 200,
      hangover_ms: 700,
      // Por debajo de -50 dBFS no hay nada util: es el suelo del pipeline analogico.
      abs_threshold_db: -50.0,
      // 12 dB sobre el piso separan voz de una sala ruidosa sin cortar consonantes.
      snr_threshold_db: 12.0,
      // 0.05 por bloque de 20 ms converge el piso en ~1 s ante un ruido de fondo
      // alto, y no sube rapido durante voz porque el piso solo aprende en silencio.
      noise_follow: 0.05,
      // Un zumbido se queda por debajo de 0.005; el siseo pasa de 0.6. La voz
      // real se mueve entre 0.01 y 0.35.
      min_zcr: 0.005,
      // 0.35 separa el ruido estacionario (0.45 para blanco, 0.60 para siseo) de
      // las fricivas, que son la parte de voz con mas cruces y siguen por debajo.
      max_zcr: 0.35,
      onset_gain_db: 6.0,
    }
  }
}

impl VadConfig {
  /// Numero de muestras por bloque.
  pub fn frame_len(&self) -> usize {
    self.sample_rate as usize * self.frame_ms as usize / 1000
  }

  /// Bloques consecutivos de voz necesarios para abrir un segmento.
  pub fn onset_frames(&self) -> u32 {
    (self.onset_ms / self.frame_ms).max(1)
  }

  /// Bloques de silencio que cierran el segmento.
  pub fn hangover_frames(&self) -> u32 {
    (self.hangover_ms / self.frame_ms).max(1)
  }

  /// Umbral de energia segun el estado, para diagnostico y tests.
  pub fn onset_threshold_db(&self) -> f32 {
    self.abs_threshold_db + self.onset_gain_db
  }

  /// Umbral de energia para continuar en voz, mas permisivo que el de apertura.
  ///
  /// Se toma el MINIMO de los dos cortes, no el maximo: `abs_threshold_db` actua
  /// como cota superior (señal por debajo es silencio) y `snr_threshold_db / 2`
  /// como margen minimo de calidad. Hay que exigir AMBOS, asi que el umbral
  /// efectivo es el mas restrictivo de los dos.
  pub fn sustain_threshold_db(&self) -> f32 {
    self.abs_threshold_db.min(self.snr_threshold_db / 2.0)
  }
}

/// Estado del detector a lo largo del tiempo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
  /// Cerrado, esperando voz.
  Idle,
  /// Hay un segmento abierto.
  Speaking,
}

/// Detector de actividad de voz con memoria.
#[derive(Debug, Clone)]
pub struct Vad {
  cfg: VadConfig,
  state: State,
  /// Piso de ruido en dBFS, estimado con un seguidor asimetrico.
  noise_db: f32,
  /// Bloques de voz consecutivos (para el onset).
  onset_count: u32,
  /// Bloques de silencio consecutivos (para el hangover).
  silence_count: u32,
  /// Voz acumulada del segmento abierto, en bloques.
  speech_frames: u32,
}

impl Vad {
  /// Crea un detector con el piso de ruido en silencio digital.
  pub fn new(cfg: VadConfig) -> Self {
    Self {
      cfg,
      state: State::Idle,
      // El piso arranca en silencio y sube solo si hay ruido de fondo real.
      noise_db: -90.0,
      onset_count: 0,
      silence_count: 0,
      speech_frames: 0,
    }
  }

  pub fn config(&self) -> &VadConfig {
    &self.cfg
  }

  /// Numero de muestras por bloque.
  pub fn frame_len(&self) -> usize {
    self.cfg.frame_len()
  }

  /// Piso de ruido actual en dBFS, util para diagnostico y tests.
  pub fn noise_floor_db(&self) -> f32 {
    self.noise_db
  }

  /// `true` si hay un segmento abierto.
  pub fn is_speaking(&self) -> bool {
    self.state == State::Speaking
  }

  /// Voz acumulada del segmento abierto, en milisegundos.
  pub fn speech_ms(&self) -> u32 {
    self.speech_frames * self.cfg.frame_ms
  }

  /// Energia de un bloque en dBFS.
  pub fn rms_db(samples: &[f32]) -> f32 {
    if samples.is_empty() {
      return -90.0;
    }
    let sum: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    let rms = (sum / samples.len() as f64).sqrt();
    if rms <= 1e-9 {
      -90.0
    } else {
      (20.0 * rms.log10()) as f32
    }
  }

  /// Fraccion de cambios de signo del bloque, con banda muerta para no contar ruido.
  ///
  /// La banda muerta es RELATIVA al pico del propio bloque. Con un umbral fijo
  /// (0.02, unos -34 dBFS) una voz tranquila a -40 dBFS no cruzaria nunca la banda
  /// y su cruce por cero saldría 0, es decir el VAD la tomaria por zumbido de red.
  /// Al escalar con el pico, el criterio es independiente del volumen.
  pub fn zero_cross_rate(samples: &[f32]) -> f32 {
    if samples.len() < 2 {
      return 0.0;
    }
    let peak = samples
      .iter()
      .fold(0.0f32, |acc, sample| acc.max(sample.abs()));
    if peak <= 1e-9 {
      return 0.0;
    }
    // 10 % del pico: descarta la cola de ruido sin comerse la senal, y el tope
    // absoluto evita que una muestra de muy alta presencia del dome todo.
    let deadband = (peak * ZCR_DEADBAND).min(0.05);
    let mut crossings = 0u32;
    let mut last_sign = sign_of(samples[0], deadband);
    for &sample in &samples[1..] {
      let sign = sign_of(sample, deadband);
      if sign != 0 && last_sign != 0 && sign != last_sign {
        crossings += 1;
      }
      if sign != 0 {
        last_sign = sign;
      }
    }
    crossings as f32 / (samples.len() - 1) as f32
  }

  /// Clasifica un bloque y devuelve el evento de segmento que provoca.
  pub fn push_frame(&mut self, samples: &[f32]) -> FrameEvent {
    let db = Self::rms_db(samples);
    let zcr = Self::zero_cross_rate(samples);

    // El piso de ruido solo aprende en silencio: si se actualizase con voz, el
    // umbral acabaria persiguiendo al hablante y este nunca abriria un segmento.
    if self.state == State::Idle {
      self.noise_db = follow(self.noise_db, db, self.cfg.noise_follow);
    }

    let threshold = match self.state {
      State::Idle => self.cfg.onset_threshold_db(),
      State::Speaking => self.cfg.sustain_threshold_db(),
    };
    let snr_ok = db - self.noise_db >= self.cfg.snr_threshold_db;
    let zcr_ok = zcr >= self.cfg.min_zcr && zcr <= self.cfg.max_zcr;
    let is_speech = db >= threshold && snr_ok && zcr_ok;

    match self.state {
      State::Idle => {
        if is_speech {
          self.onset_count += 1;
          if self.onset_count >= self.cfg.onset_frames() {
            self.state = State::Speaking;
            self.onset_count = 0;
            self.silence_count = 0;
            self.speech_frames = self.cfg.onset_frames();
            return FrameEvent::SpeechStart;
          }
        } else {
          self.onset_count = 0;
        }
        FrameEvent::Silence
      }
      State::Speaking => {
        if is_speech {
          self.silence_count = 0;
          self.speech_frames += 1;
          return FrameEvent::Speech;
        }
        // `speech_frames` cuenta solo bloques con voz: el silencio del hangover
        // pertenece al segmento (se sigue apending para no cortar la frase) pero no
        // debe hacer que un golpe de ruido pase el minimo de voz.
        self.silence_count += 1;
        if self.silence_count >= self.cfg.hangover_frames() {
          self.state = State::Idle;
          self.silence_count = 0;
          FrameEvent::SpeechEnd
        } else {
          FrameEvent::Speech
        }
      }
    }
  }

  /// Descarta el estado del segmento conservando el piso de ruido aprendido.
  ///
  /// Se usa al parar la captura o al cambiar de dispositivo, para que una parada
  /// larga no obligue al siguiente segmento a recalibrar el suelo.
  pub fn reset(&mut self) {
    self.state = State::Idle;
    self.onset_count = 0;
    self.silence_count = 0;
    self.speech_frames = 0;
  }
}

fn sign_of(sample: f32, deadband: f32) -> i8 {
  if sample > deadband {
    1
  } else if sample < -deadband {
    -1
  } else {
    0
  }
}

/// Seguimiento asimetrico: sube despacio, baja rapido.
///
/// El ruido de fondo puede crecer de golpe (un ventilador, una puerta) pero debe
/// bajar rapido cuando cesa, o el umbral se quedaria alto y perderia voz.
fn follow(current: f32, sample: f32, rate: f32) -> f32 {
  if sample < current {
    // Bajada rapida: el suelo se ajusta de inmediato a un ambiente mas silencioso.
    current + (sample - current) * 0.5
  } else {
    current + (sample - current) * rate.clamp(0.0, 1.0)
  }
}
