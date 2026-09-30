//! Comandos que el frontend invoca desde TypeScript.
//!
//! Todos devuelven `Result<_, String>`: la cadena de error es lo que Tauri envia al
//! `invoke` del frontend, asi que debe ser legible por una persona.
//!
//! Los comandos de audio (Sprint 2) y los de STT (Sprint 3) comparten estado: el
//! worker de inferencia lee del mismo `AudioEngine` que alimenta la captura.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use lyricstream_asr::model::{ModelInfo, ModelManager};
use lyricstream_asr::{AudioEngineSource, CurlFetcher, Language, SttEngine, StubEngine};
use lyricstream_audio::{AudioDevicesInfo, AudioSource, CaptureStatus};
use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, State, WebviewWindow};

use crate::stt::{
  ACTIVE_MODEL, EVENT_DOWNLOAD_RESULT, EVENT_ENGINE_STATUS, EVENT_MINI_MODE, EngineStatus,
  MODEL_URL, MiniModeStatus, ProgressEmitter, SttState,
};
use lyricstream_asr::mini_window::{Geometria, Pantalla};
use lyricstream_asr::progress::DownloadOutcome;

/// Emite el estado del motor a la UI.
///
/// Se declara aqui y no solo en `stt.rs` porque los comandos son los unicos que
/// conocen cuando cambia: el worker no puede emitir por si mismo.
fn emit_engine_status(app: &AppHandle, status: &EngineStatus) {
  if let Err(err) = app.emit(EVENT_ENGINE_STATUS, status) {
    log::warn!("no se pudo emitir el estado del motor: {err}");
  }
}

/// Estado gestionado, con motor de captura y worker de STT.
type Stt<'a> = State<'a, SttState>;

// ---------------------------------------------------------------------------
// Audio (Sprint 2)
// ---------------------------------------------------------------------------

/// Dispositivos de entrada y salida disponibles, con cual es el de por defecto.
#[tauri::command]
pub fn get_audio_devices() -> Result<AudioDevicesInfo, String> {
  lyricstream_audio::AudioEngine::devices()
    .map_err(|err| format!("no se pudieron enumerar los dispositivos: {err}"))
}

/// Arranca la captura. `source` es `"loopback"` (audio del sistema) o `"mic"`.
/// Si ya habia una captura activa, la sustituye.
#[tauri::command]
pub fn start_capture(state: Stt<'_>, source: String) -> Result<(), String> {
  let source = AudioSource::parse(&source)?;
  state.audio().start(source)
}

/// Detiene la captura y libera el stream y el hilo de audio.
#[tauri::command]
pub fn stop_capture(state: Stt<'_>) -> Result<(), String> {
  state.audio().stop()
}

/// Nivel RMS instantaneo del audio capturado, en [0, 1]. Vale 0 si no hay captura.
#[tauri::command]
pub fn get_audio_level(state: Stt<'_>) -> Result<f32, String> {
  Ok(state.audio().level())
}

/// Pausa o reanuda el encolado de audio sin cerrar el stream.
#[tauri::command]
pub fn set_capture_paused(state: Stt<'_>, paused: bool) -> Result<bool, String> {
  state.audio().set_paused(paused)
}

/// Estado detallado de la captura: origen, formato de origen y muestras perdidas.
#[tauri::command]
pub fn get_capture_status(state: Stt<'_>) -> Result<CaptureStatus, String> {
  Ok(state.audio().status())
}

// ---------------------------------------------------------------------------
// Modelo (Sprint 3)
// ---------------------------------------------------------------------------

/// Estado del modelo junto al del motor, en una sola llamada.
///
/// La UI necesita las dos cosas al montar la ventana; separarlas obligaria a dos
/// `invoke` y a una carrera entre ellos.
#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
  /// Estado de los pesos en disco.
  pub model: ModelInfo,
  /// Estado del motor de inferencia.
  pub engine: EngineStatus,
  /// `true` si hay una descarga en curso.
  pub downloading: bool,
  /// Directorio donde se buscan los pesos, para mostrarlo en la UI.
  pub models_dir: String,
}

/// Estado del modelo y del motor de inferencia.
#[tauri::command]
pub fn get_model_status(state: Stt<'_>) -> Result<ModelStatus, String> {
  Ok(ModelStatus {
    model: state.model_status(),
    engine: state.status(),
    downloading: state.is_downloading(),
    models_dir: state.models().root().display().to_string(),
  })
}

/// Descarga los pesos en segundo plano, informando progreso por evento.
///
/// La descarga vive en un hilo aparte: el comando devuelve de inmediato y el
/// frontend recibe `model-download-progress` hasta que termina, seguido de
/// `model-download-result` con el exito o el error. Sin ese ultimo evento, un
/// fallo de red se manifestaria como una barra clavada al 100% y una UI que
/// sigue diciendo "no instalado" sin explicar por que.
///
/// Una segunda llamada mientras hay una descarga en curso se rechaza en vez de
/// duplicar los 32 MB.
#[tauri::command]
pub fn download_model(app: AppHandle, state: Stt<'_>) -> Result<(), String> {
  if state.is_downloading() {
    return Err("ya hay una descarga en curso".to_string());
  }
  let existing = state.model_status();
  if existing.is_usable() {
    return Err(format!("{} ya esta instalado", existing.name));
  }

  // Todo lo que necesita el hilo se clona aqui; `AppHandle` es `Send + Sync`.
  let root = state.models().root().to_path_buf();
  let flag = Arc::clone(&state.downloading_flag());
  // El hilorecibe una segunda copia para poder limpiar la bandera si `spawn`
  // falla: si solo se moviera al cierre, el `map_err` no podria tocarla.
  let spawn_guard = Arc::clone(&flag);
  let emitter_app = app.clone();
  flag.store(true, Ordering::SeqCst);

  std::thread::Builder::new()
    .name("model-download".to_string())
    .spawn(move || {
      let mut emitter = ProgressEmitter::new(emitter_app.clone());
      let fetcher = CurlFetcher::default();
      let models = ModelManager::with_root(root);
      let result = models.download(
        &ACTIVE_MODEL,
        MODEL_URL,
        &fetcher,
        &mut |downloaded, total| emitter.report(downloaded, total),
      );
      flag.store(false, Ordering::SeqCst);

      // El estado se relee tras el intento: un fallo de verificacion deja el
      // fichero puesto pero inservible, y la UI necesita verlo asi.
      let outcome = match &result {
        Ok(_) => DownloadOutcome::success(models.status(&ACTIVE_MODEL)),
        Err(err) => {
          log::error!("fallo la descarga del modelo: {err}");
          DownloadOutcome::failure(err)
        }
      };
      if let Err(err) = emitter_app.emit(EVENT_DOWNLOAD_RESULT, &outcome) {
        log::warn!("no se pudo emitir el resultado de la descarga: {err}");
      }
    })
    .map_err(|err| {
      // El hilo no llego a crearse: la bandera se limpia a mano o la app
      // creeria que hay una descarga eternamente en curso.
      spawn_guard.store(false, Ordering::SeqCst);
      format!("no se pudo crear el hilo de descarga: {err}")
    })?;

  Ok(())
}

/// Instala pesos desde un fichero ya presente en disco.
///
/// Es la via que funciona sin red: el usuario (o el script de instalacion) aporta
/// el `.bin` y se instala con verificacion de hash.
#[tauri::command]
pub fn install_model(state: Stt<'_>, path: String) -> Result<ModelInfo, String> {
  state
    .models()
    .install_from_file(&ACTIVE_MODEL, std::path::Path::new(&path))
    .map_err(|err| err.to_string())
}

// ---------------------------------------------------------------------------
// STT (Sprint 3)
// ---------------------------------------------------------------------------

/// Arranca el worker de transcripcion. Requiere captura activa.
#[tauri::command]
pub fn start_stt(app: AppHandle, state: Stt<'_>) -> Result<EngineStatus, String> {
  let status = state.start(&app)?;
  // Se emite ademas del retorno: el comando que arranca puede venir de otra
  // ventana, y el evento deja el estado al dia en todas.
  emit_engine_status(&app, &status);
  Ok(status)
}

/// Detiene el worker de transcripcion.
#[tauri::command]
pub fn stop_stt(app: AppHandle, state: Stt<'_>) -> Result<EngineStatus, String> {
  let status = state.stop()?;
  emit_engine_status(&app, &status);
  Ok(status)
}

/// Estado del worker: si corre, que backend usa y sus contadores.
#[tauri::command]
pub fn get_stt_status(state: Stt<'_>) -> Result<EngineStatus, String> {
  Ok(state.status())
}

/// Selecciona el idioma: `auto`, `es` o `en`.
///
/// Se aplica en caliente, sin reiniciar el worker: el motor lo lee en la siguiente
/// ventana. Se rechazan los codigos desconocidos en vez de caer en `auto` en
/// silencio, que dejaria al usuario creyendo que habia cambiado algo.
#[tauri::command]
pub fn set_stt_language(state: Stt<'_>, lang: String) -> Result<String, String> {
  let language = Language::parse(&lang)
    .ok_or_else(|| format!("idioma no soportado: {lang} (usa auto, es o en)"))?;
  state.set_language(language);
  Ok(language.as_str().to_string())
}

/// Lee las muestras pendientes del anillo de captura.
///
/// Expuesto para diagnostico: el worker consume el mismo anillo, asi que en uso
/// normal sale vacio. Vaciarlo por aqui mientras el worker corre es justo lo que
/// este comando no debe usarse para hacer.
#[tauri::command]
pub fn drain_capture(state: Stt<'_>, max_samples: Option<usize>) -> Result<usize, String> {
  let limit = max_samples.unwrap_or(16_000);
  let mut buffer = Vec::new();
  let read = state.audio().read_mono(&mut buffer);
  Ok(read.min(limit))
}

/// Estado de la mini-ventana, compartido entre el comando y el evento de resize.
///
/// Vive en `SttState` y no en un `static` porque ya hay un contenedor y `SttState` es
/// `Send + Sync`: un `static mut` o un `thread_local` obligaria a sincronizar a mano
/// justo en el unico comando que puede llegar desde dos sitios a la vez (el boton y el
/// atajo).
#[tauri::command]
pub fn toggle_mini_mode(window: WebviewWindow, state: Stt<'_>) -> Result<MiniModeStatus, String> {
  let escala = window.scale_factor().unwrap_or(1.0);
  let actual = geometria_actual(&window)?;
  let pantalla = pantalla_actual(&window);

  // El `plan` se decide con la aritmetica pura de `lyricstream_asr::mini_window`, que si
  // tiene tests. Aqui solo se traducen sus numeros a llamadas de ventana.
  let (decision, activo) = {
    let mut mini = state
      .mini()
      .lock()
      .map_err(|err| format!("estado mini bloqueado: {err}"))?;
    let decision = mini.alternar(actual, escala, pantalla);
    let activo = mini.activo;
    (decision, activo)
  };

  if let Some(geom) = decision.geometria() {
    window
      .set_size(LogicalSize::new(geom.w, geom.h))
      .map_err(|err| format!("no se pudo redimensionar la ventana: {err}"))?;
    window
      .set_position(LogicalPosition::new(geom.x, geom.y))
      .map_err(|err| format!("no se pudo mover la ventana: {err}"))?;
  }

  // En mini se quita el marco: a 450x250 los bordes del titulo se comen una franja
  // entera, y ademas el titulo no aporta nada porque el contenido ya dice que esta en
  // modo mini.
  window
    .set_decorations(!activo)
    .map_err(|err| format!("no se pudo cambiar el marco: {err}"))?;
  // `always_on_top` es el motivo de ser del modo: la app esta sobre otra, tomando
  // notas. Sin el, la mini se iria al fondo con el primer cambio de ventana.
  window
    .set_always_on_top(activo)
    .map_err(|err| format!("no se pudo fijar la ventana encima: {err}"))?;
  // El minimo se baja en mini para que el usuario pueda encogerla mas, y se RESTAURA al
  // salir. Poner `None` al salir tambien funciona, pero deja la ventana normal
  // redimensionable hasta 1x1 para siempre, que no es lo que quiere nadie.
  let (min_w, min_h) = if activo {
    (150.0, 100.0)
  } else {
    (800.0, 600.0)
  };
  window
    .set_min_size(Some(LogicalSize::new(min_w, min_h)))
    .map_err(|err| format!("no se pudo cambiar el tamano minimo: {err}"))?;
  // En mini se quita de la barra de tareas: dos entradas de la misma app es ruido. La
  // ventana no se pierde, porque el propio overlay lleva el boton Salir, que es el
  // camino de vuelta.
  window
    .set_skip_taskbar(activo)
    .map_err(|err| format!("no se pudo tocar la barra de tareas: {err}"))?;

  if let Err(err) = window.emit(EVENT_MINI_MODE, &MiniModeStatus { active: activo }) {
    log::warn!("no se pudo emitir el estado del modo mini: {err}");
  }

  Ok(MiniModeStatus { active: activo })
}

/// Lee si la ventana esta en modo compacto.
///
/// El frontend lo necesita al montar: si se recarga la webview con la mini ya activa, sin
/// esto la UI pintaria la ventana grande mientras el SO muestra 450x250.
#[tauri::command]
pub fn get_mini_mode(state: Stt<'_>) -> Result<MiniModeStatus, String> {
  let activo = state
    .mini()
    .lock()
    .map_err(|err| format!("estado mini bloqueado: {err}"))?
    .activo;
  Ok(MiniModeStatus { active: activo })
}

/// Geometria actual de la ventana, en pixeles fisicos.
///
/// Se lee antes de redimensionar: es el unico momento en que sigue valiendo la ventana
/// que el usuario tenia. En modo mini devuelve el tamano de la propia mini, y por eso
/// `MiniEstado::entrar` es idempotente: el segundo intento no vuelve a guardar nada.
fn geometria_actual(window: &WebviewWindow) -> Result<Geometria, String> {
  let pos = window
    .outer_position()
    .map_err(|err| format!("no se pudo leer la posicion de la ventana: {err}"))?;
  let tam = window
    .outer_size()
    .map_err(|err| format!("no se pudo leer el tamano de la ventana: {err}"))?;
  Ok(Geometria::new(pos.x, pos.y, tam.width, tam.height))
}

/// Pantalla que contiene la ventana, o la principal si no se puede saber.
///
/// Se usa la de la ventana y no la principal a proposito: con dos monitores, poner la
/// mini pegada a la esquina de la pantalla equivocada la deja fuera de vista.
fn pantalla_actual(window: &WebviewWindow) -> Pantalla {
  let monitors = window.available_monitors().unwrap_or_default();
  let actual = window.current_monitor().ok().flatten();
  // `Monitor` no es `Copy`, asi que se mueve en vez de desreferenciarse. Sin monitor
  // actual (la ventana esta minimizada) se cae al primero disponible.
  let elegido = match (actual, monitors.into_iter().next()) {
    (Some(m), _) => Some(m),
    (None, Some(primero)) => Some(primero),
    (None, None) => None,
  };
  match elegido {
    // `position()` y `size()` no devuelven `Option`, pero un monitor virtual puede
    // reportar 0x0. Se cae entonces a un tamano razonable: una mini pegada a la nada es
    // peor que una mini en la pantalla que toque.
    Some(m) => {
      let p = m.position();
      let s = m.size();
      if s.width == 0 || s.height == 0 {
        Pantalla::new(0, 0, 1920, 1080)
      } else {
        Pantalla::new(p.x, p.y, s.width, s.height)
      }
    }
    None => Pantalla::new(0, 0, 1920, 1080),
  }
}

/// Puente temporal entre el estado de Tauri y una fuente del crate de ASR.
///
/// No forma parte de la API de la app: existe para que los tests de integracion
/// puedan montar el mismo camino que usa el worker.
#[allow(dead_code)]
pub fn audio_source(state: &SttState) -> Box<dyn lyricstream_asr::SampleSource> {
  Box::new(AudioEngineSource::new(Arc::clone(state.audio())))
}

/// Doble de prueba del motor, para tests de integracion.
#[allow(dead_code)]
pub fn stub_engine() -> Box<dyn SttEngine> {
  Box::new(StubEngine::new())
}
