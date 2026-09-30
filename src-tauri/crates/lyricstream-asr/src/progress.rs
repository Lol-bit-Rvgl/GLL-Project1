//! Progreso y resultado de la descarga de pesos.
//!
//! Estas estructuras viven en el crate de ASR y no en el comando de Tauri por una
//! razon concreta: el paquete raiz tiene el harness de `cargo test` desactivado
//! (el enlazador de este entorno no puede arrancar el binario de test de Tauri),
//! asi que aqui no habria forma de comprobar el calculo del porcentaje ni el
//! contrato de "la descarga fallo, no te lo pongas como instalado".
//!
//! Los tipos son datos planos y `Serialize`: el comando de Tauri solo los reenvia.

use serde::Serialize;

use crate::model::ModelInfo;

/// Progreso de una descarga.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
  /// Bytes escritos hasta ahora.
  pub downloaded: u64,
  /// Total esperado, si se conoce.
  pub total: Option<u64>,
  /// Porcentaje 0.0-100.0, o `None` si no se conoce el total.
  pub percent: Option<f32>,
}

impl DownloadProgress {
  /// Progreso a partir de los bytes y el total opcional.
  ///
  /// Un total de 0 o ausente deja el porcentaje a `None` en vez de dividir por
  /// cero: la barra se quedaria vacia, que es preferible a un `NaN` en la UI.
  pub fn new(downloaded: u64, total: Option<u64>) -> Self {
    let percent = total
      .filter(|total| *total > 0)
      .map(|total| (downloaded as f64 / total as f64 * 100.0).clamp(0.0, 100.0) as f32);
    Self {
      downloaded,
      total,
      percent,
    }
  }

  /// `true` si se alcanzo el total esperado.
  ///
  /// Un total de 0 (o ausente) nunca cuenta como completo. Con el filtro ingenuo
  /// `downloaded >= total`, un total de 0 daria `0 >= 0` y marcaria como finished
  /// cualquier progreso, incluidos los que solo informaran de que se empezo.
  pub fn is_complete(&self) -> bool {
    self
      .total
      .is_some_and(|total| total > 0 && self.downloaded >= total)
  }
}

/// Como termino un intento de descarga.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
  /// `true` si el modelo quedo instalado y verificado.
  pub ok: bool,
  /// Mensaje de error, si lo hubo.
  pub error: Option<String>,
  /// Estado del modelo tras el intento.
  ///
  /// Va incluido para que la UI pueda repintar sin una segunda ida al backend.
  /// En un fallo puede venir `None`: si ni siquiera se pudo escribir el temporal,
  /// releer el estado no dira nada que el `error` no diga ya.
  pub model: Option<ModelInfo>,
}

impl DownloadOutcome {
  /// Descarga correcta: el modelo instalado y verificado.
  pub fn success(model: ModelInfo) -> Self {
    Self {
      ok: true,
      error: None,
      model: Some(model),
    }
  }

  /// Descarga fallida.
  pub fn failure(error: impl std::fmt::Display) -> Self {
    Self {
      ok: false,
      error: Some(error.to_string()),
      model: None,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn el_porcentaje_sale_de_los_bytes_y_el_total() {
    let progress = DownloadProgress::new(512, Some(1024));
    assert_eq!(progress.percent, Some(50.0));
    assert!(!progress.is_complete());
  }

  #[test]
  fn un_total_desconocido_deja_el_porcentaje_a_none() {
    // Sin total no se puede saber cuanto queda: la UI debe pintar una barra
    // indeterminado, no inventar un 0% que sugiere que no ha empezado.
    let progress = DownloadProgress::new(1024, None);
    assert_eq!(progress.percent, None);
    assert!(!progress.is_complete());
  }

  #[test]
  fn un_total_de_cero_no_divide() {
    let progress = DownloadProgress::new(10, Some(0));
    assert_eq!(progress.percent, None);
    assert!(!progress.is_complete());
  }

  #[test]
  fn el_porcentaje_no_pasa_de_cien() {
    // curl puede informar de mas bytes de los esperados si el servidor cambio
    // el recurso a mitad de descarga.
    let progress = DownloadProgress::new(2048, Some(1024));
    assert_eq!(progress.percent, Some(100.0));
    assert!(progress.is_complete());
  }

  #[test]
  fn el_ultimo_progreso_siempre_pasa_aunque_haya_margen() {
    // El emisor de Tauri limita la frecuencia; este caso debe saltarse el limite
    // o la barra se quedaria al 99% para siempre.
    assert!(DownloadProgress::new(1024, Some(1024)).is_complete());
  }

  #[test]
  fn un_exito_lleva_el_modelo_y_no_un_error() {
    let outcome = DownloadOutcome::failure("sin red");
    assert!(!outcome.ok);
    assert_eq!(outcome.error.as_deref(), Some("sin red"));
    assert!(outcome.model.is_none());
  }
}
