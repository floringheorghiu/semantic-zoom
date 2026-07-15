// secrets.rs — Rust-owned API key storage (D9/D10, Implementation_Plan.md §8.2).
//
// The key must never exist in JS state longer than the instant it's typed.
// `get_api_key_status` returns a bool ONLY — the key string never crosses
// into a #[tauri::command] return type, so it never reaches the webview.

use keyring::Entry;

const SERVICE: &str = "com.semantic-zoom.llm-api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, "default").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_api_key(key: String) -> Result<(), String> {
    entry()?.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_api_key_status() -> bool {
    entry().and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

#[tauri::command]
pub fn delete_api_key() -> Result<(), String> {
    entry()?.delete_credential().map_err(|e| e.to_string())
}

/// Rust-internal accessor for the raw key — used by T5's `llm_complete`
/// command to build the Authorization header. Never exposed as a
/// #[tauri::command]; the key must not have a JS-callable path back out.
pub(crate) fn get_api_key() -> Result<String, String> {
    entry()?.get_password().map_err(|_| "No API key configured".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Keychain access is process-global state (one Keychain per test binary
    // invocation), so tests that touch the same service entry must not run
    // concurrently with each other — `cargo test` runs tests in threads by
    // default and would otherwise interleave save/delete across tests.
    static KEYCHAIN_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn secrets_roundtrip() {
        let _guard = KEYCHAIN_LOCK.lock().unwrap();

        // Start from a clean slate in case a previous failed run left a key behind.
        let _ = delete_api_key();
        assert!(!get_api_key_status(), "expected no key before save");

        save_api_key("dummy-test-key-do-not-use".to_string()).expect("save_api_key failed");
        assert!(get_api_key_status(), "expected status true after save");
        assert_eq!(get_api_key().expect("get_api_key failed"), "dummy-test-key-do-not-use");

        delete_api_key().expect("delete_api_key failed");
        assert!(!get_api_key_status(), "expected status false after delete");
    }
}
