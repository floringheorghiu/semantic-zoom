pub mod commands;
pub mod parser;
pub mod state;
pub mod watcher;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .manage(crate::watcher::debounced::WatcherState::default())
        .invoke_handler(tauri::generate_handler![greet, commands::document::load_document, crate::watcher::debounced::watch_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
