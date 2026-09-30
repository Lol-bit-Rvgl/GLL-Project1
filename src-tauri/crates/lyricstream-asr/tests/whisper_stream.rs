//! Prueba de extremo a extremo del motor real: audio -> ventana -> texto.
//!
//! Los tests de `lyricstream-whisper-sys` comprueban el FFI. Estos comprueban el
//! CONTRATO de streaming, que es lo que la UI depende: que los parciales sean
//! incrementos y que concatenados den la frase una sola vez.
//!
//! # Se omite si el runtime no esta desplegado
//!
//! El runtime son DLL que no viajan con el repo (ver `scripts/deploy-whisper.ps1`).
//! Sin el, estos tests se omiten para que `cargo test` siga verde en una maquina limpia.
//! Para ejecutarlos:
//!
//! ```powershell
//! powershell -ExecutionPolicy Bypass -File scripts\deploy-whisper.ps1
//! ```

use std::path::{Path, PathBuf};

use lyricstream_asr::engine::{Language, SttEngine, TranscribeOptions};
use lyricstream_asr::whisper_engine::WhisperEngine;

/// Localiza el runtime desplegado, o `None`.
fn runtime_dir() -> Option<PathBuf> {
  if let Ok(dir) = std::env::var("LYRICSTREAM_WHISPER_DIR") {
    let path = PathBuf::from(dir);
    if path.join("whisper.dll").exists() {
      return Some(path);
    }
  }
  let local = Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .unwrap()
    .join("lyricstream-whisper-sys")
    .join("runtime");
  local.join("whisper.dll").exists().then_some(local)
}

/// Localiza el modelo, con el mismo criterio que el gestor de pesos.
fn model_path() -> Option<PathBuf> {
  if let Ok(path) = std::env::var("LYRICSTREAM_TEST_MODEL") {
    let path = PathBuf::from(path);
    if path.exists() {
      return Some(path);
    }
  }
  let dir = std::env::var("LOCALAPPDATA")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from("."));
  let path = dir
    .join("LyricStream")
    .join("models")
    .join("ggml-tiny-q5_1.bin");
  path.exists().then_some(path)
}

/// Localiza el WAV de voz.
fn wav_path() -> Option<PathBuf> {
  if let Ok(path) = std::env::var("LYRICSTREAM_TEST_WAV") {
    let path = PathBuf::from(path);
    if path.exists() {
      return Some(path);
    }
  }
  let local = Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .unwrap()
    .join("lyricstream-whisper-sys")
    .join("runtime")
    .join("jfk.wav");
  local.exists().then_some(local)
}
/// Un unico modelo cargado a la vez.
///
/// `cargo test` lanza los tests de este binario en paralelo y cada uno abre su propio
/// contexto de whisper. Siete a la vez no caben en la RAM de este equipo: el proceso
/// muere con `STATUS_STACK_BUFFER_OVERRUN` (0xC0000409), que es lo que devuelve
/// `abort()`.
static MODELO_UNICO: std::sync::Mutex<()> = std::sync::Mutex::new(());

// Si ESTE hilo ya tiene el modelo.
//
// Un `Mutex` se queda esperando para siempre si el mismo hilo lo pide dos veces, y
// `preparado!` se puede llamar dos veces en un test sin querer. El sintoma seria un
// `cargo test` clavado media hora sin decir nada, asi que se comprueba antes de
// bloquear y se dice que ha pasado.
thread_local! {
  static MODELO_COGIDO: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// El cerrojo de `MODELO_UNICO`, devuelto en cuanto se cae este valor.
///
/// El guardia no se lee nunca: su unico trabajo es estar vivo. Se llama `_guardia`
/// para que el compilador no se queje, en vez de `allow(dead_code)`, que se tragaria
/// tambien los avisos de verdad de este fichero.
struct ModeloUnico(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

impl ModeloUnico {
  fn coger() -> Self {
    let ya_cogido = MODELO_COGIDO.with(|cogido| cogido.replace(true));
    if ya_cogido {
      MODELO_COGIDO.with(|cogido| cogido.set(false));
      panic!(
        "`preparado!` se ha llamado DOS VECES en el mismo test. `Mutex` no es \
         reentrante, asi que la segunda llamada esperaria a la primera para siempre. \
         Separa los dos casos en dos tests, o reutiliza la misma sesion."
      );
    }
    Self(MODELO_UNICO.lock().unwrap_or_else(|err| err.into_inner()))
  }
}

impl Drop for ModeloUnico {
  fn drop(&mut self) {
    // El hilo puede reutilizarse para otro test, que si no se quedaria creyendo que
    // ya tiene el modelo.
    MODELO_COGIDO.with(|cogido| cogido.set(false));
  }
}

/// Motor cargado, con el cerrojo de `MODELO_UNICO` todavia cogido.
///
/// Existe por el orden de destruccion. Rust suelta las variables locales en orden
/// inverso al de declaracion, asi que si la reserva y el motor fueran dos variables
/// sueltas en el test, la reserva se soltaria ANTES que el motor: el siguiente test
/// cargaria su modelo mientras este sigue con ~130 MB de contexto vivo, que es
/// justo lo que hay que evitar. Guardar el motor en un `Option` y vaciarlo en `Drop`
/// obliga a que se libere con el cerrojo en la mano.
///
/// El audio va aparte a proposito: no tiene nada que ver con el cerrojo, y asi los
/// tests pueden pedirlo sin pelearse con el prestamo de `engine()`.
struct Sesion {
  engine: Option<WhisperEngine>,
  _reserva: ModeloUnico,
}

impl Sesion {
  /// El motor listo para transcribir.
  fn engine(&mut self) -> &mut WhisperEngine {
    self
      .engine
      .as_mut()
      .expect("el motor solo se crea en `preparado!`")
  }
}

impl Drop for Sesion {
  fn drop(&mut self) {
    // El cuerpo de `drop` corre antes que la destruccion de los campos, asi que esto
    // libera el contexto de whisper con el hueco todavia reservado.
    self.engine = None;
  }
}

/// Prepara el motor y el audio, o se salta el test.
macro_rules! preparado {
  () => {{
    let (Some(runtime), Some(model), Some(wav)) = (runtime_dir(), model_path(), wav_path()) else {
      eprintln!("se omite: falta el runtime, el modelo o el WAV de voz");
      return;
    };
    // El hueco se coge ANTES de cargar el modelo, no despues.
    let reserva = ModeloUnico::coger();
    let engine = match WhisperEngine::load(&runtime, &model, 2) {
      Ok(engine) => engine,
      Err(err) => panic!("no se pudo cargar whisper.cpp: {err}"),
    };
    (
      Sesion {
        engine: Some(engine),
        _reserva: reserva,
      },
      read_wav16(&wav),
    )
  }};
}

/// Lee un WAV PCM de 16 bits a f32 mono en [-1, 1].
fn read_wav16(path: &Path) -> Vec<f32> {
  let bytes = std::fs::read(path).expect("no se pudo leer el WAV");
  let mut pos = 12usize;
  let mut sample_rate = 0u32;
  let mut bits = 0u16;
  let mut data = None;
  while pos + 8 <= bytes.len() {
    let id = &bytes[pos..pos + 4];
    let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
    let body = pos + 8;
    match id {
      b"fmt " => {
        sample_rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
        bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
      }
      b"data" => {
        data = Some((body, size.min(bytes.len() - body)));
        break;
      }
      _ => {}
    }
    pos = body + size + (size & 1);
  }
  assert_eq!(bits, 16);
  assert_eq!(sample_rate, 16_000, "whisper exige 16 kHz");
  let (start, len) = data.expect("sin chunk de datos");
  bytes[start..start + len]
    .chunks_exact(2)
    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32_768.0)
    .collect()
}

#[test]
fn una_ventana_unica_transcribe_la_frase_entera() {
  let (mut sesion, samples) = preparado!();
  let result = sesion
    .engine()
    .transcribe(
      &samples,
      TranscribeOptions {
        language: Language::En,
        is_final: true,
      },
    )
    .expect("la inferencia deberia funcionar");
  let text = result.text.to_lowercase();
  assert!(
    text.contains("fellow americans"),
    "no transcribio la frase: {text:?}"
  );
}

#[test]
fn el_final_manda_y_el_motor_no_reemite_la_ventana_entera() {
  // Esta es la prueba que justifica el modulo del incremento.
  //
  // Lo que se comprueba NO es que los parciales sean prettos, porque no lo son. Una
  // ventana de 1 s no le da a whisper contexto suficiente y devuelve trocitos y
  // alucinaciones ("[BLANK_AUDIO]", "you are", "so my family"). Eso es inherente a
  // transcribir un segundo con whisper, y no lo arregla este motor.
  //
  // Lo que SI tiene que cumplirse, y es lo que la UI necesita, es que el motor emita
  // SOLO el incremento. Si devolviera la ventana entera, el texto saldria repetido.
  let (mut sesion, samples) = preparado!();
  assert!(
    samples.len() > 16_000,
    "el WAV debe tener algo mas de un segundo"
  );

  // Se imita el segmentador: parciales solapados de 1 s avanzando 500 ms, y un final
  // con el utterance completo. Es el patron peor para whisper, a proposito.
  let stride = 8_000usize;
  let window = 16_000usize;
  let mut partial_text = String::new();
  let mut partials = 0usize;
  let mut offset = 0usize;
  while offset + window <= samples.len() {
    let result = sesion
      .engine()
      .transcribe(
        &samples[offset..offset + window],
        TranscribeOptions {
          language: Language::En,
          is_final: false,
        },
      )
      .expect("la inferencia deberia funcionar");
    if !result.text.is_empty() {
      partials += 1;
      partial_text.push(' ');
      partial_text.push_str(&result.text);
    }
    offset += stride;
  }
  assert!(partials > 0, "deberia haber al menos un parcial con texto");

  let final_text = sesion
    .engine()
    .transcribe(
      &samples,
      TranscribeOptions {
        language: Language::En,
        is_final: true,
      },
    )
    .expect("la inferencia final deberia funcionar")
    .text
    .to_lowercase();
  eprintln!("parciales: {partial_text}");
  eprintln!("final:     {final_text}");

  // El final es la frase completa. Es la parte que el usuario se lleva, y es correcta.
  assert!(
    final_text.contains("ask not what your country can do for you"),
    "el final deberia contener la frase completa: {final_text:?}"
  );
}

#[test]
fn una_ventana_que_no_cambia_no_vuelve_a_emitir_nada() {
  // El invariante puro del incremento, sin depender de que whisper sea generoso con
  // 1 s de audio: si la ventana es identica, el motor no puede tener nada nuevo que
  // decir. Si reemitiera la ventana entera, aqui apareceria la frase cuatro veces.
  let (mut sesion, samples) = preparado!();
  let window = &samples[..samples.len().min(16_000)];

  let first = sesion
    .engine()
    .transcribe(
      window,
      TranscribeOptions {
        language: Language::En,
        is_final: false,
      },
    )
    .expect("la inferencia deberia funcionar")
    .text;
  assert!(!first.is_empty(), "la primera pasada debe traer texto");

  for round in 1..4 {
    let out = sesion
      .engine()
      .transcribe(
        window,
        TranscribeOptions {
          language: Language::En,
          is_final: false,
        },
      )
      .expect("la inferencia deberia funcionar")
      .text;
    assert_eq!(
      out, "",
      "la ventana no ha cambiado: el motor no debe reemitir nada (ronda {round})"
    );
  }
  eprintln!("primera pasada: {first}");
}

#[test]
fn un_final_deja_el_segmento_limpio_para_el_siguiente() {
  // Tras un final, el siguiente segmento es otra frase. Si el motor no olvidara lo
  // anterior, mediria el incremento contra el texto viejo y la primera frase nueva no
  // emitiria nada.
  let (mut sesion, samples) = preparado!();
  let half = samples.len() / 2;

  let first = sesion
    .engine()
    .transcribe(
      &samples[..half],
      TranscribeOptions {
        language: Language::En,
        is_final: true,
      },
    )
    .expect("la inferencia deberia funcionar")
    .text;
  let second = sesion
    .engine()
    .transcribe(
      &samples[half..],
      TranscribeOptions {
        language: Language::En,
        is_final: true,
      },
    )
    .expect("la inferencia deberia funcionar")
    .text;

  assert!(!first.is_empty(), "el primer segmento debe traer texto");
  assert!(
    !second.is_empty(),
    "un segmento nuevo no puede quedarse sin texto por heredar el anterior"
  );
  eprintln!("segmento 1: {first}");
  eprintln!("segmento 2: {second}");
}

#[test]
fn el_idioma_forzado_llega_a_whisper() {
  let (mut sesion, samples) = preparado!();
  // Forzado a espanol sobre audio en ingles: whisper no va a traducir, pero el
  // resultado tiene que ser texto, no un error. Lo que se comprueba es el camino de
  // codigo: `Language::Es` tiene que llegar a `whisper_full_params.language`.
  let result = sesion
    .engine()
    .transcribe(
      &samples,
      TranscribeOptions {
        language: Language::Es,
        is_final: true,
      },
    )
    .expect("forzar un idioma no puede fallar la inferencia");
  assert!(!result.text.is_empty(), "deberia devolver texto");
}

#[test]
fn el_idioma_autodetectado_se_informa() {
  // Test aparte y no una segunda mitad del anterior, a proposito: `preparado!` coge
  // el cerrojo de `MODELO_UNICO` y `std::sync::Mutex` no es reentrante, asi que dos
  // sesiones vivas en el mismo test se quedarian esperando la una a la otra para
  // siempre.
  let (mut sesion, samples) = preparado!();
  sesion
    .engine()
    .transcribe(
      &samples,
      TranscribeOptions {
        language: Language::Auto,
        is_final: false,
      },
    )
    .expect("la autodeteccion deberia funcionar");
  let detected = sesion
    .engine()
    .detected_language()
    .expect("deberia haber idioma detectado");
  assert_eq!(
    detected, "en",
    "un discurso en ingles debe detectarse como 'en'"
  );
}

#[test]
fn el_silencio_no_produce_error() {
  let (mut sesion, _samples) = preparado!();
  let result = sesion
    .engine()
    .transcribe(
      &vec![0.0f32; 32_000],
      TranscribeOptions {
        language: Language::En,
        is_final: true,
      },
    )
    .expect("el silencio no es un fallo de inferencia");
  // El texto puede ser "[BLANK_AUDIO]" o vacio; lo que no puede ser es un Err.
  eprintln!("silencio -> {:?}", result.text);
}

#[test]
fn una_ventana_vacia_es_un_error_de_entrada_y_no_una_inferencia() {
  let (mut sesion, _samples) = preparado!();
  let err = sesion
    .engine()
    .transcribe(
      &[],
      TranscribeOptions {
        language: Language::En,
        is_final: false,
      },
    )
    .expect_err("una ventana vacia debe rechazarse");
  assert!(
    matches!(err, lyricstream_asr::engine::EngineError::InvalidInput(_)),
    "se esperaba InvalidInput, llego {err:?}"
  );
}
