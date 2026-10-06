//! Hilo de trabajo del STT: lee el audio capturado, decide con el VAD y llama al
//! motor de inferencia.
//!
//! # Por que un hilo propio
//!
//! La inferencia es una llamada bloqueante y opaca: puede tardar cientos de
//! milisegundos y no se puede interrumpir. Si viviera en el hilo de Tauri, cada
//! parcial congelaria la interfaz; si compartiera el hilo del DSP de audio, el
//! anillo de muestras se llenaria y se perderian muestras. Un hilo dedicado con
//! su propio canal de eventos resuelve ambos problemas.
//!
//! # Modelo de ownership
//!
//! El motor se mueve al hilo (`Box<dyn SttEngine>`) y por eso `SttEngine: Send`.
//! El hilo no comparte estado mutable salvo por canales, de modo que no hace falta
//! ningun `Arc<Mutex<..>>` en el camino de audio.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::engine::{EngineError, Language, SttEngine, TranscribeOptions};
use crate::segmenter::{AudioWindow, SegmentConfig, SegmentEvent, Segmenter};
use crate::vad::{FrameEvent, Vad, VadConfig};

/// Fragmento de texto emitido por el worker.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptionSegment {
  /// Texto reconocido. En parciales, el incremento desde el parcial anterior.
  pub text: String,
  /// `true` si el segmento se ha cerrado y el texto ya no cambiara.
  pub is_final: bool,
  /// Confianza media en `[0.0, 1.0]`.
  pub confidence: f32,
  /// Desfase del segmento respecto al inicio del flujo, en ms.
  pub start_ms: u64,
  /// Duracion del segmento, en ms.
  pub duration_ms: u64,
}

/// Contadores del worker, para la UI y los tests.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkerStats {
  /// Bloques de audio procesados.
  pub frames: u64,
  /// Ventanas entregadas al motor.
  pub inferences: u64,
  /// Fragmentos emitidos (parciales y finales).
  pub segments: u64,
  /// Segmentos descartados por demasiado cortos.
  pub discarded: u64,
  /// Errores del motor hasta ahora.
  pub errors: u64,
  /// Piso de ruido actual en dBFS, util para calibrar en la UI.
  pub noise_floor_db: f32,
  /// `true` si hay un segmento abierto.
  pub speaking: bool,
}

/// Fuente de muestras de 16 kHz mono.
///
/// La implementacion de produccion envuelve el `AudioEngine` del crate de audio, de
/// modo que el pipeline se pueda probar con fuentes sinteticas.
pub trait SampleSource: Send {
  /// Vacia en `out` las muestras disponibles ahora y devuelve cuantas.
  ///
  /// No debe bloquear: devuelve 0 si todavia no hay audio.
  fn drain(&mut self, out: &mut Vec<f32>) -> usize;
}

/// Fuente de laboratorio: entrega muestras de un sintetizador a demanda.
pub struct SynthSource {
  generator: Box<dyn FnMut(u64) -> f32 + Send>,
  block: usize,
  remaining: usize,
  /// Muestras entregadas hasta ahora.
  pub emitted: u64,
}

impl SynthSource {
  /// `block` es cuantas muestras entrega por llamada a `drain`.
  ///
  /// `total` es el total de muestras a entregar, no de muestras por bloque.
  pub fn new(
    generator: impl FnMut(u64) -> f32 + Send + 'static,
    block: usize,
    total: usize,
  ) -> Self {
    Self {
      generator: Box::new(generator),
      block,
      remaining: total,
      emitted: 0,
    }
  }

  /// Sintetiza voz hasta `speech_ms` y silencio el resto, con ruido de fondo.
  ///
  /// Reproduce la senal tipica de un microfono con ruido: frase y pausa.
  pub fn voice_then_silence(speech_ms: u64, silence_ms: u64, block: usize) -> Self {
    // 16 muestras por milisegundo a 16 kHz.
    const SAMPLES_PER_MS: u64 = 16;
    let total = (speech_ms + silence_ms) * SAMPLES_PER_MS;
    Self::new(
      move |index| sample_at_ms(index / SAMPLES_PER_MS, index),
      block,
      total as usize,
    )
  }
}

impl SampleSource for SynthSource {
  fn drain(&mut self, out: &mut Vec<f32>) -> usize {
    let count = self.remaining.min(self.block);
    out.clear();
    out.reserve(count);
    for _ in 0..count {
      out.push((self.generator)(self.emitted));
      self.emitted += 1;
      self.remaining -= 1;
    }
    count
  }
}

/// Ruido de fondo pseudoaleatorio y reproducible, sin estado mutable.
///
/// Se usa un hash del indice en vez de un LCG con semilla por llamada: un LCG
/// reinicializado en cada muestra devolveria siempre el MISMO valor, es decir un
/// offset de DC constante en lugar de ruido. El DC no es ruido, y el VAD (que mira
/// el cruce por cero) lo trata justo como lo que es.
pub fn sample_at_ms(ms: u64, index: u64) -> f32 {
  let background = hash_noise(index) * BACKGROUND_AMPLITUDE;
  if ms < LAB_SPEECH_MS {
    // Voz sintetica: fundamental con formante variable y dos armonicos, enveloped
    // por una modulacion lenta que NUNCA llega a cero. Un envolvente que se anula
    // abriria un hueco de silencio en mitad de la frase y partiria el segmento.
    let t = index as f32 / 16_000.0;
    let envelope = 0.30 + 0.10 * (2.0 * std::f32::consts::PI * 1.3 * t).sin();
    // F0 constante: si la frecuencia fundamental se modulase con el tiempo, los
    // batidos entre fundamental y armónicos producirian nodos de amplitud y el
    // cruce por cero caeria a cero en puntos concretos, suficiente para que el
    // guardia de ZCR troceara la frase.
    let phase = 2.0 * std::f32::consts::PI * 130.0 * t;
    let wave = phase.sin() + 0.5 * (2.0 * phase).sin() + 0.2 * (3.0 * phase).sin();
    // Senal cuadrada sesgada: asi el cruce por cero se mantiene lejos de 0 durante
    // toda la frase, que es el rango que el VAD considera sano.
    let voiced = if wave >= 0.0 { 0.6 } else { -0.6 };
    voiced * envelope + background
  } else {
    background
  }
}

/// Duracion de la "frase" de la senal de laboratorio, en ms.
pub const LAB_SPEECH_MS: u64 = 1000;

/// Ruido de fondo a -50 dBFS, muy por debajo del umbral de voz.
const BACKGROUND_AMPLITUDE: f32 = 0.003;

/// Hash entero a flotante en `[-1.0, 1.0)`, determinista y sin estado.
pub fn hash_noise(index: u64) -> f32 {
  // SplitMix64: mezcla fuerte y barata, con buena distribucion en los bits altos.
  let mut z = index
    .wrapping_add(0x9E37_79B9_7F4A_7C15)
    .wrapping_mul(0xBF58_476D_1CE4_E5B9);
  z = (z ^ (z >> 30)).wrapping_mul(0x94D0_49BB_1331_11EB);
  z = (z ^ (z >> 27)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
  z ^= z >> 31;
  // Los 24 bits altos dan un entero en [0, 2^24); escalado a [-1, 1).
  (z >> 40) as f32 / 8_388_608.0 - 1.0
}

/// Configuracion del worker.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
  pub vad: VadConfig,
  pub segment: SegmentConfig,
  /// Cada cuanto se vacia el anillo de audio. 10 ms es invisible para la UI y
  /// suficiente para que un bloque de 20 ms salga sin retardos acumulativos.
  pub poll_interval: Duration,
  /// Idioma inicial.
  pub language: Language,
}

impl Default for WorkerConfig {
  fn default() -> Self {
    Self {
      vad: VadConfig::default(),
      segment: SegmentConfig::default(),
      poll_interval: Duration::from_millis(10),
      language: Language::Auto,
    }
  }
}

/// Estado compartido con el hilo de Tauri: idioma y estadisticas.
#[derive(Debug, Default)]
struct Shared {
  language: Mutex<Language>,
  frames: AtomicU64,
  inferences: AtomicU64,
  segments: AtomicU64,
  discarded: AtomicU64,
  errors: AtomicU64,
  noise_floor_bits: AtomicU64,
  speaking: AtomicBool,
}

impl Shared {
  fn new(language: Language) -> Self {
    Self {
      language: Mutex::new(language),
      ..Default::default()
    }
  }

  fn language(&self) -> Language {
    // Un panico en el worker deja el mutex envenenado; el idioma se recupera igual
    // porque no es un estado de audio que pueda quedar a medias.
    *lock(&self.language)
  }

  /// El piso de ruido viaja como bits para evitar un mutex en el camino de audio.
  fn store_noise_floor(&self, db: f32) {
    self
      .noise_floor_bits
      .store(db.to_bits() as u64, Ordering::Relaxed);
  }

  fn noise_floor(&self) -> f32 {
    f32::from_bits(self.noise_floor_bits.load(Ordering::Relaxed) as u32)
  }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|err| err.into_inner())
}

/// Manejador del hilo de STT.
pub struct SttWorker {
  shared: Arc<Shared>,
  segments: Option<Receiver<TranscriptionSegment>>,
  stop: Option<Sender<()>>,
  handle: Option<JoinHandle<()>>,
}

impl SttWorker {
  /// Arranca el worker con su propio hilo.
  ///
  /// Devuelve error si el sistema operativo no concede el hilo; el llamador decide
  /// si eso es recuperable, y el estado nunca queda a medias porque aqui todavia no
  /// se ha tocado nada compartido.
  pub fn start(
    source: Box<dyn SampleSource>,
    engine: Box<dyn SttEngine>,
    config: WorkerConfig,
  ) -> std::io::Result<Self> {
    let shared = Arc::new(Shared::new(config.language));
    let (segment_tx, segments) = mpsc::channel();
    let (stop, stop_rx) = mpsc::channel();
    let worker_shared = Arc::clone(&shared);
    let segment_tx = Mutex::new(segment_tx);

    let handle = std::thread::Builder::new()
      .name("stt-worker".to_string())
      .spawn(move || {
        run(source, engine, config, worker_shared, segment_tx, stop_rx);
      })?;

    Ok(Self {
      shared,
      segments: Some(segments),
      stop: Some(stop),
      handle: Some(handle),
    })
  }

  /// Receptor de fragmentos, para reenviarlos como evento de Tauri.
  pub fn segments(&self) -> &Receiver<TranscriptionSegment> {
    self.segments.as_ref().expect("el receptor ya fue tomado")
  }

  /// Toma el receptor. Para tests o para un reenviador dedicado.
  pub fn take_segments(&mut self) -> Option<Receiver<TranscriptionSegment>> {
    self.segments.take()
  }

  /// Cambia el idioma en caliente, sin reiniciar el motor.
  pub fn set_language(&self, language: Language) {
    *lock(&self.shared.language) = language;
  }

  /// Idioma vigente.
  pub fn language(&self) -> Language {
    self.shared.language()
  }

  /// Instantanea de los contadores.
  pub fn stats(&self) -> WorkerStats {
    WorkerStats {
      frames: self.shared.frames.load(Ordering::Relaxed),
      inferences: self.shared.inferences.load(Ordering::Relaxed),
      segments: self.shared.segments.load(Ordering::Relaxed),
      discarded: self.shared.discarded.load(Ordering::Relaxed),
      errors: self.shared.errors.load(Ordering::Relaxed),
      noise_floor_db: self.shared.noise_floor(),
      speaking: self.shared.speaking.load(Ordering::Relaxed),
    }
  }

  /// Pide parada y espera al hilo.
  ///
  /// Al parar se fuerza un final del segmento abierto para que no se pierda texto.
  pub fn stop(&mut self) {
    if let Some(stop) = self.stop.take() {
      let _ = stop.send(());
    }
    if let Some(handle) = self.handle.take() {
      let _ = handle.join();
    }
    self.shared.speaking.store(false, Ordering::Relaxed);
  }
}

impl Drop for SttWorker {
  fn drop(&mut self) {
    self.stop();
  }
}

fn run(
  mut source: Box<dyn SampleSource>,
  mut engine: Box<dyn SttEngine>,
  config: WorkerConfig,
  shared: Arc<Shared>,
  segment_tx: Mutex<Sender<TranscriptionSegment>>,
  stop_rx: Receiver<()>,
) {
  let mut vad = Vad::new(config.vad);
  let mut segmenter = Segmenter::new(config.segment, config.vad.frame_ms);
  let frame_len = vad.frame_len();
  let frame_ms = config.vad.frame_ms as u64;
  let frame_duration = Duration::from_millis(frame_ms);

  let mut pending: Vec<f32> = Vec::with_capacity(frame_len * 8);
  let mut incoming: Vec<f32> = Vec::with_capacity(frame_len * 8);
  let mut frame: Vec<f32> = vec![0.0; frame_len];
  let silence: Vec<f32> = vec![0.0; frame_len];

  // Reloj de audio: lo avanza el audio real, no el reloj de pared.
  let mut audio_ms: u64 = 0;
  let mut segment_origin_ms: u64 = 0;
  // Silencio pendiente de inyectar cuando la captura no entrega muestras.
  let mut silence_debt = Duration::ZERO;
  let mut next_deadline = Instant::now() + config.poll_interval;

  loop {
    let tick = Instant::now();

    // 1. drenar el audio disponible
    incoming.clear();
    let received = source.drain(&mut incoming);
    pending.extend_from_slice(&incoming);

    let mut offset = 0;
    while pending.len() - offset >= frame_len {
      frame.copy_from_slice(&pending[offset..offset + frame_len]);
      offset += frame_len;
      audio_ms += frame_ms;
      process_frame(
        &frame,
        &mut vad,
        &mut segmenter,
        &mut engine,
        &mut audio_ms,
        &mut segment_origin_ms,
        frame_ms,
        &shared,
        &segment_tx,
      );
    }
    if offset > 0 {
      pending.drain(..offset);
    }

    // 2. Si la captura esta muda, el VAD debe seguir avanzando en el tiempo real.
    //
    // Sin esto, si el stream cae o el dispositivo se retira, el hangover no se
    // cumpliria nunca y el segmento quedaria abierto para siempre. El silencio se
    // inyecta por reloj de pared, no por vuelta de bucle, para no correr el VAD mas
    // rapido que el audio real.
    if received == 0 {
      silence_debt += tick.elapsed();
      while silence_debt >= frame_duration {
        silence_debt -= frame_duration;
        audio_ms += frame_ms;
        process_frame(
          &silence,
          &mut vad,
          &mut segmenter,
          &mut engine,
          &mut audio_ms,
          &mut segment_origin_ms,
          frame_ms,
          &shared,
          &segment_tx,
        );
      }
    } else {
      silence_debt = Duration::ZERO;
    }

    shared.store_noise_floor(vad.noise_floor_db());

    // 3. dormir hasta la proxima vuelta sin entrar en deficit de tiempo
    let now = Instant::now();
    if now < next_deadline {
      if stop_rx.recv_timeout(next_deadline - now) == Ok(()) {
        break;
      }
    } else {
      // Se acumulo retraso (una inferencia lenta). Se resincroniza sin esperar, para
      // que el deficit no crezca vuelta tras vuelta.
      next_deadline = now;
    }
    next_deadline += config.poll_interval;
  }

  // Al parar se entrega el segmento abierto: el usuario dijo su frase y la app se
  // cierra, ese texto no puede perderse.
  if let Some(window) = segmenter.flush() {
    let tx = lock(&segment_tx);
    let _ = transcribe_and_emit(
      &mut engine,
      &window,
      shared.language(),
      segment_origin_ms,
      &shared,
      &tx,
    );
  }
}

/// Consume un bloque ya cortado: VAD -> segmentador -> motor -> evento.
#[allow(clippy::too_many_arguments)]
fn process_frame(
  frame: &[f32],
  vad: &mut Vad,
  segmenter: &mut Segmenter,
  engine: &mut Box<dyn SttEngine>,
  audio_ms: &mut u64,
  segment_origin_ms: &mut u64,
  frame_ms: u64,
  shared: &Arc<Shared>,
  segment_tx: &Mutex<Sender<TranscriptionSegment>>,
) {
  let event = vad.push_frame(frame);
  if event == FrameEvent::SpeechStart {
    // `audio_ms` ya apunta al final del bloque: el inicio del segmento es un bloque
    // antes.
    *segment_origin_ms = audio_ms.saturating_sub(frame_ms);
  }
  let segment_event = segmenter.push(frame, event, *audio_ms, vad.speech_ms());
  shared.frames.fetch_add(1, Ordering::Relaxed);
  shared.speaking.store(vad.is_speaking(), Ordering::Relaxed);

  match segment_event {
    SegmentEvent::None => {}
    SegmentEvent::Discarded { .. } => {
      shared.discarded.fetch_add(1, Ordering::Relaxed);
    }
    SegmentEvent::Partial(window) | SegmentEvent::Final(window) => {
      let tx = lock(segment_tx);
      let _ = transcribe_and_emit(
        engine,
        &window,
        shared.language(),
        *segment_origin_ms,
        shared,
        &tx,
      );
    }
  }
}

fn transcribe_and_emit(
  engine: &mut Box<dyn SttEngine>,
  window: &AudioWindow,
  language: Language,
  segment_origin_ms: u64,
  shared: &Arc<Shared>,
  tx: &Sender<TranscriptionSegment>,
) -> Result<(), EngineError> {
  shared.inferences.fetch_add(1, Ordering::Relaxed);
  let options = TranscribeOptions {
    language,
    is_final: window.is_final,
  };
  let transcription = match engine.transcribe(&window.samples, options) {
    Ok(transcription) => transcription,
    Err(err) => {
      // Un fallo del motor no debe tumbar el worker: se cuenta, se avisa por log y
      // el siguiente segmento lo intentara de nuevo.
      shared.errors.fetch_add(1, Ordering::Relaxed);
      log::error!("fallo de inferencia: {err}");
      return Err(err);
    }
  };

  // Un parcial sin texto no se emite: la UI no necesita enterarse de un silencio a
  // mitad de frase. Un final vacio si se emite, para que la UI cierre lo que estaba mostrando.
  if transcription.text.is_empty() && !window.is_final {
    return Ok(());
  }

  let segment = TranscriptionSegment {
    text: transcription.text,
    is_final: window.is_final,
    confidence: transcription.confidence.clamp(0.0, 1.0),
    start_ms: segment_origin_ms + window.start_ms,
    duration_ms: window.duration_ms,
  };
  shared.segments.fetch_add(1, Ordering::Relaxed);
  if segment.is_final {
    engine.reset();
  }
  // Un receptor caido significa que la ventana se cerro: se ignora en vez de
  // propagar el error, que solo serviria para parar el worker.
  let _ = tx.send(segment);
  Ok(())
}
