use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use notify_debouncer_mini::notify::RecommendedWatcher;
use tauri::{AppHandle, Emitter, Manager};

/// Held in Tauri managed state. Dropping the debouncer stops the watch,
/// so replacing the Option releases the previous directory automatically
/// when the user opens a file elsewhere.
pub struct WatcherState {
    pub debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// The single file we actually care about within the watched dir.
    pub target: Mutex<Option<PathBuf>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self { debouncer: Mutex::new(None), target: Mutex::new(None) }
    }
}

#[tauri::command]
pub fn watch_directory(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?
        .to_path_buf();

    let app_for_cb = app.clone();
    let target_for_cb = target.clone();

    // 500ms debounce window: rapid write bursts (atomic saves, partial
    // flushes, agent appends) collapse into a single DebounceEvent batch.
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                // Cheap filter ON the watcher thread; heavy work OFF it.
                let relevant = events.iter().any(|e| {
                    e.path == target_for_cb
                        || is_atomic_sibling(&e.path, &target_for_cb)
                });
                if relevant {
                    // Fire-and-forget notification; the frontend decides
                    // when/how to reload. No modal, no diff screen.
                    let _ = app_for_cb.emit("doc://changed", ());
                }
            }
            Err(e) => eprintln!("[watcher] error: {e:?}"),
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let state = app.state::<WatcherState>();
    *state.target.lock().unwrap() = Some(target);
    // Replacing the old debouncer drops it → previous watch is released.
    *state.debouncer.lock().unwrap() = Some(debouncer);
    Ok(())
}

/// Atomic saves surface as events on `file.md.tmp`, `.file.md.swp`, etc.
/// Treat any event whose file stem contains the target's file name as
/// belonging to the target.
pub fn is_atomic_sibling(event_path: &Path, target: &Path) -> bool {
    match (event_path.file_name(), target.file_name()) {
        (Some(ev), Some(t)) => ev.to_string_lossy().contains(&*t.to_string_lossy()),
        _ => false,
    }
}
