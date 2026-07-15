// provider_config.rs — non-secret Engine B provider settings (D10,
// Implementation_Plan.md §0). One config record (kind/base_url/model)
// covers Remote, Ollama, and custom-local providers via the same
// OpenAI-compatible HTTP client (T5) — this file only owns reading and
// writing that record, never the API key (secrets.rs owns that).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

fn read_config(dir: &Path) -> ProviderConfig {
    let path = dir.join(CONFIG_FILE);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(dir: &Path, config: &ProviderConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(CONFIG_FILE);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
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
    fn presets_match_plan_defaults() {
        assert_eq!(preset(ProviderKind::Remote).base_url, "");
        assert_eq!(preset(ProviderKind::Ollama).base_url, "http://localhost:11434/v1");
        assert_eq!(preset(ProviderKind::CustomLocal).base_url, "http://localhost:8080/v1");
        assert!(ProviderKind::Remote.needs_key());
        assert!(!ProviderKind::Ollama.needs_key());
        assert!(!ProviderKind::CustomLocal.needs_key());
    }
}
