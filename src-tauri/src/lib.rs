pub mod commands;
pub mod parser;
pub mod state;
pub mod watcher;

// The Rust↔TS boundary is exactly three crossings (CLAUDE.md): the two commands
// registered below plus the `doc://changed` event emitted by the watcher.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .manage(crate::watcher::debounced::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            commands::document::load_document,
            crate::watcher::debounced::watch_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
