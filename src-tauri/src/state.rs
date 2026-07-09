use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub watched: Mutex<Option<PathBuf>>,
    pub doc_hash: Mutex<Option<String>>,
}
