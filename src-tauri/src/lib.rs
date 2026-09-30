pub mod commands;
pub mod stt;

use stt::SttState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    // Un unico contenedor para audio y STT: el worker de inferencia lee del mismo
    // `AudioEngine` que alimenta la captura, asi que separarlos lo dejaria
    // leyendo un anillo vacio.
    .manage(SttState::new())
    .invoke_handler(tauri::generate_handler![
      commands::get_audio_devices,
      commands::start_capture,
      commands::stop_capture,
      commands::get_audio_level,
      commands::set_capture_paused,
      commands::get_capture_status,
      commands::get_model_status,
      commands::download_model,
      commands::install_model,
      commands::start_stt,
      commands::stop_stt,
      commands::get_stt_status,
      commands::set_stt_language,
      commands::drain_capture,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
