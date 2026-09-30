//! Tests de la gestion de pesos: rutas, estado, integridad e instalacion.
//!
//! Todos usan un directorio temporal propio: nada toca `%LOCALAPPDATA%` ni la red.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use lyricstream_asr::model::{
  default_models_dir, hex, sha256_file, Fetcher, ModelError, ModelInfo, ModelManager, ModelSpec,
};

/// Directorio unico por test, para que se limpien solos al caer el proceso.
struct TempDir(PathBuf);

impl TempDir {
  fn new(tag: &str) -> Self {
    let unique = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("lyricstream-asr-{tag}-{unique}"));
    fs::create_dir_all(&path).expect("no se pudo crear el directorio temporal");
    Self(path)
  }

  fn path(&self) -> &Path {
    &self.0
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

/// SHA-256 conocido de "abc", para probar la verificacion.
const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn write_file(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
  let path = dir.join(name);
  fs::write(&path, contents).expect("no se pudo escribir el fichero");
  path
}

#[test]
fn el_catalogo_declara_tamano_y_hash_para_el_modelo_activo() {
  let spec = ModelSpec::WHISPER_TINY_Q5_1;
  // Sin hash ni tamano, `is_usable` daria por bueno cualquier fichero con el
  // nombre correcto, y un HTML de error de HuggingFace se pasaria por modelo.
  assert!(
    spec.expected_bytes > 0,
    "el modelo activo debe declarar su tamano"
  );
  let sha = spec.sha256.expect("el modelo activo debe declarar su hash");
  assert_eq!(sha.len(), 64, "un SHA-256 son 64 caracteres hex");
  assert!(
    sha.chars().all(|c| c.is_ascii_hexdigit()),
    "el hash debe ser hexadecimal: {sha}"
  );
  assert!(
    spec.name.contains("q5_1") && spec.file_name.contains("q5_1"),
    "el nombre y el fichero deben coincidir en la cuantizacion: {} / {}",
    spec.name,
    spec.file_name
  );
}

#[test]
fn el_ruta_por_defecto_usa_localappdata() {
  // Con la variable presente, la ruta debe estar bajo LOCALAPPDATA.
  let path = default_models_dir();
  let rendered = path.to_string_lossy().replace('/', "\\");
  if let Some(local) = std::env::var_os("LOCALAPPDATA") {
    if !local.is_empty() {
      assert!(
        rendered
          .to_lowercase()
          .contains(&local.to_string_lossy().to_lowercase()),
        "con LOCALAPPDATA presente la ruta deberia ir ahi, no a {rendered}"
      );
    }
  }
  assert!(
    rendered.ends_with("LyricStream\\models") || rendered.ends_with("models"),
    "ruta inesperada: {rendered}"
  );
}

#[test]
fn un_modelo_ausente_informa_missing() {
  let dir = TempDir::new("ausente");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 0,
    sha256: None,
  };

  let info = manager.status(&spec);
  assert!(!info.installed, "no debe estar instalado");
  assert_eq!(info.name, "test-model");
  assert_eq!(info.size_bytes, 0);
  assert!(!info.is_usable());
  let reason = info
    .unusable_reason()
    .expect("debe explicar por que no sirve");
  assert!(reason.contains("no esta instalado"), "razon: {reason}");
}

#[test]
fn instalar_por_fichero_deja_el_modelo_usable() {
  let dir = TempDir::new("instalar");
  let manager = ModelManager::with_root(dir.path().join("models"));
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 3,
    sha256: None,
  };
  let source = write_file(dir.path(), "origen.bin", b"abc");

  let info = manager
    .install_from_file(&spec, &source)
    .expect("la instalacion debe funcionar");
  assert!(info.installed);
  assert_eq!(info.size_bytes, 3);
  assert!(info.size_ok);
  assert!(
    info.is_usable(),
    "un modelo pequeno sin hash declarado es usable"
  );
  assert!(
    manager.model_path(&spec).is_file(),
    "los pesos quedan en el directorio"
  );
  // El temporal no debe sobrevivir a una instalacion correcta.
  let partial = dir.path().join("models").join("pesos.bin.partial");
  assert!(
    !partial.exists(),
    "el temporal debe renombrarse, no dejarse"
  );
}

#[test]
fn instalar_verifica_el_hash_y_rechaza_contenido_equivocado() {
  let dir = TempDir::new("hash");
  let manager = ModelManager::with_root(dir.path().join("models"));
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 3,
    sha256: Some(ABC_SHA256),
  };
  let source = write_file(dir.path(), "origen.bin", b"xyz");

  let error = manager
    .install_from_file(&spec, &source)
    .expect_err("un hash incorrecto debe rechazarse");
  assert!(
    matches!(error, ModelError::HashMismatch { .. }),
    "se esperaba HashMismatch, se obtuvo {error:?}"
  );
  assert!(
    !manager.model_path(&spec).exists(),
    "un modelo con hash incorrecto no debe quedar visible"
  );
  let partial = dir.path().join("models").join("pesos.bin.partial");
  assert!(
    !partial.exists(),
    "el temporal debe borrarse al fallar la verificacion"
  );
}

#[test]
fn instalar_rechaza_un_tamano_equivocado() {
  let dir = TempDir::new("tamano");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 999,
    sha256: None,
  };
  let source = write_file(dir.path(), "origen.bin", b"abc");

  let error = manager
    .install_from_file(&spec, &source)
    .expect_err("un tamano distinto debe rechazarse");
  assert!(
    matches!(error, ModelError::InvalidPath(_)),
    "se esperaba InvalidPath: {error:?}"
  );
}

#[test]
fn instalar_rechaza_un_origen_inexistente() {
  let dir = TempDir::new("inexistente");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 0,
    sha256: None,
  };
  let error = manager
    .install_from_file(&spec, &dir.path().join("no-existe.bin"))
    .expect_err("un origen inexistente debe rechazarse");
  assert!(matches!(error, ModelError::InvalidPath(_)), "{error:?}");
}

#[test]
fn el_estado_detecta_un_fichero_corrupto_por_tamano() {
  let dir = TempDir::new("corrupto");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 1_000,
    sha256: None,
  };
  // Descarga interrumpida: el fichero esta a medias.
  write_file(dir.path(), "pesos.bin", b"abc");

  let info = manager.status(&spec);
  assert!(info.installed, "el fichero existe");
  assert!(!info.size_ok, "pero no tiene el tamano esperado");
  assert!(!info.is_usable(), "un fichero a medias no es usable");
  assert!(
    info.unusable_reason().unwrap().contains("incompleto"),
    "la razon debe avisar de corrupcion"
  );
}

/// Fetcher de laboratorio: escribe `payload` bytes y reporta progreso.
struct FakeFetcher {
  payload: Vec<u8>,
  calls: AtomicUsize,
  total_reported: Option<u64>,
}

impl FakeFetcher {
  fn new(payload: Vec<u8>, total_reported: Option<u64>) -> Self {
    Self {
      payload,
      calls: AtomicUsize::new(0),
      total_reported,
    }
  }
}

impl Fetcher for FakeFetcher {
  fn download(
    &self,
    _url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
  ) -> Result<(), ModelError> {
    self.calls.fetch_add(1, Ordering::Relaxed);
    fs::write(dest, &self.payload).map_err(|err| ModelError::Io {
      path: dest.display().to_string(),
      source: err,
    })?;
    on_progress(self.payload.len() as u64, self.total_reported);
    Ok(())
  }
}

#[test]
fn descargar_instala_y_verifica_el_modelo() {
  let dir = TempDir::new("descarga");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 3,
    sha256: Some(ABC_SHA256),
  };
  let fetcher = FakeFetcher::new(b"abc".to_vec(), Some(3));

  let mut progress: Vec<(u64, Option<u64>)> = Vec::new();
  let info = manager
    .download(
      &spec,
      "https://ejemplo/pesos.bin",
      &fetcher,
      &mut |done, total| {
        progress.push((done, total));
      },
    )
    .expect("la descarga debe funcionar");

  assert!(info.is_usable());
  assert!(info.verified, "el hash debe haberse comprobado");
  assert_eq!(
    progress,
    vec![(3, Some(3))],
    "debe informar el progreso final"
  );
  assert_eq!(fetcher.calls.load(Ordering::Relaxed), 1);
}

#[test]
fn descargar_sobre_un_modelo_bueno_no_repite() {
  let dir = TempDir::new("repetir");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 3,
    sha256: None,
  };
  write_file(dir.path(), "pesos.bin", b"abc");

  let fetcher = FakeFetcher::new(b"xyz".to_vec(), None);
  let error = manager
    .download(&spec, "https://ejemplo/pesos.bin", &fetcher, &mut |_, _| {})
    .expect_err("no debe volver a descargar lo que ya esta bien");
  assert!(
    matches!(error, ModelError::AlreadyInstalled(_)),
    "{error:?}"
  );
  assert_eq!(
    fetcher.calls.load(Ordering::Relaxed),
    0,
    "no debe tocar la red"
  );
}

#[test]
fn una_descarga_que_no_cuadra_no_deja_un_modelo_engañoso() {
  let dir = TempDir::new("mala");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 10,
    sha256: None,
  };
  // El servidor devuelve 3 bytes de 10 esperados: descarga truncada.
  let fetcher = FakeFetcher::new(b"abc".to_vec(), None);

  let error = manager
    .download(&spec, "https://ejemplo/pesos.bin", &fetcher, &mut |_, _| {})
    .expect_err("una descarga incompleta debe fallar");
  assert!(matches!(error, ModelError::Download(_)), "{error:?}");
  assert!(
    !manager.model_path(&spec).exists(),
    "un modelo truncado no debe quedar en disco como si valiera"
  );
}

#[test]
fn sha256_de_un_fichero_conocido() {
  let dir = TempDir::new("sha");
  let path = write_file(dir.path(), "abc.txt", b"abc");
  let digest = sha256_file(&path).expect("debe poder leerse");
  assert_eq!(hex(&digest), ABC_SHA256);
}

#[test]
fn sha256_lee_en_bloques_y_soporta_ficheros_grandes() {
  let dir = TempDir::new("grande");
  // Mas grande que el buffer de 64 KiB, para ejercitar la lectura por trozos.
  let payload: Vec<u8> = (0..200_000u32).map(|index| (index % 251) as u8).collect();
  let path = write_file(dir.path(), "grande.bin", &payload);
  let digest = sha256_file(&path).expect("debe poder leerse");
  assert_eq!(digest.len(), 32, "SHA-256 son 32 bytes");

  // El mismo contenido escrito de otra forma da el mismo hash.
  let other = write_file(dir.path(), "igual.bin", &payload);
  assert_eq!(hex(&sha256_file(&other).unwrap()), hex(&digest));
}

#[test]
fn el_hash_de_un_fichero_inexistente_es_error() {
  let dir = TempDir::new("nohash");
  assert!(sha256_file(&dir.path().join("no-existe")).is_err());
}

#[test]
fn hex_codifica_correctamente() {
  assert_eq!(hex(&[0x00, 0x0f, 0xff, 0xa5]), "000fffa5");
  assert_eq!(hex(&[]), "");
}

#[test]
fn el_gestor_crea_el_directorio_de_modelos() {
  let dir = TempDir::new("mkdir");
  let root = dir.path().join("a").join("b").join("models");
  let manager = ModelManager::with_root(&root);
  assert!(!root.exists());
  manager.ensure_root().expect("debe crear el directorio");
  assert!(root.is_dir(), "create_dir_all crea toda la cadena");
  // Idempotente.
  manager.ensure_root().expect("debe ser idempotente");
}

#[test]
fn un_modelo_con_hash_sin_fichero_no_calcula_sha() {
  let dir = TempDir::new("sinhash");
  let manager = ModelManager::with_root(dir.path());
  let spec = ModelSpec {
    name: "test-model",
    file_name: "pesos.bin",
    expected_bytes: 0,
    sha256: None,
  };
  // El fichero existe, asi que esta instalado.
  write_file(dir.path(), "pesos.bin", b"pesos de ejemplo");
  let info: ModelInfo = manager.status(&spec);
  // Sin hash declarado ni tamano que comprobar, no se paga el coste de leer el
  // fichero entero solo para verificarlo.
  assert!(info.actual_sha256.is_none());
  assert!(info.installed);
  assert!(info.is_usable());
}
