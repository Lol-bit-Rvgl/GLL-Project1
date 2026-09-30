//! Integracion real contra whisper.cpp.
//!
//! Estos tests NO usan el doble de prueba: cargan `whisper.dll` de verdad, cargan
//! el modelo real y transcriben audio real. Son los unicos que detectan un desajuste
//! de ABI en el shim, una fuga en el lado C o un simbolo que cambio de nombre; un
//! test con `StubEngine` no detects nada de eso.
//!
//! # Se saltan si el runtime no esta desplegado
//!
//! El runtime son DLL binarias, no un crate: no viaja con `cargo test`. Si no estan,
//! estos tests se marcan como omitidos en vez de fallar, para que `cargo test` siga
//! siendo verde en una maquina limpia. En CI hay que desplegarlas antes.
//!
//! Como se despliegan:
//!
//! ```powershell
//! curl.exe -L -o whisper-bin-x64.zip https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip
//! Expand-Archive whisper-bin-x64.zip -DestinationPath runtime
//! ```
//!
//! Y las variables de entorno para localizarlas:
//!
//! - `LYRICSTREAM_WHISPER_DIR`: directorio con `whisper.dll` (+ `ggml*.dll`).
//! - `LYRICSTREAM_TEST_MODEL`: ruta al modelo GGML.
//! - `LYRICSTREAM_TEST_WAV`: ruta a un WAV de voz, o se baja `jfk.wav` del repo.

use std::path::{Path, PathBuf};

use lyricstream_whisper_sys::WhisperRuntime;

/// Localiza el directorio del runtime, o `None` si no esta desplegado.
///
/// Se mira primero la variable de entorno y luego una carpeta `runtime/` al lado del
/// manifiesto, que es donde el script de despliegue la deja.
fn whisper_dir() -> Option<PathBuf> {
  if let Ok(dir) = std::env::var("LYRICSTREAM_WHISPER_DIR") {
    let path = PathBuf::from(dir);
    if path.join("whisper.dll").exists() || path.join("libwhisper.so").exists() {
      return Some(path);
    }
  }
  let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime");
  if local.join("whisper.dll").exists() || local.join("libwhisper.so").exists() {
    return Some(local);
  }
  None
}

/// Localiza el modelo de test.
fn model_path() -> Option<PathBuf> {
  if let Ok(path) = std::env::var("LYRICSTREAM_TEST_MODEL") {
    let path = PathBuf::from(path);
    if path.exists() {
      return Some(path);
    }
  }
  // La ruta por defecto del gestor de pesos.
  let dir = std::env::var("LOCALAPPDATA")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from("."));
  let path = dir
    .join("LyricStream")
    .join("models")
    .join("ggml-tiny-q5_1.bin");
  path.exists().then_some(path)
}

/// Un unico modelo cargado a la vez.
///
/// `cargo test` lanza los tests de un binario en paralelo, y cada uno de estos carga
/// su propio contexto de whisper. Siete modelos a la vez no caben en la RAM de este
/// equipo: el proceso muere con `STATUS_STACK_BUFFER_OVERRUN` (0xC0000409), que es lo
/// que devuelve `abort()`. Serializar aqui deja un unico modelo en memoria y hace que
/// `cargo test` funcione sin `--test-threads=1`.
///
/// El cerrojo se envenena si un test entra en panic, y en ese caso el siguiente lo
/// recoge igual: el objetivo es serializar, no castigar al resto de la suite.
static MODELO_UNICO: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Carga el runtime y el modelo, o se salta el test.
///
/// El tercer valor del trio es el cerrojo de `MODELO_UNICO`. Hay que guardarlo con
/// nombre (`_modelo`) para que viva hasta el final del test.
macro_rules! runtime_o_model {
  () => {
    match (whisper_dir(), model_path()) {
      (Some(dir), Some(model)) => (
        dir,
        model,
        MODELO_UNICO.lock().unwrap_or_else(|e| e.into_inner()),
      ),
      _ => {
        eprintln!(
          "se omite: hace falta whisper.dll y el modelo \
           (LYRICSTREAM_WHISPER_DIR / LYRICSTREAM_TEST_MODEL)"
        );
        return;
      }
    }
  };
}

/// Localiza un WAV de voz, descargandolo si hace falta.
fn wav_path() -> Option<PathBuf> {
  if let Ok(path) = std::env::var("LYRICSTREAM_TEST_WAV") {
    let path = PathBuf::from(path);
    if path.exists() {
      return Some(path);
    }
  }
  let local = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("runtime")
    .join("jfk.wav");
  local.exists().then_some(local)
}

/// Lee un WAV PCM de 16 bits a f32 mono en [-1, 1].
///
/// Acepta solo el subconjunto que devuelve whisper (RIFF/WAVE, fmt PCM de 16 bits):
/// el resto de variantes no aparecen en los ficheros de prueba y soportarlas aqui
/// seria codigo que nunca se ejecuta.
fn read_wav16(path: &Path) -> Vec<f32> {
  let bytes = std::fs::read(path).expect("no se pudo leer el WAV");
  assert!(bytes.len() > 44, "WAV demasiado corto");
  assert_eq!(&bytes[0..4], b"RIFF", "no es un RIFF");
  assert_eq!(&bytes[8..12], b"WAVE", "no es un WAVE");

  let mut pos = 12usize;
  let mut sample_rate = 0u32;
  let mut channels = 0u16;
  let mut bits = 0u16;
  let mut data: Option<(usize, usize)> = None;

  while pos + 8 <= bytes.len() {
    let id = &bytes[pos..pos + 4];
    let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
    let body = pos + 8;
    match id {
      b"fmt " => {
        channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
        sample_rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
        bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
      }
      b"data" => {
        data = Some((body, size.min(bytes.len() - body)));
        break;
      }
      _ => {}
    }
    pos = body + size + (size & 1); // los chunks se alinean a 2 bytes
  }

  assert_eq!(bits, 16, "solo se soportan muestras de 16 bits");
  assert_eq!(sample_rate, 16_000, "whisper exige 16 kHz");
  let (start, len) = data.expect("el WAV no tiene chunk de datos");

  let frames = &bytes[start..start + len];
  frames
    .chunks_exact(2)
    .map(|pair| {
      let raw = i16::from_le_bytes([pair[0], pair[1]]);
      // f32::from_i16 seria 32768 como divisor: aqui se divide por 32768 para que
      // -1.0 sea exactamente -1.0, que es lo que espera whisper.
      raw as f32 / 32_768.0
    })
    .collect::<Vec<f32>>()
    .chunks(channels.max(1) as usize)
    .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
    .collect()
}

#[test]
fn el_runtime_carga_y_expone_el_commit_esperado() {
  let (dir, _model, _modelo) = runtime_o_model!();
  WhisperRuntime::load(&dir).expect("deberia cargar whisper.dll");
  // El commit debe coincidir con el de las cabeceras vendorizadas: si alguien
  // actualiza las DLL sin actualizar `vendor/`, el shim queda desfasado en
  // silencio y este test lo dice.
  assert_eq!(
    WhisperRuntime::build(),
    "b5130",
    "las DLL desplegadas no son del commit que espera el shim"
  );
}

#[test]
fn transcribe_voz_real_y_devuelve_texto_coherente() {
  let (dir, model, _modelo) = runtime_o_model!();
  WhisperRuntime::load(&dir).expect("deberia cargar whisper.dll");
  let Some(wav) = wav_path() else {
    eprintln!("se omite: no hay WAV de voz (LYRICSTREAM_TEST_WAV o runtime/jfk.wav)");
    return;
  };

  let samples = read_wav16(&wav);
  assert!(
    samples.len() > 16_000,
    "el WAV deberia tener al menos un segundo"
  );

  let mut ctx = WhisperRuntime::init(&model, 2).expect("deberia cargar el modelo");
  assert!(ctx.is_multilingual(), "tiny q5_1 es multilingue");
  assert_eq!(ctx.n_threads(), 2);

  let text = ctx
    .transcribe(&samples, Some("en"), true, true, false)
    .expect("la inferencia deberia funcionar")
    .expect("deberia haber texto");

  // El contenido exacto depende de la build, pero un WAV de voz SIEMPRE produce
  // palabras. Comprobar "no vacio" es lo que distingue una inferencia real de un
  // stub: si el shim devolviera "" sin fallar, este test caeria.
  assert!(
    text.len() > 20,
    "transcripcion sospechosamente corta: {text:?}"
  );
  assert!(
    text.chars().any(|c| c.is_ascii_alphabetic()),
    "no hay ninguna letra en {text:?}"
  );
  eprintln!("transcripcion: {text}");
}

#[test]
fn la_deteccion_automatica_de_idioma_encuentra_ingles() {
  let (dir, model, _modelo) = runtime_o_model!();
  WhisperRuntime::load(&dir).expect("deberia cargar whisper.dll");
  let Some(wav) = wav_path() else {
    eprintln!("se omite: no hay WAV de voz");
    return;
  };
  let samples = read_wav16(&wav);

  let mut ctx = WhisperRuntime::init(&model, 2).expect("deberia cargar el modelo");
  // Con `language = None` whisper decide el idioma y lo deja en el contexto.
  let _ = ctx.transcribe(&samples, None, true, true, true);
  let detected = ctx.detected_language().expect("deberia detectar un idioma");
  assert_eq!(
    detected, "en",
    "un discurso en ingles deberia detectarse como 'en'"
  );
}

#[test]
fn un_silencio_no_produce_texto_pero_no_falla() {
  let (dir, model, _modelo) = runtime_o_model!();
  WhisperRuntime::load(&dir).expect("deberia cargar whisper.dll");
  let mut ctx = WhisperRuntime::init(&model, 2).expect("deberia cargar el modelo");

  // Dos segundos de silencio digital.
  let silence = vec![0.0f32; 32_000];
  let result = ctx
    .transcribe(&silence, Some("en"), true, true, false)
    .expect("el silencio no es un error de inferencia");
  // El resultado puede ser None (nada que decir) o texto residual: lo que NO puede
  // ser es un error. Un silencio que rompe la inferencia seria un fallo real.
  if let Some(text) = result {
    eprintln!("silencio -> {text:?}");
  }
}

#[test]
fn un_buffer_vacio_devuelve_none_sin_tocar_el_runtime() {
  let (dir, model, _modelo) = runtime_o_model!();
  WhisperRuntime::load(&dir).expect("deberia cargar whisper.dll");
  let mut ctx = WhisperRuntime::init(&model, 2).expect("deberia cargar el modelo");
  // Cero muestras es un caso limite: whisper lo trata como error, asi que el shim
  // lo filtra antes de bajar a C. Si no, la app veria fallos espurios al cerrar.
  assert_eq!(
    ctx.transcribe(&[], Some("en"), true, true, false).unwrap(),
    None
  );
}

#[test]
fn el_buffer_audio_se_puede_reutilizar_entre_llamadas() {
  // Reproduce el ciclo real de streaming: decodificar, volver a decodificar con
  // `no_context`, y comprobar que el estado sobrevive. Un estado mal liberado
  // apareceria aqui como corrupcion o crash.
  let (dir, model, _modelo) = runtime_o_model!();
  WhisperRuntime::load(&dir).expect("deberia cargar whisper.dll");
  let Some(wav) = wav_path() else {
    eprintln!("se omite: no hay WAV de voz");
    return;
  };
  let samples = read_wav16(&wav);

  let mut ctx = WhisperRuntime::init(&model, 2).expect("deberia cargar el modelo");
  for round in 0..3 {
    let text = ctx.transcribe(&samples, Some("en"), true, true, false);
    assert!(text.is_ok(), "la ronda {round} fallo: {text:?}");
  }
}

#[test]
fn el_shim_no_registra_fugas_al_repetir_cargas_y_descargas() {
  // Cada iteracion crea y destruye un contexto. Si `Context::drop` no liberara el
  // estado o el contexto, el proceso acumularia memoria del modelo (32 MB + KV
  // cache) y esto se veria como un crecimiento sostenido.
  let (dir, model, _modelo) = runtime_o_model!();
  WhisperRuntime::load(&dir).expect("deberia cargar whisper.dll");
  let before = resident_bytes();
  for _ in 0..4 {
    let ctx = WhisperRuntime::init(&model, 2).expect("deberia cargar el modelo");
    drop(ctx);
  }
  let after = resident_bytes();
  eprintln!("RSS antes {before} KiB, despues {after} KiB");
  // Margen amplio: la idea es detectar una fuga de decenas de MB por iteracion, no
  // fluctuations del allocator.
  assert!(
    after < before + 150_000,
    "la memoria resident crecio {} KiB: posible fuga",
    after.saturating_sub(before)
  );
}

/// Memoria resident del proceso en KiB, leida de /proc o GetProcessMemoryInfo.
///
/// En Windows se usa el propio K32GetProcessMemoryInfo; devolver 0 si falla deja
/// que el test se salte la comprobacion en vez de dar un falso positivo.
fn resident_bytes() -> u64 {
  #[cfg(windows)]
  {
    use std::mem;
    // K32GetProcessMemoryInfo vive en kernel32, que ya esta enlazado.
    #[repr(C)]
    struct ProcessMemoryCounters {
      cb: u32,
      page_fault_count: u32,
      peak_working_set_size: usize,
      working_set_size: usize,
      quota_peak_paged_pool_usage: usize,
      quota_paged_pool_usage: usize,
      quota_peak_non_paged_pool_usage: usize,
      quota_non_paged_pool_usage: usize,
      pagefile_usage: usize,
      peak_pagefile_usage: usize,
    }
    extern "system" {
      fn K32GetProcessMemoryInfo(
        process: *mut core::ffi::c_void,
        counters: *mut ProcessMemoryCounters,
        cb: u32,
      ) -> i32;
      fn GetCurrentProcess() -> *mut core::ffi::c_void;
    }
    let mut counters: ProcessMemoryCounters = unsafe { mem::zeroed() };
    counters.cb = size_of::<ProcessMemoryCounters>() as u32;
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    if ok == 0 {
      0
    } else {
      (counters.working_set_size / 1024) as u64
    }
  }
  #[cfg(not(windows))]
  {
    std::fs::read_to_string("/proc/self/statm")
      .ok()
      .and_then(|s| s.split_whitespace().nth(1)?.parse::<u64>().ok())
      .map(|pages| pages * 4)
      .unwrap_or(0)
  }
}
