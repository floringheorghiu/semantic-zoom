// secrets.rs — Rust-owned API key storage (D9/D10, Implementation_Plan.md §8.2).
//
// The key must never exist in JS state longer than the instant it's typed.
// `get_api_key_status` returns a bool ONLY — the key string never crosses
// into a #[tauri::command] return type, so it never reaches the webview.

use keyring::Entry;

const SERVICE: &str = "com.semantic-zoom.llm-api-key";

// Service-parameterized internals so tests can exercise the identical
// keyring plumbing against a THROWAWAY service name. Tests must never touch
// `SERVICE`: a `cargo test` run once deleted the user's real production key
// (2026-07-16) because the round-trip test cleaned up the real entry.
fn entry_for(service: &str) -> Result<Entry, String> {
    Entry::new(service, "default").map_err(|e| e.to_string())
}

fn save_for(service: &str, key: &str) -> Result<(), String> {
    entry_for(service)?.set_password(key).map_err(|e| e.to_string())
}

fn status_for(service: &str) -> bool {
    entry_for(service)
        .and_then(|e| e.get_password().map_err(|e| e.to_string()))
        .is_ok()
}

fn delete_for(service: &str) -> Result<(), String> {
    entry_for(service)?.delete_credential().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_api_key(key: String) -> Result<(), String> {
    save_for(SERVICE, &key)
}

#[tauri::command]
pub fn get_api_key_status() -> bool {
    status_for(SERVICE)
}

#[tauri::command]
pub fn delete_api_key() -> Result<(), String> {
    delete_for(SERVICE)
}

/// Rust-internal accessor for the raw key — used by T5's `llm_complete`
/// command to build the Authorization header. Never exposed as a
/// #[tauri::command]; the key must not have a JS-callable path back out.
pub(crate) fn get_api_key() -> Result<String, String> {
    entry_for(SERVICE)?
        .get_password()
        .map_err(|_| "No API key configured".to_string())
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

    // NEVER `SERVICE`: the round-trip test deletes its entry as setup and
    // teardown, and against the real service name that destroys the user's
    // actual saved API key (it happened — 2026-07-16).
    const TEST_SERVICE: &str = "com.semantic-zoom.llm-api-key.cargo-test";

    #[test]
    fn secrets_roundtrip() {
        let _guard = KEYCHAIN_LOCK.lock().unwrap();

        // Start from a clean slate in case a previous failed run left a key behind.
        let _ = delete_for(TEST_SERVICE);
        assert!(!status_for(TEST_SERVICE), "expected no key before save");

        save_for(TEST_SERVICE, "dummy-test-key-do-not-use").expect("save failed");
        assert!(status_for(TEST_SERVICE), "expected status true after save");
        assert_eq!(
            entry_for(TEST_SERVICE).unwrap().get_password().expect("get failed"),
            "dummy-test-key-do-not-use"
        );

        delete_for(TEST_SERVICE).expect("delete failed");
        assert!(!status_for(TEST_SERVICE), "expected status false after delete");
    }

    #[test]
    fn production_service_name_is_never_used_by_tests() {
        assert_ne!(TEST_SERVICE, SERVICE);
    }
}
