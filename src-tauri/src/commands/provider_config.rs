// provider_config.rs — non-secret Engine B provider settings (D10,
// Implementation_Plan.md §0). One config record (kind/base_url/model)
// covers Remote, Ollama, and custom-local providers via the same
// OpenAI-compatible HTTP client (T5) — this file only owns reading and
// writing that record, never the API key (secrets.rs owns that).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Remote,
    Ollama,
    CustomLocal,
}

impl ProviderKind {
    /// Only Remote needs a Keychain-backed API key (secrets.rs); local
    /// providers accept unauthenticated requests to a loopback endpoint.
    pub fn needs_key(self) -> bool {
        matches!(self, ProviderKind::Remote)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
}

/// Prefill values for the Settings picker (§8.3) when the user switches
/// providers — not the same thing as the currently-persisted config.
pub fn preset(kind: ProviderKind) -> ProviderConfig {
    match kind {
        ProviderKind::Remote => ProviderConfig {
            kind,
            base_url: String::new(),
            model: String::new(),
        },
        ProviderKind::Ollama => ProviderConfig {
            kind,
            base_url: "http://localhost:11434/v1".to_string(),
            // qwen3:4b is D3's recommendation, but T0 ratified gemma4:latest
            // as this dev environment's actual available default (no
            // qwen3:4b pulled locally) — a real pull is the user's call, not
            // this build's.
            model: "gemma4:latest".to_string(),
        },
        ProviderKind::CustomLocal => ProviderConfig {
            kind,
            base_url: "http://localhost:8080/v1".to_string(),
            model: String::new(),
        },
    }
}

impl Default for ProviderConfig {
    fn default() -> Self {
        preset(ProviderKind::Ollama)
    }
}

const CONFIG_FILE: &str = "provider-config.json";

/// On-disk shape. `active` is flattened so the file stays byte-compatible
/// with the original single-record format (and old builds reading a new
/// file simply ignore `saved`). `saved` remembers the last config written
/// per kind, so switching providers (e.g. via the Generate picker) never
/// erases the other provider's endpoint/model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ConfigStore {
    #[serde(flatten)]
    active: ProviderConfig,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    saved: HashMap<ProviderKind, ProviderConfig>,
}

impl Default for ConfigStore {
    fn default() -> Self {
        ConfigStore {
            active: ProviderConfig::default(),
            saved: HashMap::new(),
        }
    }
}

fn read_store(dir: &Path) -> ConfigStore {
    let path = dir.join(CONFIG_FILE);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn read_config(dir: &Path) -> ProviderConfig {
    read_store(dir).active
}

fn write_config(dir: &Path, config: &ProviderConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut store = read_store(dir);
    store.active = config.clone();
    store.saved.insert(config.kind, config.clone());
    let path = dir.join(CONFIG_FILE);
    let json = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// The config to prefill/use when switching to `kind`: the active config if
/// it already is that kind (covers pre-`saved` legacy files), else the last
/// config saved for that kind, else the plan preset.
fn saved_config(dir: &Path, kind: ProviderKind) -> ProviderConfig {
    let store = read_store(dir);
    if store.active.kind == kind {
        return store.active;
    }
    store.saved.get(&kind).cloned().unwrap_or_else(|| preset(kind))
}

#[tauri::command]
pub fn get_provider_config(app: tauri::AppHandle) -> Result<ProviderConfig, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(read_config(&dir))
}

#[tauri::command]
pub fn set_provider_config(app: tauri::AppHandle, config: ProviderConfig) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    write_config(&dir, &config)
}

#[tauri::command]
pub fn get_saved_provider_config(
    app: tauri::AppHandle,
    kind: ProviderKind,
) -> Result<ProviderConfig, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(saved_config(&dir, kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_config_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "roundtrip"
        ));
        let _ = fs::remove_dir_all(&dir);

        // A fresh store instance (nothing ever written) falls back to the
        // Ollama-preset default rather than erroring.
        let initial = read_config(&dir);
        assert_eq!(initial, ProviderConfig::default());

        let custom = ProviderConfig {
            kind: ProviderKind::CustomLocal,
            base_url: "http://localhost:9090/v1".to_string(),
            model: "test-model".to_string(),
        };
        write_config(&dir, &custom).expect("write_config failed");

        // Re-read from a fresh call (simulating a fresh store instance) must
        // see exactly what was written.
        let reread = read_config(&dir);
        assert_eq!(reread, custom);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn switching_kinds_remembers_each_providers_config() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "saved-map"
        ));
        let _ = fs::remove_dir_all(&dir);

        let remote = ProviderConfig {
            kind: ProviderKind::Remote,
            base_url: "https://api.cerebras.ai/v1".to_string(),
            model: "llama3.1-8b".to_string(),
        };
        write_config(&dir, &remote).expect("write remote");

        // Switch to Ollama — the remote record must survive the switch.
        let ollama = preset(ProviderKind::Ollama);
        write_config(&dir, &ollama).expect("write ollama");
        assert_eq!(read_config(&dir), ollama);
        assert_eq!(saved_config(&dir, ProviderKind::Remote), remote);

        // A kind never written falls back to its preset.
        assert_eq!(
            saved_config(&dir, ProviderKind::CustomLocal),
            preset(ProviderKind::CustomLocal)
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_single_record_file_still_parses() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "legacy"
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // The pre-`saved` on-disk format: exactly the flat ProviderConfig.
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"kind":"remote","base_url":"https://api.cerebras.ai/v1","model":"llama3.1-8b"}"#,
        )
        .unwrap();

        let active = read_config(&dir);
        assert_eq!(active.kind, ProviderKind::Remote);
        assert_eq!(active.base_url, "https://api.cerebras.ai/v1");
        // Even with an empty saved map, asking for the active kind returns
        // the active record, not the (empty) remote preset.
        assert_eq!(saved_config(&dir, ProviderKind::Remote), active);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn presets_match_plan_defaults() {
        assert_eq!(preset(ProviderKind::Remote).base_url, "");
        assert_eq!(preset(ProviderKind::Ollama).base_url, "http://localhost:11434/v1");
        assert_eq!(preset(ProviderKind::CustomLocal).base_url, "http://localhost:8080/v1");
        assert!(ProviderKind::Remote.needs_key());
        assert!(!ProviderKind::Ollama.needs_key());
        assert!(!ProviderKind::CustomLocal.needs_key());
    }
}
