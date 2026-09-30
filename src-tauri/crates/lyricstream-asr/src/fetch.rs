//! Descarga de pesos con `curl.exe` de Windows.
//!
//! # Por que curl y no un cliente HTTP de Rust
//!
//! Añadir `reqwest`/`ureq` con TLS arrastra `rustls` mas sus dependencias de
//! criptografia, que en esta maquina (MinGW, ~1 GB de RAM, `jobs = 2`) es justo el
//! tipo de compilacion que hay que evitar. `curl.exe` viene con Windows 10 en
//! `System32`, soporta HTTPS con Schannel sin dependencias y ademas nos da el
//! progreso de descarga casi gratis con `--write-out`.
//!
//! La alternativa correcta si algun dia hace falta: implementar el trait
//! [`Fetcher`] con el cliente HTTP que se prefiera. El resto del crate no cambia.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::model::{Fetcher, ModelError};

/// Descargador que delega en `curl.exe`.
#[derive(Debug, Clone)]
pub struct CurlFetcher {
  /// Ruta al ejecutable, por si `curl.exe` no esta en el PATH.
  program: String,
  /// Segundos maxima de espera.
  timeout_secs: u64,
  /// Segundos maxima sinProgresso antes de cortar (detecta descargas colgadas).
  connect_timeout_secs: u64,
}

impl Default for CurlFetcher {
  fn default() -> Self {
    Self {
      program: "curl.exe".to_string(),
      timeout_secs: 3_600,
      connect_timeout_secs: 30,
    }
  }
}

impl CurlFetcher {
  /// `curl` con tiempos de espera distintos a los de por defecto.
  pub fn with_timeouts(timeout_secs: u64, connect_timeout_secs: u64) -> Self {
    Self {
      timeout_secs,
      connect_timeout_secs,
      ..Default::default()
    }
  }

  /// `curl` en otra ruta. Util para los tests, que apuntan a un ejecutable concreto.
  pub fn with_program(program: impl Into<String>) -> Self {
    Self {
      program: program.into(),
      ..Default::default()
    }
  }

  /// Ruta del ejecutable, para diagnostico.
  pub fn program(&self) -> &str {
    &self.program
  }

  /// `curl` escribe el progreso a stderr y el resultado con `-w` a stdout.
  ///
  /// Se pide una maquina de estados por fraccion descargada (`size_download/total`)
  /// en lugar de parsear la barra de progreso legible, que cambia entre versiones.
  fn build_command(&self, url: &str, dest: &Path) -> Command {
    let mut command = Command::new(&self.program);
    command
      .arg("--fail")
      .arg("--silent")
      .arg("--show-error")
      .arg("--location")
      .arg("--no-progress-meter")
      .arg("--create-dirs")
      .arg("--max-time")
      .arg(self.timeout_secs.to_string())
      .arg("--connect-timeout")
      .arg(self.connect_timeout_secs.to_string())
      // Un temporal primero: si la descarga se corta, el destino nunca vio datos
      // parciales. `ModelManager` renombra despues de verificar.
      .arg("--output")
      .arg(dest)
      .arg("--write-out")
      .arg("%{size_download} %{num_connects}")
      .arg(url);
    command
  }

  /// Ejecuta curl y devuelve los bytes descargados.
  fn run(&self, url: &str, dest: &Path) -> Result<u64, ModelError> {
    let mut command = self.build_command(url, dest);
    let output = command
      .stdin(Stdio::null())
      .output()
      .map_err(|err| ModelError::Download(format!("no se pudo ejecutar curl: {err}")))?;

    if !output.status.success() {
      let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
      return Err(ModelError::Download(format!(
        "curl fallo con codigo {}: {stderr}",
        output.status.code().unwrap_or(-1)
      )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let bytes = stdout
      .split_whitespace()
      .next()
      .and_then(|value| value.parse::<u64>().ok())
      .unwrap_or(0);
    Ok(bytes)
  }
}

impl Fetcher for CurlFetcher {
  /// Descarga a un temporal, informa el progreso al final y renombra al destino.
  ///
  /// curl con `--no-progress-meter` no emite progreso en vivo, asi que se reporta
  /// una vez al terminar. El frontend recibe el porcentaje final, que es lo que
  /// importa para una barra; si hace falta progreso continuo, la alternativa es
  /// un cliente HTTP de Rust con su callback de progreso.
  fn download(
    &self,
    url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
  ) -> Result<(), ModelError> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|err| ModelError::Io {
      path: parent.display().to_string(),
      source: err,
    })?;

    let temporary = dest.with_extension("curl-part");
    let bytes = self.run(url, &temporary)?;
    let total = std::fs::metadata(&temporary).map(|m| m.len()).ok();
    on_progress(bytes, total);

    if bytes == 0 {
      let _ = std::fs::remove_file(&temporary);
      return Err(ModelError::Download(format!(
        "la descarga de {url} vino vacia"
      )));
    }
    std::fs::rename(&temporary, dest).map_err(|err| ModelError::Io {
      path: dest.display().to_string(),
      source: err,
    })?;
    Ok(())
  }
}
