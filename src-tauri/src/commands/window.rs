// window.rs — Settings window lifecycle (§8.3). A second native Tauri
// window bundling only settings.html / src/native/settings-form.ts — it
// never loads the document viewport, store, or engine modules, so it has
// nothing to leak even by accident.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(460.0, 610.0)
        .resizable(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Lets the settings window's manual "Check for Updates now" keep the main
/// window's empty-state banner in sync — the dialog itself is NOT shared
/// across windows (each window mounts its own instance), this only nudges
/// the main window to also re-run its own check so its banner state is
/// current. A no-op if the main window doesn't exist (shouldn't happen in
/// practice — there's always exactly one main window).
#[tauri::command]
pub fn request_update_check(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.emit("update://check-requested", ()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
