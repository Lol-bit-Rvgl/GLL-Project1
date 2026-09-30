//! Puente de bajo nivel a whisper.cpp.
//!
//! Este crate NO compila whisper.cpp. Compila un unico fichero,
//! `csrc/shim.c`, que se apoya en `vendor/whisper/*.h` (cabeceras del commit
//! `b5130`) y expone una interfaz C minima y estable. Ver el comentario de
//! `shim.c` para el por que de cada decision.
//!
//! # Por que un shim y no enlaces directos
//!
//! `struct whisper_full_params` tiene ~60 campos, estructuras anidadas y punteros a
//! funcion. Reproducirla en Rust con `#[repr(C)]` es una fuente clasica de fallos
//! silenciosos: un campo descolocado no da error de compilacion, da texto basura o
//! un crash en tiempo de ejecucion. Aqui el layout lo pone el compilador C, y Rust
//! solo ve funciones planas cuya firma no depende de como whisper organice sus
//! estructuras internas.
//!
//! # Por que carga dinamica
//!
//! El zip oficial de whisper.cpp para Windows no trae `.lib`, solo `.dll`, asi que
//! no hay nada contra lo que enlazar. Ademas la app debe arrancar aunque el runtime
//! no este desplegado y explicar que falta, en vez de negarse a arrancar. De ahi
//! [`WhisperRuntime::load`], que busca `whisper.dll` en un directorio.
//!
//! # Despliegue
//!
//! El directorio de runtime debe contener, como minimo:
//! `whisper.dll`, `ggml.dll` y el `ggml-cpu-*.dll` que corresponda a la CPU. Las
//! DLL oficiales son MSVC; el enlace es solo de interfaz C, asi que un binario
//! MinGW las carga sin problema (necesita `MSVCP140.dll` y `VCRUNTIME140.dll` del
//! sistema, que vienen con Windows o con el redistribuible de Visual C++).

use std::ffi::{c_char, c_int, CStr, CString};
use std::ptr;

/// Fallos del runtime de whisper, con el mensaje del shim cuando lo hay.
///
/// El texto viene del lado de C (`lrs_whisper_last_error`), que es quien sabe por
/// que fallo una carga de modelo: "no se encontro whisper.dll" o "falta el simbolo
/// whisper_full_with_state" no se pueden deducir en Rust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
  /// El runtime no se pudo cargar.
  Load(LoadError),
  /// Fallo al crear el contexto o el estado de decodificacion.
  InitFailed(String),
  /// Fallo durante la inferencia.
  InferenceFailed(String),
  /// Argumento invalido (ruta con NUL embebido, numero de muestras absurdo).
  InvalidArgument(String),
}

impl std::fmt::Display for Error {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Error::Load(err) => write!(f, "no se pudo cargar el runtime de whisper: {err}"),
      Error::InitFailed(msg) => write!(f, "no se pudo inicializar whisper: {msg}"),
      Error::InferenceFailed(msg) => write!(f, "fallo la inferencia: {msg}"),
      Error::InvalidArgument(msg) => write!(f, "argumento invalido: {msg}"),
    }
  }
}

impl std::error::Error for Error {}

impl From<LoadError> for Error {
  fn from(err: LoadError) -> Self {
    Error::Load(err)
  }
}

/// Contexto de whisper. Opaco desde fuera: lo manage whisper.cpp.
#[repr(C)]
pub struct WhisperContext {
  _private: [u8; 0],
}

/// Estado de decodificacion reutilizable entre ventanas.
#[repr(C)]
pub struct WhisperState {
  _private: [u8; 0],
}

/// Codigos de error de [`WhisperRuntime::load`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadError {
  /// La ruta venia vacia.
  NoDir,
  /// No se encontro la DLL.
  DllMissing,
  /// La DLL no exporta algun simbolo que el shim necesita.
  MissingSymbol,
  /// La ruta no se pudo convertir o no cabe en `MAX_PATH`.
  BadPath,
}

impl std::fmt::Display for LoadError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let text = match self {
      LoadError::NoDir | LoadError::BadPath => "ruta del runtime invalida",
      LoadError::DllMissing => "no se encontro whisper.dll",
      LoadError::MissingSymbol => "la libreria no exporta los simbolos de whisper",
    };
    f.write_str(text)
  }
}

impl std::error::Error for LoadError {}

extern "C" {
  fn lrs_whisper_load(dir: *const c_char) -> c_int;
  fn lrs_whisper_is_loaded() -> bool;
  fn lrs_whisper_build() -> *const c_char;

  fn lrs_whisper_init(model_path: *const c_char, n_threads: c_int) -> *mut WhisperContext;
  fn lrs_whisper_free(ctx: *mut WhisperContext);
  fn lrs_whisper_init_state(ctx: *mut WhisperContext) -> *mut WhisperState;
  fn lrs_whisper_free_state(state: *mut WhisperState);
  fn lrs_whisper_n_threads() -> c_int;

  fn lrs_whisper_transcribe(
    ctx: *mut WhisperContext,
    state: *mut WhisperState,
    samples: *const f32,
    n_samples: c_int,
    language: *const c_char,
    single_segment: bool,
    no_context: bool,
    detect_language: bool,
  ) -> *mut c_char;

  fn lrs_whisper_n_segments(state: *mut WhisperState) -> c_int;
  fn lrs_whisper_segment_t0(state: *mut WhisperState, i: c_int) -> i64;
  fn lrs_whisper_segment_t1(state: *mut WhisperState, i: c_int) -> i64;

  fn lrs_whisper_detected_language_str(ctx: *mut WhisperContext) -> *const c_char;
  fn lrs_whisper_lang_id(code: *const c_char) -> c_int;
  fn lrs_whisper_is_multilingual(ctx: *mut WhisperContext) -> bool;
  fn lrs_whisper_last_error() -> *const c_char;
  fn lrs_whisper_free_string(s: *mut c_char);
}

/// Toma ownership de un `char*` del shim y lo devuelve como `String`.
///
/// Si el puntero es NULL devuelve `None`: el shim usa NULL para "fallo" y una
/// cadena vacia para "no hablo". La distincion importa y se conserva.
unsafe fn take_c_string(ptr: *mut c_char) -> Option<String> {
  if ptr.is_null() {
    return None;
  }
  let text = CStr::from_ptr(ptr).to_string_lossy().into_owned();
  lrs_whisper_free_string(ptr);
  Some(text)
}

/// Toma un `const char*` del shim sin quitarle la propiedad.
unsafe fn borrow_c_string<'a>(ptr: *const c_char) -> &'a str {
  if ptr.is_null() {
    return "";
  }
  CStr::from_ptr(ptr).to_str().unwrap_or("")
}

/// Runtime de whisper cargado en memoria.
///
/// Los punteros al contexto y al estado los envuelve [`Context`]; este tipo solo
/// gestiona la libreria, que es un recurso global del proceso.
pub struct WhisperRuntime {
  _private: (),
}

impl WhisperRuntime {
  /// Carga `whisper.dll` desde el directorio `dir`.
  ///
  /// Es idempotente en el lado de C: si ya hay una libreria cargada, la segunda
  /// llamada es un no-op. Devolver `Err(DllMissing)` con el shim ya cargado
  /// seria confuso, de ahi la comprobacion previa.
  pub fn load(dir: &std::path::Path) -> Result<Self, LoadError> {
    if unsafe { lrs_whisper_is_loaded() } {
      return Ok(Self { _private: () });
    }
    let c_dir = CString::new(dir.to_string_lossy().as_bytes()).map_err(|_| LoadError::BadPath)?;
    let rc = unsafe { lrs_whisper_load(c_dir.as_ptr()) };
    let result = match rc {
      0 => Ok(Self { _private: () }),
      -2 => Err(LoadError::NoDir),
      -3 => Err(LoadError::DllMissing),
      -4 => Err(LoadError::MissingSymbol),
      _ => Err(LoadError::DllMissing),
    };
    if result.is_err() {
      // El mensaje concreto lo sabe el shim; se adjunta al log para no perderlo.
      log::debug!("carga del runtime fallida (codigo {rc}): {}", unsafe {
        borrow_c_string(lrs_whisper_last_error())
      });
    }
    result
  }

  /// `true` si hay una libreria cargada.
  pub fn is_loaded() -> bool {
    unsafe { lrs_whisper_is_loaded() }
  }

  /// Commit de whisper.cpp con el que se compilo el shim.
  pub fn build() -> &'static str {
    unsafe { borrow_c_string(lrs_whisper_build()) }
  }

  /// Ultimo error registrado por el shim, o cadena vacia.
  pub fn last_error() -> String {
    unsafe { borrow_c_string(lrs_whisper_last_error()).to_string() }
  }

  /// Traduce un codigo ISO-639-1 al id numerico de whisper, o -1 si es "auto".
  pub fn lang_id(code: &str) -> i32 {
    let Ok(c_code) = CString::new(code) else {
      return -1;
    };
    unsafe { lrs_whisper_lang_id(c_code.as_ptr()) }
  }

  /// Carga un modelo y devuelve su contexto, listo para transcribir.
  ///
  /// `n_threads <= 0` deja la eleccion a whisper. GPU desactivada en el shim.
  pub fn init(model_path: &std::path::Path, n_threads: i32) -> Result<Context, Error> {
    let path = CString::new(model_path.to_string_lossy().as_bytes())
      .map_err(|_| Error::InvalidArgument(model_path.display().to_string()))?;
    let ctx = unsafe { lrs_whisper_init(path.as_ptr(), n_threads) };
    if ctx.is_null() {
      return Err(Error::InitFailed(WhisperRuntime::last_error()));
    }
    // El estado es lo que hace viable el streaming: se crea aqui para que un
    // fallo temprano aparezca al arrancar y no en mitad de una frase.
    let state = unsafe { lrs_whisper_init_state(ctx) };
    if state.is_null() {
      unsafe { lrs_whisper_free(ctx) };
      return Err(Error::InitFailed(WhisperRuntime::last_error()));
    }
    Ok(Context {
      ctx,
      state,
      n_threads: unsafe { lrs_whisper_n_threads() },
      multilingual: unsafe { lrs_whisper_is_multilingual(ctx) },
    })
  }
}

/// Modelo cargado: contexto + estado de decodificacion.
///
/// No es `Sync` a proposito: whisper.cpp avisa de que un mismo contexto no se
/// puede usar desde varios hilos a la vez. El worker de STT ya es de un solo hilo.
pub struct Context {
  ctx: *mut WhisperContext,
  state: *mut WhisperState,
  n_threads: i32,
  multilingual: bool,
}

impl Context {
  /// Numero de hilos con los que se inicializo.
  pub fn n_threads(&self) -> i32 {
    self.n_threads
  }

  /// `true` si el modelo transcribe mas de un idioma.
  pub fn is_multilingual(&self) -> bool {
    self.multilingual
  }

  /// Transcribe muestras a 16 kHz mono en `[-1, 1]`.
  ///
  /// `language` es `"es"`, `"en"`, `"auto"` o `None` (igual que `"auto"`).
  /// Devuelve `Ok(None)` si whisper no produjo texto, que no es un error: un
  /// silencio produce una cadena vacia. `Err` es para fallos de la inferencia.
  pub fn transcribe(
    &mut self,
    samples: &[f32],
    language: Option<&str>,
    single_segment: bool,
    no_context: bool,
    detect_language: bool,
  ) -> Result<Option<String>, Error> {
    if samples.is_empty() {
      return Ok(None);
    }
    let c_lang = match language.filter(|l| *l != "auto") {
      Some(code) => Some(CString::new(code).map_err(|_| Error::InvalidArgument(code.to_string()))?),
      None => None,
    };
    let c_lang_ptr = c_lang.as_ref().map_or(ptr::null(), |c| c.as_ptr());

    let raw = unsafe {
      lrs_whisper_transcribe(
        self.ctx,
        self.state,
        samples.as_ptr(),
        samples.len() as c_int,
        c_lang_ptr,
        single_segment,
        no_context,
        detect_language,
      )
    };
    match unsafe { take_c_string(raw) } {
      Some(text) if text.trim().is_empty() => Ok(None),
      Some(text) => Ok(Some(text)),
      None => Err(Error::InferenceFailed(WhisperRuntime::last_error())),
    }
  }

  /// Idioma detectado en la ultima pasada, o `None`.
  pub fn detected_language(&self) -> Option<String> {
    let raw = unsafe { borrow_c_string(lrs_whisper_detected_language_str(self.ctx)) };
    if raw.is_empty() {
      None
    } else {
      Some(raw.to_string())
    }
  }

  /// Numero de segmentos de la ultima transcripcion.
  pub fn n_segments(&self) -> i32 {
    unsafe { lrs_whisper_n_segments(self.state) }
  }

  /// Inicio del segmento `i` de la ultima transcripcion, en milisegundos.
  pub fn segment_t0_ms(&self, i: i32) -> i64 {
    // whisper devuelve centisegundos. El parentesis es necesario: sin el, el
    //`* 10` se lexica como desreferencia del entero.
    (unsafe { lrs_whisper_segment_t0(self.state, i) }) * 10
  }

  /// Fin del segmento `i` de la ultima transcripcion, en milisegundos.
  pub fn segment_t1_ms(&self, i: i32) -> i64 {
    (unsafe { lrs_whisper_segment_t1(self.state, i) }) * 10
  }
}

impl Drop for Context {
  /// Libera el estado antes que el contexto: el estado cuelga de el.
  fn drop(&mut self) {
    unsafe {
      lrs_whisper_free_state(self.state);
      lrs_whisper_free(self.ctx);
    }
  }
}

impl Drop for WhisperRuntime {
  fn drop(&mut self) {
    // A proposito, no se descarga la libreria: puede haber `Context` vivos y sus
    // punteros se quedarian colgando. Descargarla exigiria saber que no queda ninguno,
    // y el estado global `OnceLock` no lleva la cuenta.
    //
    // No hace falta: el proceso devuelve las DLL al kernel cuando termina, y durante
    // la vida de la app descargarlas solo ahorra unos MB que ya estan pagados. Un
    // `unload` publico seria una trampa de use-after-free, asi que no existe.
  }
}
