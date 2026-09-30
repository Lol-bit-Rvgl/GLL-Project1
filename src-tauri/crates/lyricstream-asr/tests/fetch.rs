//! Tests del descargador basado en `curl.exe`.
//!
//! No tocan la red: curl resuelve `file://` desde el disco, asi que los tests usan
//! ficheros temporales como origen. Eso permite ejercitar el codigo de salida, la
//! salida vacia y el temporal de descarga sin depender de un servidor real.
//!
//! En Windows se usa el `curl.exe` del sistema; en otros sistemas se busca `curl`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use lyricstream_asr::model::Fetcher;
use lyricstream_asr::CurlFetcher;

/// Directorio unico por test, para que se limpien solos al caer el proceso.
struct TempDir(PathBuf);

impl TempDir {
  fn new(tag: &str) -> Self {
    let unique = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("lyricstream-curl-{tag}-{unique}"));
    fs::create_dir_all(&path).expect("no se pudo crear el directorio temporal");
    Self(path)
  }

  fn path(&self) -> &Path {
    &self.0
  }

  /// URL `file://` de un fichero escrito ahora mismo.
  fn source_url(&self, name: &str, payload: &[u8]) -> String {
    let path = self.path().join(name);
    fs::write(&path, payload).expect("no se pudo escribir el origen");
    format!("file://{}", path.display())
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

/// Ruta de un `curl` utilizable, o `None` si la maquina no lo tiene.
fn curl_path() -> Option<String> {
  let candidates = if cfg!(windows) {
    vec!["curl.exe", "curl"]
  } else {
    vec!["curl"]
  };
  for candidate in candidates {
    if Command::new(candidate)
      .arg("--version")
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()
      .map(|s| s.success())
      .unwrap_or(false)
    {
      return Some(candidate.to_string());
    }
  }
  None
}

#[test]
fn una_descarga_exitosa_escribe_el_fichero_e_informa_progreso() {
  let Some(program) = curl_path() else {
    eprintln!("sin curl en el PATH: se omite");
    return;
  };
  let dir = TempDir::new("ok");
  let url = dir.source_url("origen.bin", b"contenido de prueba");
  let dest = dir.path().join("sub").join("modelo.bin");
  let fetcher = CurlFetcher::with_program(program);

  let calls = AtomicUsize::new(0);
  let mut seen = 0u64;
  let mut progress = |downloaded: u64, _total: Option<u64>| {
    calls.fetch_add(1, Ordering::SeqCst);
    seen = downloaded;
  };
  fetcher
    .download(&url, &dest, &mut progress)
    .unwrap_or_else(|err| panic!("la descarga fallo: {err}"));

  assert_eq!(fs::read(&dest).unwrap(), b"contenido de prueba");
  assert_eq!(
    calls.load(Ordering::SeqCst),
    1,
    "debe informar progreso una vez"
  );
  assert_eq!(seen as usize, b"contenido de prueba".len());
}

#[test]
fn el_directorio_de_destino_se_crea_si_falta() {
  let Some(program) = curl_path() else {
    eprintln!("sin curl en el PATH: se omite");
    return;
  };
  let dir = TempDir::new("mkdir");
  let url = dir.source_url("origen.bin", b"x");
  let dest = dir.path().join("a").join("b").join("modelo.bin");
  let mut progress = |_: u64, _: Option<u64>| {};
  CurlFetcher::with_program(program)
    .download(&url, &dest, &mut progress)
    .expect("debe crear los directorios intermedios");
  assert!(dest.exists());
}

#[test]
fn una_descarga_fallida_no_deja_fichero() {
  let Some(program) = curl_path() else {
    eprintln!("sin curl en el PATH: se omite");
    return;
  };
  let dir = TempDir::new("fallo");
  let dest = dir.path().join("modelo.bin");
  let mut progress = |_: u64, _: Option<u64>| {};
  let result = CurlFetcher::with_program(program).download(
    "file:///no/existe/en/absoluto.bin",
    &dest,
    &mut progress,
  );
  assert!(result.is_err(), "una URL inexistente debe fallar");
  assert!(!dest.exists(), "no debe quedar un destino falso");
}

#[test]
fn una_descarga_vacia_se_rechaza() {
  let Some(program) = curl_path() else {
    eprintln!("sin curl en el PATH: se omite");
    return;
  };
  let dir = TempDir::new("vacia");
  let url = dir.source_url("origen.bin", b"");
  let dest = dir.path().join("modelo.bin");
  let mut progress = |_: u64, _: Option<u64>| {};
  let result = CurlFetcher::with_program(program).download(&url, &dest, &mut progress);
  assert!(result.is_err(), "una descarga vacia debe rechazarse");
  assert!(!dest.exists(), "no debe quedar un destino falso");
}

#[test]
fn un_ejecutable_inexistente_es_un_error_claro() {
  let dir = TempDir::new("noexe");
  let dest = dir.path().join("modelo.bin");
  let mut progress = |_: u64, _: Option<u64>| {};
  let result = CurlFetcher::with_program("no-existe-este-programa-xyz").download(
    "https://example.invalid/x.bin",
    &dest,
    &mut progress,
  );
  let err = result.expect_err("debe fallar si no hay curl");
  let text = err.to_string();
  assert!(
    text.contains("curl"),
    "el error debe nombrar la causa: {text}"
  );
}
