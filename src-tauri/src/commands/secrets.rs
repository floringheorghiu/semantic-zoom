// secrets.rs — Rust-owned API key storage (D9/D10, Implementation_Plan.md §8.2).
//
// The key must never exist in JS state longer than the instant it's typed.
// `get_api_key_status` returns a bool ONLY — the key string never crosses
// into a #[tauri::command] return type, so it never reaches the webview.
//
// One Keychain entry PER remote provider (cerebras/xiaomi/openrouter), so
// switching providers never overwrites another provider's key. Cerebras
// keeps the original service name: pre-provider installs saved their key
// there and were Cerebras-validated, so the existing entry keeps working
// with zero migration.

use crate::commands::provider_config::Provider;
use keyring::Entry;
use security_framework::item::{ItemClass, ItemSearchOptions};

const SERVICE: &str = "com.semantic-zoom.llm-api-key";
/// The `keyring::Entry` account/user field every entry in this file uses —
/// shared with `status_for`'s raw `ItemSearchOptions` query so the two never
/// drift and silently search different items.
const ACCOUNT: &str = "default";

fn service_for_provider(provider: Provider) -> String {
    match provider {
        // Legacy name — the pre-provider entry, claimed by Cerebras.
        Provider::Cerebras => SERVICE.to_string(),
        // Local providers never call this (needs_key() is false for their
        // kinds), but a total match beats a panic if one ever does.
        p => {
            let name = match p {
                Provider::Cerebras => unreachable!(),
                Provider::Xiaomi => "xiaomi",
                Provider::Openrouter => "openrouter",
                Provider::LlamaCpp => "llama-cpp",
                Provider::Ollama => "ollama",
            };
            format!("{SERVICE}.{name}")
        }
    }
}

// Service-parameterized internals so tests can exercise the identical
// keyring plumbing against a THROWAWAY service name. Tests must never touch
// `SERVICE`: a `cargo test` run once deleted the user's real production key
// (2026-07-16) because the round-trip test cleaned up the real entry.
fn entry_for(service: &str) -> Result<Entry, String> {
    Entry::new(service, ACCOUNT).map_err(|e| e.to_string())
}

fn save_for(service: &str, key: &str) -> Result<(), String> {
    entry_for(service)?.set_password(key).map_err(|e| e.to_string())
}

/// Whether a key is configured, WITHOUT reading it. `keyring::Entry` only
/// exposes "get the password" (which decrypts the secret) — on macOS that's
/// exactly the operation the OS gates behind the "wants to use your
/// confidential information" consent dialog, so a naive `get_password().is_ok()`
/// status check prompts on every app launch (`refreshProviderStatus` in
/// main.ts runs it unconditionally at startup) even when nothing is ever
/// generated. Attribute-only queries (`load_data(false)`) via the modern
/// `SecItemCopyMatching` API (here, `security_framework::item`) can confirm
/// existence without ever decrypting `kSecValueData`, so macOS does not
/// prompt for them. `save_for`/`get_key_for` are untouched — they legitimately
/// need the real secret, and consent there is meaningful.
fn status_for(service: &str) -> bool {
    ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .account(ACCOUNT)
        .load_attributes(true) // required: SecItemCopyMatching segfaults with no load_* set
        .load_data(false)
        .limit(1)
        .search()
        .map(|results| !results.is_empty())
        .unwrap_or(false)
}

fn delete_for(service: &str) -> Result<(), String> {
    entry_for(service)?.delete_credential().map_err(|e| e.to_string())
}

/// `provider` is optional on all three commands so pre-provider callers
/// (and the picker flow, which never touches keys) keep working; a missing
/// provider means the legacy Cerebras slot.
fn resolve_service(provider: Option<Provider>) -> String {
    service_for_provider(provider.unwrap_or(Provider::Cerebras))
}

#[tauri::command]
pub fn save_api_key(key: String, provider: Option<Provider>) -> Result<(), String> {
    save_for(&resolve_service(provider), &key)
}

#[tauri::command]
pub fn get_api_key_status(provider: Option<Provider>) -> bool {
    status_for(&resolve_service(provider))
}

#[tauri::command]
pub fn delete_api_key(provider: Option<Provider>) -> Result<(), String> {
    delete_for(&resolve_service(provider))
}

/// Rust-internal accessor for the raw key — used by T5's `llm_complete`
/// command to build the Authorization header. Never exposed as a
/// #[tauri::command]; the key must not have a JS-callable path back out.
pub(crate) fn get_api_key(provider: Provider) -> Result<String, String> {
    get_key_for(&service_for_provider(provider))
}

fn get_key_for(service: &str) -> Result<String, String> {
    entry_for(service)?
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
        for p in [
            Provider::Cerebras,
            Provider::Xiaomi,
            Provider::Openrouter,
        ] {
            assert_ne!(TEST_SERVICE, service_for_provider(p));
        }
    }

    #[test]
    fn cerebras_claims_the_legacy_service_name() {
        // Existing installs saved their key under the bare service name
        // while validated against Cerebras — that entry must stay theirs.
        assert_eq!(service_for_provider(Provider::Cerebras), SERVICE);
        assert_eq!(
            service_for_provider(Provider::Xiaomi),
            "com.semantic-zoom.llm-api-key.xiaomi"
        );
        assert_eq!(
            service_for_provider(Provider::Openrouter),
            "com.semantic-zoom.llm-api-key.openrouter"
        );
    }

    /// Per-message test for the missing-key path: this exact string is what
    /// `llm_complete` surfaces to the UI when a remote provider is selected
    /// with no key saved, so it is user-facing copy, not an internal detail.
    /// Exercised via `get_key_for` on the throwaway service — same code path
    /// `get_api_key()` delegates to, without touching the production entry.
    #[test]
    fn missing_key_yields_the_no_api_key_configured_message() {
        let _guard = KEYCHAIN_LOCK.lock().unwrap();

        let _ = delete_for(TEST_SERVICE);

        let err = get_key_for(TEST_SERVICE).expect_err("expected an error with no key saved");
        assert_eq!(err, "No API key configured");
    }
}
