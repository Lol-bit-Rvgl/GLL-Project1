//! Segmentacion en streaming: convierte el flujo de bloques del VAD en ventanas
//! de audio que el decodificador puede consumir.
//!
//! El modelo distingue dos escalas, que es lo que hace util a un STT local en
//! streaming:
//!
//! - **Parciales.** Cada `partial_stride_ms` de voz se emite una ventana con la cola
//!   del utterance. La ventana **crece**: arranca en `partial_min_ms` y se abre hasta
//!   `partial_window_ms` segun avanza la frase, y en cada renovacion se solapa con la
//!   anterior. Asi el motor siempre ve la frase completa hasta donde da, sin pagar
//!   5 s de inferencia en el primer parcial de una palabra suelta.
//! - **Final.** Cuando el VAD cierra el segmento se entrega el **utterance
//!   completo**, no una ventana. Un decodificador con contexto (Whisper,
//!   Zipformer) rinde mucho mejor con la frase entera que con trozos de 1 s.
//!
//! El utterance se acota con `max_utterance_ms` para que una frase interminable
//! (o un VAD que nunca cierra) no crezca sin limite.

use crate::vad::FrameEvent;

/// Ventana de audio que se entrega al motor.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioWindow {
  /// Muestras a 16 kHz mono, en `[-1.0, 1.0]`.
  pub samples: Vec<f32>,
  /// Desfase del inicio de la ventana respecto al segmento, en ms.
  pub start_ms: u64,
  /// Duracion de la ventana, en ms.
  pub duration_ms: u64,
  /// `true` si es el utterance completo y cierra el segmento.
  pub is_final: bool,
}

/// Parametros de la segmentacion.
#[derive(Debug, Clone, Copy)]
pub struct SegmentConfig {
  /// Frecuencia de muestreo de las ventanas de salida.
  pub sample_rate: u32,
  /// Longitud MINIMA de la ventana parcial, en ms.
  ///
  /// Es el suelo, no un valor fijo: la ventana parcial CRECE con el utterance (ver
  /// `partial_span_ms`). El minimo existe porque whisper necesita un poco de voz
  /// para no inventar palabras: con 200 ms de audio suele devolver ruido.
  pub partial_min_ms: u64,
  /// Longitud MAXIMA de la ventana parcial, en ms. Limita el trabajo por bloque.
  pub partial_window_ms: u64,
  /// Cada cuanto se renueva la ventana parcial, en ms.
  pub partial_stride_ms: u64,
  /// Tope del utterance acumulado, en ms. Al superarlo se fuerza un final.
  pub max_utterance_ms: u64,
  /// Minimo de voz para que un segmento se considere frase.
  pub min_speech_ms: u32,
}

impl Default for SegmentConfig {
  fn default() -> Self {
    Self {
      sample_rate: 16_000,
      // 1 s: el suelo de la ventana parcial. Por debajo, whisper no tiene bastante
      // contexto y devuelve mas ruido que texto.
      partial_min_ms: 1_000,
      // 5 s: el techo. Whisper Tiny rinde bien hasta aqui; a partir de 10 s la
      // exactitud cae porque el encoder se estira sobre una frase que no es.
      partial_window_ms: 5_000,
      // 500 ms entre parciales. Con la ventana creciendo hasta 5 s, dos parciales
      // consecutivos se solapan 4.5 s, muy por encima del minimo de 200 ms: eso es
      // justo lo que evita que una palabra se parta entre dos ventanas.
      partial_stride_ms: 500,
      // 15 s por frase. Es un tope de seguridad, no el objetivo: el VAD suele cerrar
      // antes. 15 s de f32 son 960 KB, despreciables, y mantiene las frases dentro
      // de lo que Tiny transcribe bien.
      max_utterance_ms: 15_000,
      min_speech_ms: 200,
    }
  }
}

impl SegmentConfig {
  /// Longitud de la ventana parcial en este instante, en ms.
  ///
  /// Es la pieza que convierte esto en una ventana deslizante de verdad en vez de una
  /// ventana fija: la ventana se abre desde `partial_min_ms` y crece con la voz hasta
  /// `partial_window_ms`. Empezar siempre en 1 s daria texto a los 500 ms pero sin
  /// contexto; empezar siempre en 5 s costaria 5 s de inferencia por cada parcial.
  ///
  /// El solapamiento entre dos parciales es `span - partial_stride_ms`, que con estos
  /// valores nunca baja de 500 ms.
  pub fn partial_span_ms(&self, utterance_ms: u64) -> u64 {
    utterance_ms.clamp(self.partial_min_ms, self.partial_window_ms)
  }
}

/// Lo que el segmentador pide hacer con una ventana.
#[derive(Debug, Clone, PartialEq)]
pub enum SegmentEvent {
  /// Nada que transcribir todavia.
  None,
  /// Transcribir una ventana parcial.
  Partial(AudioWindow),
  /// Transcribir el utterance completo y cerrar el segmento.
  Final(AudioWindow),
  /// El segmento se descarto por ser demasiado corto, para que la UI pueda limpiar
  /// un texto parcial que ya hubiera mostrado.
  Discarded { duration_ms: u64 },
}

impl SegmentEvent {
  /// Ventana a transcribir, si la hay.
  pub fn window(&self) -> Option<&AudioWindow> {
    match self {
      SegmentEvent::Partial(window) | SegmentEvent::Final(window) => Some(window),
      _ => None,
    }
  }
}

/// Acumula los bloques del VAD y decide cuando emitir ventanas.
#[derive(Debug, Clone)]
pub struct Segmenter {
  cfg: SegmentConfig,
  /// Voz del segmento abierto, incluida la cola de silencio del hangover.
  utterance: Vec<f32>,
  /// Longitud de bloque en muestras, usada para reservar capacidad upfront.
  frame_len: usize,
  /// Instante del ultimo parcial emitido, en ms del flujo de audio.
  last_partial_ms: u64,
}

impl Segmenter {
  /// Crea el segmentador. `frame_ms` define el tamano de bloque del VAD.
  pub fn new(cfg: SegmentConfig, frame_ms: u32) -> Self {
    let frame_len = cfg.sample_rate as usize * frame_ms as usize / 1000;
    Self {
      cfg,
      utterance: Vec::new(),
      frame_len,
      last_partial_ms: 0,
    }
  }

  pub fn config(&self) -> &SegmentConfig {
    &self.cfg
  }

  /// `true` si hay un segmento abierto.
  pub fn has_segment(&self) -> bool {
    !self.utterance.is_empty()
  }

  /// Duracion acumulada del utterance, en ms.
  pub fn utterance_ms(&self) -> u64 {
    self.utterance.len() as u64 * 1000 / self.cfg.sample_rate as u64
  }

  /// Bytes reservados por el utterance. Para tests de memoria acotada.
  pub fn utterance_bytes(&self) -> usize {
    self.utterance.capacity() * std::mem::size_of::<f32>()
  }

  /// Consume un bloque ya clasificado por el VAD.
  ///
  /// `now_ms` es el instante de audio del final del bloque y `speech_ms` los
  /// milisegundos de voz real que el VAD lleva contados en el segmento.
  pub fn push(
    &mut self,
    frame: &[f32],
    event: FrameEvent,
    now_ms: u64,
    speech_ms: u32,
  ) -> SegmentEvent {
    match event {
      FrameEvent::SpeechStart => {
        // Un SpeechStart con utterance pendiente solo puede venir de un segmento
        // abandonado: se descarta para no encadenar dos frases sin silencio real.
        self.utterance.clear();
        self.last_partial_ms = 0;
        self.reserve();
        self.utterance.extend_from_slice(frame);
        SegmentEvent::None
      }
      FrameEvent::Speech | FrameEvent::SpeechEnd => {
        if self.utterance.is_empty() {
          return SegmentEvent::None;
        }
        self.utterance.extend_from_slice(frame);

        if event == FrameEvent::SpeechEnd {
          if speech_ms < self.cfg.min_speech_ms {
            // Golpe de ruido: se tira entero, sin pasar por el motor.
            let duration_ms = self.utterance_ms();
            self.clear();
            return SegmentEvent::Discarded { duration_ms };
          }
          return SegmentEvent::Final(self.take_final());
        }

        // Tope de memoria: en vez de descartar audio se cierra el segmento. El texto
        // de lo ya acumulado se conserva; solo se pierde la continuation posterior.
        if self.utterance_ms() >= self.cfg.max_utterance_ms {
          return SegmentEvent::Final(self.take_final());
        }

        if now_ms.saturating_sub(self.last_partial_ms) >= self.cfg.partial_stride_ms {
          self.last_partial_ms = now_ms;
          SegmentEvent::Partial(self.partial_window())
        } else {
          SegmentEvent::None
        }
      }
      FrameEvent::Silence => {
        // Si hubiera un segmento abierto, el hangover del VAD ya lo habria cerrado.
        SegmentEvent::None
      }
    }
  }

  /// Descarta el segmento en curso sin emitir nada.
  pub fn clear(&mut self) {
    self.utterance.clear();
    self.last_partial_ms = 0;
  }

  /// Cierra el segmento actual si lo hay, sin exigir minimo de voz.
  ///
  /// Lo usa el worker al detenerse: si el usuario deja de hablar con la app
  /// abierta, el texto pendiente debe salir igual.
  pub fn flush(&mut self) -> Option<AudioWindow> {
    if self.utterance.is_empty() {
      return None;
    }
    Some(self.take_final())
  }

  /// Ultimos `partial_span_ms` del utterance.
  fn partial_window(&self) -> AudioWindow {
    let span_ms = self.cfg.partial_span_ms(self.utterance_ms());
    let window_samples = (self.cfg.sample_rate as u64 * span_ms / 1000) as usize;
    let start = self.utterance.len().saturating_sub(window_samples);
    let samples = self.utterance[start..].to_vec();
    AudioWindow {
      duration_ms: samples.len() as u64 * 1000 / self.cfg.sample_rate as u64,
      start_ms: start as u64 * 1000 / self.cfg.sample_rate as u64,
      samples,
      is_final: false,
    }
  }

  /// Entrega el utterance completo y limpia el acumulador.
  fn take_final(&mut self) -> AudioWindow {
    let samples = std::mem::take(&mut self.utterance);
    // Tras `take` la capacidad es 0: se reserva de nuevo para que el proximo
    // segmento no tenga que crecer a base de realocaciones.
    self.reserve();
    self.last_partial_ms = 0;
    AudioWindow {
      duration_ms: samples.len() as u64 * 1000 / self.cfg.sample_rate as u64,
      start_ms: 0,
      samples,
      is_final: true,
    }
  }

  /// Reserva capacidad para un segmento corto sin tocar el allocator en caliente.
  fn reserve(&mut self) {
    if self.utterance.capacity() == 0 {
      self.utterance.reserve(self.frame_len * 8);
    }
  }
}
