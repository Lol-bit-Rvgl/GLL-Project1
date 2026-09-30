//! Gestion de pesos del modelo: rutas, estado, verificacion e instalacion.
//!
//! El modelo no se descarga ni se ejecuta en el camino critico de audio. Este
//! modulo solo responde preguntas sobre el disco:
//!
//! - Donde vive `%LOCALAPPDATA%\\LyricStream\\models` (o `./models`).
//! - Si los pesos estan, cuanto ocupan y si su SHA-256 coincide con el esperado.
//! - Como instalarlos desde un fichero local o desde una URL, informando progreso
//!   sin bloquear a quien pregunta.
//!
//! La descarga usa el trait [`Fetcher`] para no atar el crate a un cliente HTTP:
//! el comando de Tauri inyecta la implementacion real, y los tests usan una local.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Errores de gestion de modelo.
#[derive(Debug, Error)]
pub enum ModelError {
  #[error("ruta de modelo invalida: {0}")]
  InvalidPath(String),
  #[error("el modelo ya esta instalado: {0}")]
  AlreadyInstalled(String),
  #[error("el modelo no esta instalado: {0}")]
  NotInstalled(String),
  #[error("fallo de E/S en {path}: {source}")]
  Io {
    path: String,
    #[source]
    source: std::io::Error,
  },
  #[error("el hash del modelo no coincide: esperado {expected}, obtenido {actual}")]
  HashMismatch { expected: String, actual: String },
  #[error("la descarga fallo: {0}")]
  Download(String),
}

/// Como se describe el estado del modelo a la UI.
#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
  /// Nombre logico del modelo.
  pub name: String,
  /// Nombre del fichero de pesos.
  pub file_name: String,
  /// Ruta absoluta prevista, exista o no.
  pub expected_path: String,
  /// `true` si el fichero existe y es legible.
  pub installed: bool,
  /// Tamano en disco en bytes; 0 si no esta instalado.
  pub size_bytes: u64,
  /// SHA-256 esperado, si el catalogo lo publica.
  pub expected_sha256: Option<String>,
  /// SHA-256 calculado del fichero, si se pudo calcular.
  pub actual_sha256: Option<String>,
  /// `true` si hay hash esperado y coincide con el calculado.
  pub verified: bool,
  /// `false` si el tamano no coincide con el declarado por el catalogo.
  pub size_ok: bool,
}

impl ModelInfo {
  /// Estado resumido para decidir si se puede arrancar el motor.
  pub fn is_usable(&self) -> bool {
    self.installed && self.size_ok && (self.expected_sha256.is_none() || self.verified)
  }

  /// Motivo por el que el modelo no se puede usar, en texto para la UI.
  pub fn unusable_reason(&self) -> Option<String> {
    if self.is_usable() {
      return None;
    }
    if !self.installed {
      return Some(format!("{} no esta instalado", self.name));
    }
    if !self.size_ok {
      return Some(format!("{} esta incompleto o corrupto", self.name));
    }
    Some(format!("el hash de {} no coincide", self.name))
  }
}

/// Descripcion estatica de un modelo del catalogo.
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
  /// Nombre logico, el que ve la UI.
  pub name: &'static str,
  /// Fichero de pesos dentro del directorio de modelos.
  pub file_name: &'static str,
  /// Tamano esperado en bytes; 0 si el catalogo no lo declara.
  pub expected_bytes: u64,
  /// SHA-256 esperado, vacio si no se publica.
  pub sha256: Option<&'static str>,
}

impl ModelSpec {
  /// Modelo por defecto: Whisper tiny en GGML q5_1, la variante que mejor cabe
  /// en ~1 GB de RAM junto con el runtime.
  ///
  /// El nombre refleja la cuantizacion real del fichero (`q5_1`), no una
  /// generica "int8": la UI muestra `name` y el usuario acaba mirando `file_name`
  /// en la carpeta, asi que discrepancia entre los dos se lee como un fallo.
  ///
  /// Tamano y hash comprobados contra el fichero publicado en
  /// `huggingface.co/ggerganov/whisper.cpp`. El `X-Linked-ETag` de la respuesta
  /// es el OID SHA-256 del LFS, confirmado bajando el fichero y hasheandolo.
  pub const WHISPER_TINY_Q5_1: ModelSpec = ModelSpec {
    name: "whisper-tiny-q5_1",
    file_name: "ggml-tiny-q5_1.bin",
    expected_bytes: 32_152_673,
    sha256: Some("818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7"),
  };

  /// Alias historico. Se conserva porque el nombre anterior aparece en capturas
  /// y scripts; apunta al mismo fichero.
  pub const WHISPER_TINY_INT8: ModelSpec = ModelSpec::WHISPER_TINY_Q5_1;
}

/// Descarga de ficheros grandes con progreso.
pub trait Fetcher: Send {
  /// Descarga `url` a `dest`.
  ///
  /// `on_progress` recibe los bytes escritos y el total si el servidor lo declara.
  /// La implementacion debe escribir en un temporal y renombrar al terminar, para
  /// que una descarga interrumpida no deje un modelo aparentemente valido.
  fn download(
    &self,
    url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
  ) -> Result<(), ModelError>;
}

/// Localizador y verificador de pesos.
#[derive(Debug, Clone)]
pub struct ModelManager {
  root: PathBuf,
}

impl ModelManager {
  /// Localizador con la ruta por defecto del sistema.
  ///
  /// Usa `%LOCALAPPDATA%\LyricStream\models` y cae a `./models` si la variable no
  /// existe, que es lo que pasa en sandboxes, contenedores y CI.
  pub fn new() -> Self {
    Self::with_root(default_models_dir())
  }

  /// Localizador con raiz explicita, para tests y para portable.
  pub fn with_root(root: impl Into<PathBuf>) -> Self {
    Self { root: root.into() }
  }

  /// Directorio de modelos.
  pub fn root(&self) -> &Path {
    &self.root
  }

  /// Ruta de un modelo concreto.
  pub fn model_path(&self, spec: &ModelSpec) -> PathBuf {
    self.root.join(spec.file_name)
  }

  /// Crea el directorio de modelos si hace falta. Idempotente.
  pub fn ensure_root(&self) -> Result<(), ModelError> {
    fs::create_dir_all(&self.root).map_err(|source| ModelError::Io {
      path: self.root.display().to_string(),
      source,
    })
  }

  /// Estado del modelo en disco, sin calcular el hash salvo que este declarado.
  ///
  /// Calcular el SHA-256 de ~80 MB cuesta ~200 ms, asi que solo se hace cuando el
  /// catalogo publica un hash esperado o cuando el tamano no cuadra.
  pub fn status(&self, spec: &ModelSpec) -> ModelInfo {
    let path = self.model_path(spec);
    let metadata = fs::metadata(&path).ok().filter(|m| m.is_file());
    let installed = metadata.is_some();
    let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
    let size_ok = installed && (spec.expected_bytes == 0 || size_bytes == spec.expected_bytes);

    let mut actual_sha256 = None;
    let needs_hash = installed && (spec.sha256.is_some() || !size_ok);
    if needs_hash {
      actual_sha256 = sha256_file(&path).ok().map(|hash| hex(&hash));
    }
    let verified = match (spec.sha256, actual_sha256.as_ref()) {
      (Some(expected), Some(actual)) => expected.eq_ignore_ascii_case(actual),
      _ => false,
    };

    ModelInfo {
      name: spec.name.to_string(),
      file_name: spec.file_name.to_string(),
      expected_path: path.display().to_string(),
      installed,
      size_bytes,
      expected_sha256: spec.sha256.map(str::to_string),
      actual_sha256,
      verified,
      size_ok,
    }
  }

  /// Instala pesos desde un fichero local, copiando a un temporal y renombrando.
  ///
  /// Verifica el tamano y el hash declarados antes de hacer visible el modelo.
  pub fn install_from_file(
    &self,
    spec: &ModelSpec,
    source: &Path,
  ) -> Result<ModelInfo, ModelError> {
    if !source.is_file() {
      return Err(ModelError::InvalidPath(format!(
        "el origen no es un fichero: {}",
        source.display()
      )));
    }
    self.ensure_root()?;
    let metadata = fs::metadata(source).map_err(|err| ModelError::Io {
      path: source.display().to_string(),
      source: err,
    })?;
    if spec.expected_bytes != 0 && metadata.len() != spec.expected_bytes {
      return Err(ModelError::InvalidPath(format!(
        "tamaño incorrecto: se esperaban {} bytes y hay {}",
        spec.expected_bytes,
        metadata.len()
      )));
    }

    let final_path = self.model_path(spec);
    let temp_path = self.root.join(format!("{}.partial", spec.file_name));
    fs::copy(source, &temp_path).map_err(|err| ModelError::Io {
      path: temp_path.display().to_string(),
      source: err,
    })?;

    // El hash se comprueba sobre el temporal: si falla, el destino nunca existio
    // con contenido invalido.
    if let Some(expected) = spec.sha256 {
      let actual = hex(&sha256_file(&temp_path).map_err(|err| ModelError::Io {
        path: temp_path.display().to_string(),
        source: err,
      })?);
      if !expected.eq_ignore_ascii_case(&actual) {
        let _ = fs::remove_file(&temp_path);
        return Err(ModelError::HashMismatch {
          expected: expected.to_string(),
          actual,
        });
      }
    }
    fs::rename(&temp_path, &final_path).map_err(|err| ModelError::Io {
      path: final_path.display().to_string(),
      source: err,
    })?;
    Ok(self.status(spec))
  }

  /// Descarga los pesos con el `fetcher` indicado, informando progreso.
  pub fn download(
    &self,
    spec: &ModelSpec,
    url: &str,
    fetcher: &dyn Fetcher,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
  ) -> Result<ModelInfo, ModelError> {
    self.ensure_root()?;
    let final_path = self.model_path(spec);
    if final_path.is_file() {
      let info = self.status(spec);
      if info.is_usable() {
        return Err(ModelError::AlreadyInstalled(spec.name.to_string()));
      }
    }
    fetcher.download(url, &final_path, on_progress)?;
    let info = self.status(spec);
    if !info.is_usable() {
      // Descarga terminada pero el resultado no sirve: no se deja un modelo dudoso.
      let _ = fs::remove_file(&final_path);
      return Err(ModelError::Download(format!(
        "{} no es utilizable tras la descarga",
        spec.name
      )));
    }
    Ok(info)
  }
}

impl Default for ModelManager {
  fn default() -> Self {
    Self::new()
  }
}

/// `%LOCALAPPDATA%\LyricStream\models`, o `./models` si no hay variable de entorno.
pub fn default_models_dir() -> PathBuf {
  std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .filter(|path| !path.as_os_str().is_empty())
    .map(|base| base.join("LyricStream").join("models"))
    .unwrap_or_else(|| PathBuf::from("models"))
}

/// SHA-256 de un fichero, leido en bloques para no cargarlo entero en memoria.
pub fn sha256_file(path: &Path) -> std::io::Result<Vec<u8>> {
  let mut file = fs::File::open(path)?;
  let mut hasher = Sha256::new();
  let mut buffer = vec![0u8; 64 * 1024];
  loop {
    let read = file.read(&mut buffer)?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  Ok(hasher.finalize().to_vec())
}

/// Bytes a hexadecimal en minusculas.
pub fn hex(bytes: &[u8]) -> String {
  const DIGITS: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(bytes.len() * 2);
  for byte in bytes {
    out.push(DIGITS[(byte >> 4) as usize] as char);
    out.push(DIGITS[(byte & 0x0f) as usize] as char);
  }
  out
}
