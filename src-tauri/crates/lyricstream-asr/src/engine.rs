//! Contrato del motor de inferencia y un doble de prueba.
//!
//! Toda la logica de streaming (VAD, ventanas, ciclo de vida) vive fuera de este
//! modulo. Un motor real solo implementa [`SttEngine`], lo que permite:
//!
//! - Probar el pipeline completo sin pesos, sin DLL y sin red.
//! - Cambiar ONNX Runtime por whisper.cpp sin tocar el worker.
//! - Decidir el backend en tiempo de ejecucion segun lo que haya en disco.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Idiomas aceptados por el motor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Language {
  /// Deteccion automatica de idioma.
  #[default]
  Auto,
  /// Espanol.
  Es,
  /// Ingles.
  En,
}

impl Language {
  /// Parsea el codigo de idioma, aceptando variantes regionales (`es-ES`).
  pub fn parse(value: &str) -> Option<Self> {
    let base = value.trim().to_ascii_lowercase();
    let base = base.split(['-', '_']).next().unwrap_or("");
    match base {
      "auto" | "detect" | "" => Some(Language::Auto),
      "es" | "espanol" | "spanish" => Some(Language::Es),
      "en" | "english" | "ingles" => Some(Language::En),
      _ => None,
    }
  }

  /// Codigo de idioma.
  pub fn as_str(self) -> &'static str {
    match self {
      Language::Auto => "auto",
      Language::Es => "es",
      Language::En => "en",
    }
  }

  /// Idiomas concretos, para pasarlos a un motor que no sepa autodetectar.
  pub fn explicit(self) -> Option<&'static str> {
    match self {
      Language::Auto => None,
      other => Some(other.as_str()),
    }
  }
}

/// Errores de un motor de inferencia.
#[derive(Debug, Error)]
pub enum EngineError {
  /// Los pesos no estan en disco o no se pueden leer.
  #[error("no se pudo cargar el modelo: {0}")]
  Model(String),
  /// La DLL de ONNX Runtime / whisper.cpp no se encontro o no cargo.
  #[error("el runtime de inferencia no esta disponible: {0}")]
  RuntimeUnavailable(String),
  /// El motor recibio audio que no puede decodificar.
  #[error("entrada invalida: {0}")]
  InvalidInput(String),
  /// Fallo dentro del runtime: error de forma, memoria, etc.
  #[error("fallo de inferencia: {0}")]
  Inference(String),
  /// Error de E/S leyendo o escribiendo.
  #[error("error de E/S: {0}")]
  Io(#[from] std::io::Error),
}

/// Como describirse el motor a la UI.
#[derive(Debug, Clone, Serialize)]
pub struct EngineInfo {
  /// Nombre corto del backend (`onnx`, `whisper-cpp`, `stub`).
  pub name: String,
  /// Version del runtime o del modelo, si se conoce.
  pub version: String,
  /// `true` si el motor puede transcribir ahora mismo.
  pub ready: bool,
  /// Que le falta para estar listo, en texto para la UI.
  pub detail: String,
}

impl EngineInfo {
  pub fn new(name: &str, version: &str, ready: bool, detail: &str) -> Self {
    Self {
      name: name.to_string(),
      version: version.to_string(),
      ready,
      detail: detail.to_string(),
    }
  }
}

/// Opciones de una llamada de transcripcion.
#[derive(Debug, Clone, Copy)]
pub struct TranscribeOptions {
  /// Idioma solicitado; `Auto` deja que el motor lo decida.
  pub language: Language,
  /// `true` si la ventana cierra el segmento (utterance completo).
  pub is_final: bool,
}

/// Resultado de transcribir una ventana.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Transcription {
  /// Texto reconocido. Vacio si la ventana no contenia voz.
  pub text: String,
  /// Confianza media en `[0.0, 1.0]`. `0.0` si el motor no la reporta.
  pub confidence: f32,
}

/// Motor de reconocimiento de voz.
///
/// Implementaciones reales: `OnnxEngine` (ONNX Runtime) y `WhisperEngine`
/// (whisper.cpp). [`StubEngine`] NO reconoce voz: sirve para tests.
pub trait SttEngine: Send {
  /// Descripcion del motor para la UI.
  fn info(&self) -> &EngineInfo;

  /// Transcribe una ventana de muestras a 16 kHz mono.
  ///
  /// Las ventanas parciales se solapan: la implementacion debe transcribir solo la
  /// parte nueva respecto a la llamada anterior, o devolver el texto completo de la
  /// ventana y dejar que la UI lo reemplace. Devolver solo el incremento nuevo es
  /// preferible, porque mantiene el texto final coherente con el parcial anterior.
  fn transcribe(
    &mut self,
    samples: &[f32],
    options: TranscribeOptions,
  ) -> Result<Transcription, EngineError>;

  /// Descarta el contexto entre segmentos.
  fn reset(&mut self) {}

  /// Bytes de pesos que el motor tiene cargados, para diagnostico de memoria.
  fn resident_bytes(&self) -> usize {
    0
  }
}

/// Doble de prueba: **no reconoce voz**.
///
/// Produce texto sintetico determinista a partir de la duracion y la energia de la
/// ventana, de forma que los tests del pipeline pueden comprobar la estructura de
/// los eventos, el orden, los limites de memoria y el ciclo de vida sin depender de
/// pesos ni de un runtime nativo. Nunca debe usarse como motor real.
#[derive(Debug, Clone)]
pub struct StubEngine {
  info: EngineInfo,
  /// Llamadas atendidas, para aserciones de los tests.
  pub calls: usize,
  /// Numero total de muestras que el doble ha recibido.
  pub samples_seen: usize,
  /// Umbral de energia para distinguir "voz" de "silencio" en el texto sintetico.
  pub speech_db: f32,
}

impl StubEngine {
  pub fn new() -> Self {
    Self {
      info: EngineInfo::new("stub", "0", true, "doble de prueba: no reconoce voz"),
      calls: 0,
      samples_seen: 0,
      speech_db: -50.0,
    }
  }
}

impl Default for StubEngine {
  fn default() -> Self {
    Self::new()
  }
}

impl SttEngine for StubEngine {
  fn info(&self) -> &EngineInfo {
    &self.info
  }

  fn transcribe(
    &mut self,
    samples: &[f32],
    options: TranscribeOptions,
  ) -> Result<Transcription, EngineError> {
    if samples.is_empty() {
      return Err(EngineError::InvalidInput("ventana vacia".to_string()));
    }
    if !samples.iter().all(|s| s.is_finite()) {
      return Err(EngineError::InvalidInput("muestras no finitas".to_string()));
    }
    self.calls += 1;
    self.samples_seen += samples.len();

    let db = crate::vad::Vad::rms_db(samples);
    if db <= self.speech_db {
      return Ok(Transcription::default());
    }
    let duration_ms = samples.len() as u64 * 1000 / 16_000;
    let kind = if options.is_final { "final" } else { "parcial" };
    Ok(Transcription {
      text: format!("[demo {kind} {duration_ms}ms {db:.0}dB]"),
      confidence: ((db + 60.0) / 60.0).clamp(0.0, 1.0),
    })
  }
}
