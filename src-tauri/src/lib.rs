pub mod commands;
pub mod parser;
pub mod state;
pub mod watcher;

// Phase 1's Rust↔TS boundary was exactly three crossings (CLAUDE.md):
// load_document, watch_directory, and the doc://changed event. D9/D10
// (Implementation_Plan.md §8) add a deliberate, isolated exception for
// Engine B synthesis — new commands below are confined to src/native/**
// on the TS side, kept outside src/engine/**/src/ui/** so the
// no-restricted-imports rule and the System E export stay untouched.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state::AppState::default())
        .manage(crate::watcher::debounced::WatcherState::default())
        .manage(commands::llm_client::LlmCancelState::default())
        .invoke_handler(tauri::generate_handler![
            commands::document::load_document,
            crate::watcher::debounced::watch_directory,
            commands::secrets::save_api_key,
            commands::secrets::get_api_key_status,
            commands::secrets::delete_api_key,
            commands::provider_config::get_provider_config,
            commands::provider_config::set_provider_config,
            commands::provider_config::get_saved_provider_config,
            commands::provider_config::get_saved_provider_profile,
            commands::provider_config::get_prompt_templates,
            commands::provider_config::set_prompt_templates,
            commands::provider_config::get_update_prefs,
            commands::provider_config::set_update_prefs,
            commands::window::open_settings_window,
            commands::window::request_update_check,
            commands::remove_payload::remove_payload,
            commands::help::install_help_file,
            commands::generation_history::get_generation_history,
            commands::generation_history::append_generation_run,
            commands::generation_history::get_doc_template,
            commands::generation_history::set_doc_template,
            commands::llm_client::llm_complete,
            commands::llm_client::probe_provider,
            commands::llm_client::cancel_llm_generation,
            commands::write_payload::write_payload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
