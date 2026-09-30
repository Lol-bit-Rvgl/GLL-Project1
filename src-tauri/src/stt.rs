//! Estado de la app: worker de STT y descarga de modelos.
//!
//! # Por que un unico contenedor
//!
//! El worker de STT lee del `AudioEngine`, asi que ambos han de vivir en el mismo
//! sitio: si el motor de captura se registrara aparte, el worker leeria un anillo
//! vacio. Por eso `SttState` guarda el `Arc<AudioEngine>` y los comandos de audio
//! del Sprint 2 se apoyan en el mismo estado.
//!
//! # Hilos
//!
//! - `stt-worker`: VAD, segmentacion e inferencia. No toca la API de Tauri.
//! - `stt-forwarder`: drena el canal de segmentos y los emite como eventos.
//! - el hilo de la descarga: solo durante `download_model`.
//!
//! Tauri exige que el estado gestionado sea `Send + Sync + 'static`; los tres
//! cumplen porque el motor se mueve al hilo del worker y solo se comunica por
//! canales.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use lyricstream_asr::engine::{EngineError, EngineInfo};
use lyricstream_asr::model::{ModelInfo, ModelManager, ModelSpec};
use lyricstream_asr::whisper_engine::{self, WhisperEngine};
use lyricstream_asr::worker::{SttWorker, TranscriptionSegment, WorkerConfig, WorkerStats};
use lyricstream_asr::{AudioEngineSource, Language, SttEngine};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
/// Evento de progreso de descarga de modelo.
pub const EVENT_DOWNLOAD_PROGRESS: &str = "model-download-progress";
/// Resultado final de la descarga: ok o el error, para que la UI pueda avisar.
pub const EVENT_DOWNLOAD_RESULT: &str = "model-download-result";
/// Evento con un fragmento de transcripcion.
pub const EVENT_TRANSCRIPTION: &str = "transcription-segment";
/// Evento de cambio de estado del motor.
pub const EVENT_ENGINE_STATUS: &str = "stt-engine-status";

/// Modelo que usa la app mientras se integra el runtime de inferencia.
pub const ACTIVE_MODEL: ModelSpec = ModelSpec::WHISPER_TINY_Q5_1;

/// URL de los pesos. Se sustituye por la del modelo definitivo cuando se elija.
pub const MODEL_URL: &str =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin";

/// Progreso de una descarga: vive en `lyricstream_asr::progress` porque el paquete
/// raiz no puede ejecutar tests. Aqui solo se reexporta para los comandos.
pub use lyricstream_asr::progress::DownloadProgress;

/// Estado del motor de STT de cara a la UI.
#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
  /// `true` si hay un worker corriendo.
  pub running: bool,
  /// Nombre del backend en uso.
  pub engine: String,
  /// Si el motor reconoce voz de verdad. `false` si es un doble o si el runtime
  /// nativo no se pudo cargar.
  pub real_inference: bool,
  /// Que falta para poder transcribir, si algo.
  pub detail: String,
  /// Idioma vigente.
  pub language: String,
  /// `true` si hay una frase abierta ahora mismo.
  pub speaking: bool,
  /// Contadores del worker.
  pub stats: WorkerStats,
}

/// Estado gestionado por Tauri.
pub struct SttState {
  audio: Arc<lyricstream_audio::AudioEngine>,
  models: ModelManager,
  worker: Mutex<Option<SttWorker>>,
  forwarder_thread: Mutex<Option<JoinHandle<()>>>,
  downloading: Arc<AtomicBool>,
  language: Mutex<Language>,
  /// Como se describe el motor actual.
  ///
  /// Vive aqui, y no se lee del worker, porque el motor se mueve al hilo de inferencia
  /// y desde el hilo de Tauri no se puede preguntar. Se rellena al arrancar el worker y
  /// es lo que permite que `status()` distinga "transcribiendo de verdad" de "el
  /// runtime no estaba".
  engine: Mutex<EngineInfo>,
}

impl SttState {
  /// Crea el estado con el motor de captura y el gestor de modelos.
  pub fn new() -> Self {
    Self {
      audio: Arc::new(lyricstream_audio::AudioEngine::new()),
      models: ModelManager::new(),
      worker: Mutex::new(None),
      forwarder_thread: Mutex::new(None),
      downloading: Arc::new(AtomicBool::new(false)),
      language: Mutex::new(Language::Auto),
      engine: Mutex::new(EngineInfo::new(
        "ninguno",
        "",
        false,
        "el worker de STT no ha arrancado todavia",
      )),
    }
  }

  /// El motor de captura, para los comandos de audio del Sprint 2.
  pub fn audio(&self) -> &Arc<lyricstream_audio::AudioEngine> {
    &self.audio
  }

  /// El gestor de pesos.
  pub fn models(&self) -> &ModelManager {
    &self.models
  }

  /// Estado del modelo en disco.
  pub fn model_status(&self) -> ModelInfo {
    self.models.status(&ACTIVE_MODEL)
  }

  /// `true` mientras hay una descarga en curso.
  pub fn is_downloading(&self) -> bool {
    self.downloading.load(Ordering::Relaxed)
  }

  /// Bandera de descarga compartida con el hilo de descarga.
  ///
  /// El hilo necesita poder limpiarla al terminar, y `SttState` no existe todavia
  /// en ese hilo: se pasa el `Arc`, no una referencia al estado.
  pub fn downloading_flag(&self) -> Arc<AtomicBool> {
    Arc::clone(&self.downloading)
  }

  /// `true` si hay un worker corriendo.
  pub fn is_running(&self) -> bool {
    lock(&self.worker).is_some()
  }

  /// Idioma vigente.
  pub fn language(&self) -> Language {
    *lock(&self.language)
  }

  /// Cambia el idioma y lo propaga al worker si esta vivo.
  pub fn set_language(&self, language: Language) {
    *lock(&self.language) = language;
    if let Some(worker) = lock(&self.worker).as_ref() {
      worker.set_language(language);
    }
  }

  /// Arranca el worker de STT leyendo del motor de captura.
  ///
  /// El motor de inferencia se construye en `build_engine`, que elige whisper.cpp y
  /// puede no encontrar el runtime. Si falta, el worker arranca igualmente y el estado
  /// lo dice: es preferible a fallar, y permite validar el pipeline de extremo a
  /// extremo sin runtime desplegado.
  pub fn start(&self, app: &AppHandle) -> Result<EngineStatus, String> {
    if self.is_running() {
      return Ok(self.status());
    }
    // La captura debe estar viva: el worker lee su anillo de muestras.
    if !self.audio.status().running {
      return Err("no hay captura de audio activa: llama antes a start_capture".to_string());
    }
    // El modelo debe estar instalado antes que el motor: sin pesos no hay nada que
    // transcribir, y conviene decirlo con el nombre del modelo que falta.
    let info = self.models.status(&ACTIVE_MODEL);
    if !info.installed {
      return Err(format!(
        "falta el modelo {} en {}: usa download_model o install_model",
        info.file_name, info.expected_path
      ));
    }
    let model_path = self.models.model_path(&ACTIVE_MODEL);

    // `resource_dir` devuelve un `PathBuf` propio; se liga a una variable porque
    // `build_engine` toma una referencia y un temporal no vive lo suficiente.
    let resource_dir = app.path().resource_dir().ok();
    let engine = build_engine(
      &model_path,
      &ACTIVE_MODEL.name,
      whisper_threads(),
      resource_dir.as_deref(),
    );
    let engine_info = engine.info().clone();
    let source = Box::new(AudioEngineSource::new(Arc::clone(&self.audio)));
    let config = WorkerConfig {
      language: self.language(),
      ..Default::default()
    };
    let mut worker = SttWorker::start(source, engine, config);
    // El receptor se lleva el reenviador; el worker deja de exponerlo.
    let receiver = worker
      .take_segments()
      .ok_or_else(|| "el worker no entrega segmentos".to_string())?;
    let forwarder = spawn_forwarder(app.clone(), receiver);

    *lock(&self.forwarder_thread) = Some(forwarder);
    *lock(&self.worker) = Some(worker);
    *lock(&self.engine) = engine_info;
    log::info!("worker de STT arrancado");
    Ok(self.status())
  }

  /// Detiene el worker y espera a que suelte el motor de inferencia.
  pub fn stop(&self) -> Result<EngineStatus, String> {
    // Primero el worker: al soltarlo cae el emisor de segmentos y el reenviador
    // termina solo. Unirlo despues evita un join colgado.
    if let Some(mut worker) = lock(&self.worker).take() {
      worker.stop();
    }
    if let Some(handle) = lock(&self.forwarder_thread).take() {
      let _ = handle.join();
    }
    log::info!("worker de STT detenido");
    Ok(self.status())
  }

  /// Estado consolidado para la UI.
  pub fn status(&self) -> EngineStatus {
    let engine = lock(&self.engine).clone();
    let guard = lock(&self.worker);
    match guard.as_ref() {
      Some(worker) => {
        let stats = worker.stats();
        EngineStatus {
          running: true,
          // `real_inference` sale de `EngineInfo::ready`, que el motor construye al
          // cargar el runtime. No se fija a mano: si whisper.dll falta, `ready` es
          // `false` y la UI avisa en vez de mostrar texto inventado.
          engine: engine.name,
          real_inference: engine.ready,
          detail: engine.detail,
          language: self.language().as_str().to_string(),
          speaking: stats.speaking,
          stats,
        }
      }
      None => EngineStatus {
        running: false,
        engine: engine.name,
        real_inference: false,
        detail: if engine.ready {
          "worker detenido".to_string()
        } else {
          engine.detail
        },
        language: self.language().as_str().to_string(),
        speaking: false,
        stats: WorkerStats::default(),
      },
    }
  }
}

impl Default for SttState {
  fn default() -> Self {
    Self::new()
  }
}

/// Numero de hilos de inferencia.
///
/// Se limita a 2 a proposito. La maquina objetivo tiene ~1 GB de RAM y el equipo
/// compila con `jobs = 2`; con mas hilos, ggml reserva mas arena por hilo y el
/// modelo se va a swap. Para whisper Tiny la diferencia de velocidad entre 2 y 4
/// hilos es pequeña comparada con el coste en memoria. `LYRICSTREAM_THREADS` lo
/// permite subir en maquinas con memoria de sobra.
fn whisper_threads() -> i32 {
  std::env::var("LYRICSTREAM_THREADS")
    .ok()
    .and_then(|value| value.trim().parse::<i32>().ok())
    .filter(|n| *n > 0)
    .unwrap_or(2)
}

/// Busca el directorio del runtime de whisper.
///
/// El orden es: variable de entorno, `resource_dir` de Tauri, directorio del
/// ejecutable y directorio de trabajo. Se prueban varios porque el sitio donde caen
/// los recursos depende de como se haya empaquetado: `tauri.conf.json` copia las DLL
/// a `whisper/`, Tauri anade un nivel `resources` en Windows/Linux, y en macOS los
/// ficheros van en la raiz del bundle. En `cargo run` no hay resource dir en absoluto.
///
/// `resource_dir` se pasa como `Option` porque en desarrollo no existe: ahi se resuelve
/// por la variable de entorno o por el directorio de trabajo.
fn find_runtime_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
  if let Ok(dir) = std::env::var("LYRICSTREAM_WHISPER_DIR") {
    let path = PathBuf::from(dir);
    if whisper_engine::has_runtime(&path) {
      return Some(path);
    }
  }
  if let Some(dir) = resource_dir {
    // Tauri anade un nivel `resources` en Windows/Linux, pero en macOS los ficheros
    // van en la raiz del bundle. Se prueban varios (raiz, resources, whisper).
    for candidate in [
      dir.to_path_buf(),
      dir.join("resources"),
      dir.join("whisper"),
      dir.join("resources/whisper"),
    ] {
      if whisper_engine::has_runtime(&candidate) {
        return Some(candidate);
      }
    }
  }
  if let Some(path) = whisper_engine::find_runtime_dir() {
    return Some(path);
  }
  None
}

/// Motor de inferencia a usar.
///
/// Este es el unico punto que decide el backend, y ahora que hay un motor real
/// tambien es el unico que puede fallar. Se intenta whisper.cpp; si el runtime o el
/// modelo no estan, NO se cae a `StubEngine` a proposito.
///
/// La razon: `StubEngine` produce texto sintetico del tipo `[demo parcial 1000ms
/// -22dB]` y lo marca como `real_inference: false`. Volver a el cuando falta el
/// runtime daria una transcripcion que parece funcionar y no transcribe, que es peor
/// que un error con diagnostico. Aqui se devuelve un whisper-cpp no listo, con
/// `ready = false` y el motivo en `detail`, y la UI lo enseña.
///
/// El doble de prueba sigue existiendo para los tests del pipeline, que lo inyectan
/// directamente por `SttWorker::start`.
fn build_engine(
  model_path: &Path,
  model_name: &str,
  threads: i32,
  resource_dir: Option<&Path>,
) -> Box<dyn SttEngine> {
  match find_runtime_dir(resource_dir) {
    Some(dir) => match WhisperEngine::load(&dir, model_path, threads) {
      Ok(engine) => {
        log::info!(
          "motor whisper.cpp listo: {} · modelo {model_name}",
          engine.info().version
        );
        Box::new(engine)
      }
      Err(err) => {
        log::error!("whisper.cpp no se pudo cargar: {err}");
        Box::new(WhisperEngine::unavailable(&dir, model_path, &err))
      }
    },
    None => {
      let err = EngineError::RuntimeUnavailable(
        "no se encontro whisper.dll: instala el runtime junto al ejecutable o define \
         LYRICSTREAM_WHISPER_DIR"
          .to_string(),
      );
      Box::new(WhisperEngine::unavailable(Path::new("."), model_path, &err))
    }
  }
}

/// Hilo que convierte fragmentos en eventos de Tauri.
///
/// El motor puede producir mas rapido de lo que la UI consume; el canal es
/// ilimitado y este hilo es el unico que llama a `emit`, de modo que nunca se
/// bloquea la inferencia por el frontend.
fn spawn_forwarder(app: AppHandle, receiver: Receiver<TranscriptionSegment>) -> JoinHandle<()> {
  std::thread::Builder::new()
    .name("stt-forwarder".to_string())
    .spawn(move || {
      while let Ok(segment) = receiver.recv() {
        if let Err(err) = app.emit(EVENT_TRANSCRIPTION, &segment) {
          log::warn!("no se pudo emitir el segmento: {err}");
          return;
        }
      }
    })
    .expect("no se pudo crear el hilo stt-forwarder")
}

/// Emisor de progreso espaciado en el tiempo.
///
/// Emitir en cada bloque de la descarga generaria cientos de eventos por segundo
/// hacia el webview. Se limita a 4 por segundo, y siempre deja pasar el ultimo.
pub struct ProgressEmitter {
  app: AppHandle,
  last_emit: Instant,
  interval: Duration,
}

impl ProgressEmitter {
  pub fn new(app: AppHandle) -> Self {
    Self {
      app,
      // Antiqueado para que el primer progreso se emita de inmediato.
      last_emit: Instant::now() - Duration::from_secs(1),
      interval: Duration::from_millis(250),
    }
  }

  /// Emite progreso como mucho cada `interval`, y siempre el ultimo.
  pub fn report(&mut self, downloaded: u64, total: Option<u64>) {
    let progress = DownloadProgress {
      downloaded,
      total,
      percent: total
        .filter(|total| *total > 0)
        .map(|total| (downloaded as f32 / total as f32 * 100.0).clamp(0.0, 100.0)),
    };
    let is_last = progress.is_complete();
    if !is_last && self.last_emit.elapsed() < self.interval {
      return;
    }
    self.last_emit = Instant::now();
    if let Err(err) = self.app.emit(EVENT_DOWNLOAD_PROGRESS, &progress) {
      log::warn!("no se pudo emitir el progreso: {err}");
    }
  }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|err| err.into_inner())
}

/// Marcador de que el backend actual no hace inferencia real.
///
/// La UI lo lee para no presentar texto de ejemplo como si fuera una transcripcion.
pub const ENGINE_IS_STUB: bool = true;
