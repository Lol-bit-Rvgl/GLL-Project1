//! Motor de STT local en streaming.
//!
//! Este crate implementa el camino completo entre el audio capturado y el texto:
//!
//! ```text
//!   AudioEngine (16 kHz mono)
//!          |  ring buffer, sin bloqueos
//!          v
//!   SttWorker  --->  Vad  -->  Segmenter  -->  SttEngine  -->  mpsc
//!   (hilo dedicado) energia/ZCR   ventanas        (ONNX,        |
//!                                  parciales       whisper)      v
//!                                                        TranscriptionSegment
//! ```
//!
//! # Reparto de responsabilidades
//!
//! - [`vad`]: decide si un bloque de 20 ms contiene voz, con piso de ruido
//!   adaptativo, puerta de SNR, histeresis y guardia de cruce por cero.
//! - [`segmenter`]: acumula la frase y emite ventanas parciales solapadas, y entrega
//!   el utterance completo al cerrar el segmento.
//! - [`engine`]: el contrato que cumple cualquier decodificador. Sin esta costura el
//!   pipeline quedaria atado a un unico runtime.
//! - [`whisper_engine`]: la implementacion real, sobre whisper.cpp cargado por
//!   [`lyricstream_whisper_sys`]. Requiere el runtime y el modelo en disco; el resto
//!   del crate no lo necesita.
//! - [`model`]: rutas, estado, hash e instalacion de los pesos, sin E/S en el camino
//!   de audio.
//! - [`worker`]: el hilo que lo orquesta y el canal de eventos que consume la UI.
//!
//! # Sustituir el VAD o el motor
//!
//! El pipeline no depende de ningun runtime nativo: `cargo test` corre entero sin
//! DLL de ONNX Runtime, sin whisper.cpp y sin pesos, porque el motor real solo se
//! instancia desde la capa de Tauri. Un Silero VAD ONNX o un Zipformer se integran
//! implementando el trait correspondiente sin tocar el resto.

pub mod engine;
pub mod fetch;
pub mod model;
pub mod progress;
pub mod segmenter;
pub mod vad;
pub mod whisper_engine;
pub mod worker;

pub use engine::{
  EngineError, EngineInfo, Language, SttEngine, StubEngine, TranscribeOptions, Transcription,
};
pub use fetch::CurlFetcher;
pub use model::{
  default_models_dir, hex, sha256_file, Fetcher, ModelError, ModelInfo, ModelManager, ModelSpec,
};
pub use progress::{DownloadOutcome, DownloadProgress};
pub use segmenter::{AudioWindow, SegmentConfig, SegmentEvent, Segmenter};
pub use vad::{FrameEvent, Vad, VadConfig};
pub use worker::{
  SampleSource, SttWorker, SynthSource, TranscriptionSegment, WorkerConfig, WorkerStats,
};

use std::sync::Arc;

use lyricstream_audio::AudioEngine;

/// Fuente de produccion: extrae muestras del motor de captura.
///
/// El `AudioEngine` expone un `drain` no bloqueante (Sprint 2), asi que encaja
/// directo con el `SampleSource` del worker sin a馻adir primitivas de sincronizacion.
pub struct AudioEngineSource {
  engine: Arc<AudioEngine>,
}

impl AudioEngineSource {
  pub fn new(engine: Arc<AudioEngine>) -> Self {
    Self { engine }
  }
}

impl SampleSource for AudioEngineSource {
  fn drain(&mut self, out: &mut Vec<f32>) -> usize {
    self.engine.read_mono(out)
  }
}
