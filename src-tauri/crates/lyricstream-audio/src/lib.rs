//! Captura y preprocesado de audio de LyricStream: WASAPI (loopback o microfono)
//! -> 16 kHz mono `f32`.
//!
//! Vive en un crate aparte, sin dependencia de Tauri, por dos razones:
//!
//! * El preprocesado es Rust puro y se puede testear sin levantar WebView2 ni la
//!   ventana de la app.
//! * Los simbolos de Tauri no llegan al enlazador de los tests, que con el binutils
//!   de este entorno (GCC 16.2) no arranca.
//!
//! El frontend no toca nada de esto directamente: habla con el motor a traves de los
//! comandos de `lyricstream_stt_lib::commands`.

pub mod capture;
pub mod resampler;

pub use capture::{
  AudioDeviceInfo, AudioDevicesInfo, AudioEngine, AudioSource, CaptureStatus, MONO_CAPACITY,
  RAW_CAPACITY,
};
pub use resampler::{Resampler, TARGET_SAMPLE_RATE};
