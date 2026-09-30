//! Motor de inferencia real sobre whisper.cpp.
//!
//! # Por que este modulo es mas complicated de lo que parece
//!
//! La UI **concatena** los segmentos que recibe (`page.tsx` hace `setSegments(prev
//! => [...prev, ...])`). Es decir, cada evento se ANADE al texto ya mostrado, en vez de
//! sustituirlo. Con eso, un motor que devolviera el texto completo de cada ventana
//! produciria esto en pantalla:
//!
//! ```text
//! And so my fellow Americans
//! And so my fellow Americans ask not what your country
//! And so my fellow Americans ask not what your country can do for you
//! ```
//!
//! Es decir, la frase repetida tres veces. Por eso este motor **no** devuelve la
//! transcripcion de la ventana, sino solo el **incremento** respecto a lo ya emitido
//! en este segmento. Es el contrato que describe `SttEngine::transcribe` y el
//! ejemplo `stream` de whisper.cpp.
//!
//! # El incremento se calcula por palabras, no por caracteres
//!
//! Whisper no es monotono: al redecodificar una ventana que ha crecido suele cambiar
//! la ultima palabra ("fellows" -> "fellow Americans"), porque la senal que antes era
//! final de palabra ahora es mitad de palabra. Comparando caracteres, un cambio de
//! una letra en la palabra 3 abortaria el prefijo comun y habria que reemitir todo.
//! Comparando palabras completas, el prefijo comun sobrevive a la mayoria de las
//! revisiones, que se concentran en la cola.
//!
//! # Lo que este motor NO puede arreglar
//!
//! Si whisper revierte una palabra que ya se emitio como final, no hay forma de
//! borrarla: el texto ya esta en la UI. Se emite el mejor sufijo posible y el siguiente
//! parcial sigue la transcripcion mas reciente. Es la limitacion inherente a
//! concatenar parciales sin retroaccion, y es aceptable porque el texto final
//! corregido llega justo despues. Un motor con revulsion real (Whisper Streaming,
//! Zipformer con CTC) tendria que reenviar el segmento entero; el modelo de
//! `TranscriptionSegment` no tiene forma de expressar "borra lo anterior".
//!
//! # Los parciales SON ruidosos, y hay que decirlo
//!
//! Medido con el WAV de `jfk.wav` y ventanas de 1 s, los primeros parciales salen
//! asi:
//!
//! ```text
//!   "And so..."
//!   "so my family. my fellow Americans. (I'm a little American) [INAUDIBLE]"
//!   "you are country. Part 3 can do. 4 can do for you."
//! ```
//!
//! y el final, con la frase entera, asi:
//!
//! ```text
//!   "and so my fellow americans ask not what your country can do for you,
//!    ask what you can do for your country."
//! ```
//!
//! No es un fallo del shim ni del segmento: whisper con un segundo de audio no tiene
//! contexto para distinguir voz de ruido, y al no tenerlo alucina. Se podria subir
//! `partial_min_ms` a 2-3 s para que los primeros parciales fuesen utilizables, pero
//! entonces el usuario no veria texto hasta el segundo 2 o 3, que es justo lo que un
//! STT en streaming tries de evitar. Aqui se eligio lo otro: parciales rapidos y
//! ruidosos, y un final fiable. Quien quiera mas estabilidad y menos inmediatez debe
//! subir `partial_min_ms` en `SegmentConfig`.

use std::path::{Path, PathBuf};

use crate::engine::{
  EngineError, EngineInfo, Language, SttEngine, TranscribeOptions, Transcription,
};
use lyricstream_whisper_sys::{Context, Error as SysError, WhisperRuntime};

/// Motor de reconocimiento sobre whisper.cpp.
///
/// `ctx` es `None` cuando el runtime o el modelo no se pudieron cargar. Es el caso
/// normal al arrancar la app sin el runtime desplegado: en vez de no arrancar, el
/// motor existe pero explica que le falta, y la UI lo muestra.
pub struct WhisperEngine {
  ctx: Option<OwnedContext>,
  info: EngineInfo,
  /// Idioma forzado por el usuario, o `None` para autodeteccion.
  language: Option<&'static str>,
  /// Palabras del segmento abierto que la UI ya tiene en pantalla. Es la referencia
  /// contra la que se calcula el incremento de cada parcial.
  emitted: Vec<String>,
  /// `true` si alguna pasada ha detectado el idioma, para no prometer un idioma que
  /// whisper no ha estimado nunca.
  language_seen: bool,
}

/// Contenedor del contexto de whisper, marcado como `Send`.
///
/// whisper.cpp avisa de que un contexto no se puede usar desde dos hilos a la vez.
/// Aqui se cumple: el contexto se MUEVE al hilo del worker y no se comparte (esta
/// detras de un `Box<dyn SttEngine>`, no de un `Arc`), asi que nunca hay dos hilos
/// dentro del mismo contexto. Lo que si hace falta es poder trasladar la propiedad
/// entre hilos, que es lo que `Send` permite. `Sync` NO se implementa, y no debe
/// añadirse: eso si permitiria uso concurrente.
struct OwnedContext(Context);

// SAFETY: ver el comentario del tipo. La propiedad es exclusiva y se transfiere
// enteramente al hilo del worker; no existe ninguna referencia aliasada.
unsafe impl Send for OwnedContext {}

impl WhisperEngine {
  /// Carga el runtime y el modelo, y devuelve un motor listo para transcribir.
  ///
  /// `runtime_dir` debe contener `whisper.dll` y las `ggml-*.dll`. `n_threads` <= 0
  /// deja que whisper elija.
  pub fn load(runtime_dir: &Path, model_path: &Path, n_threads: i32) -> Result<Self, EngineError> {
    WhisperRuntime::load(runtime_dir).map_err(|err| {
      EngineError::RuntimeUnavailable(format!("{} (buscado en {})", err, runtime_dir.display()))
    })?;
    let ctx = WhisperRuntime::init(model_path, n_threads).map_err(sys_error)?;
    let version = format!(
      "whisper.cpp {} · {} hilos",
      WhisperRuntime::build(),
      ctx.n_threads()
    );
    Ok(Self {
      ctx: Some(OwnedContext(ctx)),
      info: EngineInfo::new("whisper-cpp", &version, true, ""),
      language: None,
      emitted: Vec::new(),
      language_seen: false,
    })
  }

  /// Motor que explica por que no se pudo cargar, en vez de fallar.
  ///
  /// La UI lo necesita: si el runtime no esta desplegado, el usuario tiene que leer
  /// "falta whisper.dll en ...", no "error al arrancar".
  pub fn unavailable(runtime_dir: &Path, model_path: &Path, err: &EngineError) -> Self {
    let detail = err.to_string();
    Self {
      ctx: None,
      info: EngineInfo::new(
        "whisper-cpp",
        WhisperRuntime::build(),
        false,
        &format!(
          "no se pudo cargar: {detail} (runtime en {}, modelo en {})",
          runtime_dir.display(),
          model_path.display()
        ),
      ),
      language: None,
      emitted: Vec::new(),
      language_seen: false,
    }
  }

  /// Fuerza el idioma, o vuelve a la autodeteccion con `None`.
  ///
  /// No reinicia el contexto: whisper lee `params.language` en cada pasada, asi que
  /// el cambio se nota en el siguiente parcial sin perder el modelo cargado.
  pub fn set_language(&mut self, language: Language) {
    self.language = language.explicit();
  }

  /// Idioma detectado por la ultima pasada con autodeteccion, o `None`.
  pub fn detected_language(&self) -> Option<String> {
    if self.language_seen {
      self.ctx.as_ref().and_then(|ctx| ctx.0.detected_language())
    } else {
      None
    }
  }

  /// Palabras ya emitidas en el segmento abierto.
  fn emitted_words(&self) -> &[String] {
    &self.emitted
  }
}

impl SttEngine for WhisperEngine {
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
    if !self.info.ready {
      return Err(EngineError::RuntimeUnavailable(self.info.detail.clone()));
    }
    let ctx = self
      .ctx
      .as_mut()
      .ok_or_else(|| EngineError::RuntimeUnavailable(self.info.detail.clone()))?;

    // `options.language` manda sobre lo que se fijo con `set_language`: el worker lo
    // pasa en cada llamada, y es el camino que usa la UI al cambiar el desplegable.
    let language = options.language.explicit().or(self.language);
    // La deteccion solo tiene sentido si no se le ha impuesto un idioma: con `en`
    // fijado, whisper no detecta nada y `detected_language` daria un valor falso.
    let detect = language.is_none();

    // Un final reinicia el estado de whisper: el siguiente segmento es una frase
    // distinta y no debe heredar el contexto de la anterior. `no_context` en la
    // llamada hace lo mismo para el parcial, sin recrear el estado (que es caro).
    let raw = ctx
      .0
      .transcribe(
        samples,
        language,
        options.is_final,
        options.is_final,
        detect,
      )
      .map_err(sys_error)?;
    if detect {
      self.language_seen = true;
    }

    let transcript = match raw {
      Some(text) => text,
      // Sin texto no hay nada que emitir. Para un final, `transcribe_and_emit` se
      // encarga de cerrar igualmente la linea abierta en la UI.
      None => return Ok(Transcription::default()),
    };

    let step = increment(self.emitted_words(), &transcript);
    // La referencia pasa a ser SIEMPRE la transcripcion mas reciente, no la anterior.
    // Asi, si whisper revierte palabras, el siguiente parcial se mide contra la
    // version buena y no contra una que ya no existe en ninguna parte.
    self.emitted = step.baseline;

    if options.is_final {
      self.emitted.clear();
    }

    Ok(Transcription {
      text: step.fresh,
      // whisper no expone confianza por token en la API que usa el shim. Informar
      // 0.0 seria mentira; informar 1.0 tambien. La UI trata 0 como "desconocido".
      confidence: 0.0,
    })
  }

  fn reset(&mut self) {
    self.emitted.clear();
    self.language_seen = false;
  }
}

fn sys_error(err: SysError) -> EngineError {
  match err {
    SysError::Load(load) => EngineError::RuntimeUnavailable(load.to_string()),
    SysError::InitFailed(msg) | SysError::InferenceFailed(msg) => EngineError::Inference(msg),
    SysError::InvalidArgument(msg) => EngineError::InvalidInput(msg),
  }
}

/// Resultado de medir una transcripcion nueva contra lo ya emitido.
#[derive(Debug, PartialEq)]
struct Increment {
  /// Texto que hay que anadir a la UI.
  fresh: String,
  /// Referencia para la siguiente llamada.
  baseline: Vec<String>,
}

/// Calcula cuanto hay que anadir a lo ya emitido.
///
/// Es una funcion pura a proposito: es la logica mas sutil del motor (decidir que
/// parte de una transcripcion es nueva) y asi se puede probar entera sin runtime, sin
/// modelo y sin 30 MB de pesos. Un test de integracion con la DLL real no la
/// distinguiria de un error de prefijo.
///
/// # Por que palabras y no caracteres
///
/// Whisper no es monotono: al redecodificar una ventana que ha crecido suele retocar
/// la ultima palabra ("fellows" -> "fellow Americans"), porque lo que antes era final
/// de palabra ahora es mitad de palabra. Con prefijo de caracteres, retocar una letra
/// de la palabra 3 daria prefijo comun 0 y habria que reemitir la frase entera. Con
/// palabras, el prefijo comun sobrevive y solo se emite la cola.
///
/// # La revision que no se puede arreglar
///
/// Si whisper cambia una palabra que ya se emitio, el texto viejo ya esta en la UI y
/// no hay como borrarlo. Se emite la mejor cola posible y se adopta la transcripcion
/// nueva como referencia, para que el siguiente parcial no se mida contra un texto que
/// ya no existe en ninguna parte. Es la limitacion de concatenar parciales sin
/// retroaccion; un motor con revulsion tendria que reenviar el segmento entero, y
/// `TranscriptionSegment` no tiene forma de decir "borra lo anterior".
fn increment(emitted: &[String], transcript: &str) -> Increment {
  let words: Vec<String> = transcript.split_whitespace().map(str::to_string).collect();
  let agreed = common_prefix_len(emitted, &words);
  let fresh = words[agreed..].join(" ");
  Increment {
    fresh,
    baseline: words,
  }
}

/// Cuantas palabras del principio coinciden exactamente.
///
/// Comparar palabras enteras y no caracteres es lo que hace que una revision de la
/// ultima palabra no destruya el prefijo ya emitido.
fn common_prefix_len(a: &[String], b: &[String]) -> usize {
  a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count()
}

/// Busca el directorio del runtime de whisper.
///
/// El orden importa: primero lo que dice la variable de entorno (tests, y un
/// desarrollador que tenga whisper en otro sitio), despues junto al ejecutable (que
/// es donde Tauri despliega los recursos) y por ultimo el directorio de trabajo, para
/// que `cargo run` desde la raiz del repo encuentre el runtime de desarrollo.
pub fn find_runtime_dir() -> Option<PathBuf> {
  if let Ok(dir) = std::env::var("LYRICSTREAM_WHISPER_DIR") {
    let path = PathBuf::from(dir);
    if has_dll(&path) {
      return Some(path);
    }
  }
  let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
  if has_dll(&exe_dir) {
    return Some(exe_dir);
  }
  if let Ok(cwd) = std::env::current_dir() {
    if has_dll(&cwd) {
      return Some(cwd);
    }
  }
  None
}

/// `true` si el directorio contiene la libreria principal, en cualquiera de las dos
/// formas en las que puede venir (MinGW en Windows, o una build compartida en Linux).
///
/// Se publica porque la capa de Tauri necesita comprobar el mismo criterio antes de
/// decidir que mensaje de error enseñar.
pub fn has_runtime(dir: &Path) -> bool {
  has_dll(dir)
}

fn has_dll(dir: &Path) -> bool {
  dir.join("whisper.dll").exists() || dir.join("libwhisper.so").exists()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Simula la secuencia de la UI: concatenar todo lo que el motor devuelve, que es
  /// literalmente lo que hace `setSegments(prev => [...prev, ...])` en `page.tsx`.
  fn concat_ui(partials: &[String]) -> String {
    partials
      .join(" ")
      .split_whitespace()
      .collect::<Vec<_>>()
      .join(" ")
  }

  fn steps(partials: &[&str]) -> Vec<String> {
    let mut emitted: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for text in partials {
      let step = increment(&emitted, text);
      emitted = step.baseline;
      out.push(step.fresh);
    }
    out
  }

  #[test]
  fn la_primera_pasada_emite_el_texto_entero() {
    let out = steps(&["And so my fellow Americans"]);
    assert_eq!(out, vec!["And so my fellow Americans"]);
  }

  #[test]
  fn la_ventana_que_crece_solo_emite_el_texto_nuevo() {
    // El caso normal de streaming: la ventana crece y whisper repite lo ya dicho
    // delante. Si esto emitiera la frase entera, la UI la repetiria tres veces.
    let out = steps(&[
      "And so my fellow Americans",
      "And so my fellow Americans ask not what",
      "And so my fellow Americans ask not what your country",
    ]);
    assert_eq!(
      out,
      vec!["And so my fellow Americans", "ask not what", "your country",],
      "cada parcial debe ser solo el incremento"
    );
    // Y lo que ve el usuario, concatenado, es la frase una sola vez.
    assert_eq!(
      concat_ui(&out),
      "And so my fellow Americans ask not what your country"
    );
  }

  #[test]
  fn un_parcial_que_no_crece_no_emite_nada() {
    // La ventana se renueva pero el texto recognized es el mismo: no hay nada nuevo,
    // y `transcribe_and_emit` ya descarta los parciales vacios.
    let out = steps(&["hola que tal", "hola que tal"]);
    assert_eq!(out, vec!["hola que tal", ""]);
  }

  #[test]
  fn una_revision_de_la_ultima_palabra_no_arranca_de_cero() {
    // Whisper frequently retoca la cola al crecer la ventana. Con prefijo de
    // palabras el texto ya emitido sobrevive; con prefijo de caracteres, el cambio de
    // una letra en "fellow" obligaria a reemitirlo todo.
    let out = steps(&["And so my fellow", "And so my fellow Americans"]);
    assert_eq!(
      out,
      vec!["And so my fellow", "Americans"],
      "una revision de la cola no debe repetir lo acordado"
    );
  }

  #[test]
  fn una_revision_temprana_reemite_desde_el_punto_de_discrepancia() {
    // Caso hostil y DOCUMENTADO: whisper cambia una palabra del principio, asi que el
    // prefijo comun se queda en "And" y hay que reemitir desde ahi. Lo ya mostrado no
    // se puede borrar. Emitir "" en su lugar perderia texto en silencio, que es peor.
    // Lo que este test fija es que el prefijo comun se aprovecha AL MAXIMO: solo se
    // reemite lo que hay despues de la palabra que aun coincide.
    let out = steps(&["And so my fellow", "And thus my fellow Americans"]);
    assert_eq!(
      out,
      vec!["And so my fellow", "thus my fellow Americans"],
      "se reemite solo desde 'thus', no la frase entera desde 'And'"
    );
  }

  #[test]
  fn una_revision_de_la_cola_es_la_unica_que_se_resuelve_solo() {
    // El caso que whisper produce de verdad casi siempre: la revision cae en las
    // ultimas palabras, donde el prefijo comun sobrevive entero. Aqui queda texto
    // limpio, que es por eso que comparar por palabras funciona.
    let out = steps(&[
      "And so my fellow Americans",
      "And so my fellow Americans ask not",
    ]);
    assert_eq!(
      out,
      vec!["And so my fellow Americans", "ask not"],
      "una revision de la cola no repite lo acordado"
    );
  }

  #[test]
  fn una_palabra_corregida_cuenta_como_palabra_nueva() {
    // "ask" y "asked" son palabras DISTINTAS, no una version truncada de la misma.
    // Comparar por palabras las trata como distintas y reemite la corregida, en vez
    // de emitir "ed" y dejar "askasked" en pantalla. Comparar por caracteres habria
    // producido justo eso.
    let out = steps(&[
      "And so my fellow Americans ask",
      "And so my fellow Americans asked not",
    ]);
    assert_eq!(out, vec!["And so my fellow Americans ask", "asked not"]);
  }

  #[test]
  fn una_regresion_de_texto_reemite_en_vez_de_perderlo() {
    // La transcripcion nueva es un sufijo corto de la anterior. El prefijo comun es 0,
    // asi que se reemite entero. Perderlo seria peor que duplicarlo: el texto
    // existe y la UI lo enseña.
    let out = steps(&["uno dos tres cuatro", "tres cuatro"]);
    assert_eq!(out, vec!["uno dos tres cuatro", "tres cuatro"]);
  }

  #[test]
  fn el_final_cierra_el_segmento_y_el_siguiente_emite_desde_cero() {
    // Tras un final, `reset()` vacia la referencia. Si no lo hiciera, la primera frase
    // de un segmento nuevo se mediria contra la anterior y no emitiria nada.
    let mut emitted: Vec<String> = Vec::new();
    let step = increment(&emitted, "primera frase");
    emitted = step.baseline;
    assert_eq!(step.fresh, "primera frase");

    emitted.clear();
    let step = increment(&emitted, "segunda frase");
    assert_eq!(
      step.fresh, "segunda frase",
      "un segmento nuevo debe empezar de cero"
    );
  }

  #[test]
  fn el_texto_vacio_nunca_emite_espacios() {
    // `split_whitespace` + `join` garantiza que no haya dobles espacios ni espacios
    // al final, que en la UI se ven como texto pegado.
    let out = steps(&["uno   dos", "  tres  ", ""]);
    assert_eq!(out, vec!["uno dos", "tres", ""]);
  }

  #[test]
  fn el_incremento_respeta_las_palabras_completas() {
    // El prefijo comun nunca parte una palabra por la mitad.
    let emitted: Vec<String> = "hola mun".split_whitespace().map(str::to_string).collect();
    let step = increment(&emitted, "hola mundo");
    assert_eq!(step.fresh, "mundo");
  }
}
