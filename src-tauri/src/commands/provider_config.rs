// provider_config.rs — non-secret Engine B provider settings (D10,
// Implementation_Plan.md §0). One config record (kind/provider/base_url/
// model) covers every generation engine via the same OpenAI-compatible
// HTTP client (T5) — this file only owns reading and writing that record,
// never the API key (secrets.rs owns that).
//
// Two-level identity: `kind` is the Generation Engine (what the picker
// modal chooses between); `provider` is the concrete profile within it
// (Remote → cerebras/xiaomi/openrouter; the local kinds each have exactly
// one provider). Files written before `provider` existed normalize on
// read: a missing or kind-mismatched provider becomes the kind's default.

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

    /// The provider a config of this kind falls back to when the file
    /// predates the `provider` field (or carries one from the wrong kind).
    /// Cerebras is the remote default because pre-provider installs were
    /// Cerebras-validated — their saved key and URL belong to it.
    pub fn default_provider(self) -> Provider {
        match self {
            ProviderKind::Remote => Provider::Cerebras,
            ProviderKind::Ollama => Provider::Ollama,
            ProviderKind::CustomLocal => Provider::LlamaCpp,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Cerebras,
    Xiaomi,
    Openrouter,
    LlamaCpp,
    Ollama,
}

impl Provider {
    pub fn kind(self) -> ProviderKind {
        match self {
            Provider::Cerebras | Provider::Xiaomi | Provider::Openrouter => ProviderKind::Remote,
            Provider::LlamaCpp => ProviderKind::CustomLocal,
            Provider::Ollama => ProviderKind::Ollama,
        }
    }
}

fn legacy_default_provider() -> Provider {
    // Placeholder for files that predate `provider`; read paths always
    // re-normalize against `kind`, so this value only survives when the
    // kind really is Remote (the pre-provider Cerebras-validated setup).
    Provider::Cerebras
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    #[serde(default = "legacy_default_provider")]
    pub provider: Provider,
    pub base_url: String,
    pub model: String,
}

impl ProviderConfig {
    /// Repair records whose `provider` is missing (serde default) or
    /// contradicts `kind` (hand-edited file): the kind wins, and the
    /// provider falls back to the kind's default.
    fn normalized(mut self) -> Self {
        if self.provider.kind() != self.kind {
            self.provider = self.kind.default_provider();
        }
        self
    }
}

/// Prefill values for the Settings picker (§8.3) when the user switches
/// providers — not the same thing as the currently-persisted config. The
/// model is the first entry of the settings UI's curated list for that
/// provider (the full lists are presentation-only and live in
/// settings-form.ts).
pub fn preset_for(provider: Provider) -> ProviderConfig {
    let (base_url, model) = match provider {
        Provider::Cerebras => ("https://api.cerebras.ai/v1", "gemma-4-31b"),
        Provider::Xiaomi => ("https://api.xiaomimimo.com/v1", "mimo-v2.5-pro"),
        // The client appends /chat/completions itself (llm_client.rs), so
        // this stays the bare /api/v1 root — never the full endpoint path.
        Provider::Openrouter => (
            "https://openrouter.ai/api/v1",
            "nvidia/nemotron-3-ultra-550b-a55b:free",
        ),
        Provider::LlamaCpp => (
            "http://127.0.0.1:8080",
            "yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q4_K_M",
        ),
        // qwen3:4b is D3's recommendation, but T0 ratified gemma4:latest
        // as this dev environment's actual available default (no qwen3:4b
        // pulled locally) — a real pull is the user's call, not this
        // build's.
        Provider::Ollama => ("http://localhost:11434/v1", "gemma4:latest"),
    };
    ProviderConfig {
        kind: provider.kind(),
        provider,
        base_url: base_url.to_string(),
        model: model.to_string(),
    }
}

pub fn preset(kind: ProviderKind) -> ProviderConfig {
    preset_for(kind.default_provider())
}

impl Default for ProviderConfig {
    fn default() -> Self {
        preset(ProviderKind::Ollama)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTemplate {
    pub id: String,
    pub name: String,
    pub text: String,
}

/// Non-secret, non-interpreted prompt-template selection state (Task 8's TS
/// `PromptTemplatesConfig` mirror). Rust only stores/returns these strings —
/// it never validates or interprets their content.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplates {
    /// Builtin id or custom id; empty string = "general" (frontend resolves).
    #[serde(default)]
    pub selected: String,
    /// builtin id -> user-tweaked text. Absent key = shipped default text,
    /// so app updates to shipped templates reach untweaked users.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub overrides: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom: Vec<CustomTemplate>,
}

fn is_default_templates(t: &PromptTemplates) -> bool {
    *t == PromptTemplates::default()
}

const CONFIG_FILE: &str = "provider-config.json";

/// On-disk shape. `active` is flattened so the file stays byte-compatible
/// with the original single-record format (and old builds reading a new
/// file simply ignore the extra maps). `saved` remembers the last config
/// written per kind (what the Generate picker restores when switching
/// engines); `saved_providers` remembers per concrete provider, so
/// switching Cerebras → OpenRouter → Cerebras round-trips the Cerebras
/// URL/model. A future "user-defined providers" editor extends
/// `saved_providers` without another schema change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ConfigStore {
    #[serde(flatten)]
    active: ProviderConfig,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    saved: HashMap<ProviderKind, ProviderConfig>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    saved_providers: HashMap<Provider, ProviderConfig>,
    #[serde(default, skip_serializing_if = "is_default_templates")]
    prompt_templates: PromptTemplates,
}

impl Default for ConfigStore {
    fn default() -> Self {
        ConfigStore {
            active: ProviderConfig::default(),
            saved: HashMap::new(),
            saved_providers: HashMap::new(),
            prompt_templates: PromptTemplates::default(),
        }
    }
}

fn read_store(dir: &Path) -> ConfigStore {
    let mut store: ConfigStore = fs::read_to_string(dir.join(CONFIG_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    store.active = store.active.normalized();
    for v in store.saved.values_mut() {
        *v = v.clone().normalized();
    }
    for v in store.saved_providers.values_mut() {
        *v = v.clone().normalized();
    }
    store
}

fn read_config(dir: &Path) -> ProviderConfig {
    read_store(dir).active
}

fn write_config(dir: &Path, config: &ProviderConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let config = config.clone().normalized();
    let mut store = read_store(dir);
    store.active = config.clone();
    store.saved.insert(config.kind, config.clone());
    store.saved_providers.insert(config.provider, config);
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

/// Same idea one level down: the config to prefill when the Settings
/// dialog switches to `provider` — last saved for that provider, else its
/// preset. The active record wins when it already is that provider (covers
/// files from before `saved_providers` existed).
fn saved_provider_profile(dir: &Path, provider: Provider) -> ProviderConfig {
    let store = read_store(dir);
    if store.active.provider == provider {
        return store.active;
    }
    store
        .saved_providers
        .get(&provider)
        .cloned()
        .unwrap_or_else(|| preset_for(provider))
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

#[tauri::command]
pub fn get_saved_provider_profile(
    app: tauri::AppHandle,
    provider: Provider,
) -> Result<ProviderConfig, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(saved_provider_profile(&dir, provider))
}

#[tauri::command]
pub fn get_prompt_templates(app: tauri::AppHandle) -> Result<PromptTemplates, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(read_store(&dir).prompt_templates)
}

/// Mutates ONLY `prompt_templates` — `active`/`saved`/`saved_providers` are
/// read back untouched and rewritten as-is, unlike `write_config` which
/// rebuilds `active`/`saved`/`saved_providers` for a provider switch.
#[tauri::command]
pub fn set_prompt_templates(
    app: tauri::AppHandle,
    templates: PromptTemplates,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut store = read_store(&dir);
    store.prompt_templates = templates;
    let path = dir.join(CONFIG_FILE);
    let json = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
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
            provider: Provider::LlamaCpp,
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
            provider: Provider::Cerebras,
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
    fn switching_remote_providers_remembers_each_profile() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "provider-map"
        ));
        let _ = fs::remove_dir_all(&dir);

        let cerebras = ProviderConfig {
            kind: ProviderKind::Remote,
            provider: Provider::Cerebras,
            base_url: "https://api.cerebras.ai/v1".to_string(),
            model: "zai-glm-4.7".to_string(), // deliberately not the preset
        };
        write_config(&dir, &cerebras).expect("write cerebras");

        // Switch to OpenRouter (same kind!) — Cerebras profile must survive.
        let openrouter = preset_for(Provider::Openrouter);
        write_config(&dir, &openrouter).expect("write openrouter");
        assert_eq!(read_config(&dir), openrouter);
        assert_eq!(saved_provider_profile(&dir, Provider::Cerebras), cerebras);

        // The kind-level record reflects the LAST remote provider written.
        assert_eq!(saved_config(&dir, ProviderKind::Remote), openrouter);

        // A provider never written falls back to its preset.
        assert_eq!(
            saved_provider_profile(&dir, Provider::Xiaomi),
            preset_for(Provider::Xiaomi)
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

        // The pre-`saved` on-disk format: exactly the flat ProviderConfig,
        // with no `provider` field at all.
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"kind":"remote","base_url":"https://api.cerebras.ai/v1","model":"llama3.1-8b"}"#,
        )
        .unwrap();

        let active = read_config(&dir);
        assert_eq!(active.kind, ProviderKind::Remote);
        assert_eq!(active.base_url, "https://api.cerebras.ai/v1");
        // Pre-provider remote installs were Cerebras — the normalized
        // record must claim their key and settings for Cerebras.
        assert_eq!(active.provider, Provider::Cerebras);
        // Even with an empty saved map, asking for the active kind returns
        // the active record, not the (empty) remote preset.
        assert_eq!(saved_config(&dir, ProviderKind::Remote), active);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_ollama_file_normalizes_provider_to_its_kind() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "legacy-ollama"
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // A provider-less ollama record must NOT come back as Cerebras
        // (the bare serde default) — normalization repairs it by kind.
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"kind":"ollama","base_url":"http://localhost:11434/v1","model":"gemma4:latest"}"#,
        )
        .unwrap();

        assert_eq!(read_config(&dir).provider, Provider::Ollama);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn presets_match_plan_defaults() {
        assert_eq!(preset(ProviderKind::Remote).base_url, "https://api.cerebras.ai/v1");
        assert_eq!(preset(ProviderKind::Remote).provider, Provider::Cerebras);
        assert_eq!(preset(ProviderKind::Ollama).base_url, "http://localhost:11434/v1");
        assert_eq!(preset(ProviderKind::CustomLocal).base_url, "http://127.0.0.1:8080");
        assert!(ProviderKind::Remote.needs_key());
        assert!(!ProviderKind::Ollama.needs_key());
        assert!(!ProviderKind::CustomLocal.needs_key());
    }

    #[test]
    fn prompt_templates_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "prompt-templates"
        ));
        let _ = fs::remove_dir_all(&dir);

        let mut overrides = HashMap::new();
        overrides.insert("general".to_string(), "tweaked general text".to_string());
        let templates = PromptTemplates {
            selected: "prd".to_string(),
            overrides,
            custom: vec![CustomTemplate {
                id: "custom-1".to_string(),
                name: "My Template".to_string(),
                text: "Custom template text".to_string(),
            }],
        };

        let mut store = read_store(&dir);
        store.prompt_templates = templates.clone();
        fs::create_dir_all(&dir).unwrap();
        let json = serde_json::to_string_pretty(&store).unwrap();
        fs::write(dir.join(CONFIG_FILE), json).unwrap();

        let reread = read_store(&dir);
        assert_eq!(reread.prompt_templates, templates);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pre_template_config_file_reads_clean() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "pre-template"
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // A file written before `prompt_templates` existed: exactly the
        // flattened active config, no `promptTemplates` key at all.
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"kind":"remote","base_url":"https://api.cerebras.ai/v1","model":"llama3.1-8b"}"#,
        )
        .unwrap();

        let store = read_store(&dir);
        assert_eq!(store.active.kind, ProviderKind::Remote);
        assert_eq!(store.active.base_url, "https://api.cerebras.ai/v1");
        assert_eq!(store.active.provider, Provider::Cerebras);
        assert_eq!(store.prompt_templates, PromptTemplates::default());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn provider_serde_names_are_kebab_case() {
        // The TS mirror in settings-form.ts hardcodes these strings — this
        // test pins the wire format so a rename can't silently drift.
        for (p, s) in [
            (Provider::Cerebras, "\"cerebras\""),
            (Provider::Xiaomi, "\"xiaomi\""),
            (Provider::Openrouter, "\"openrouter\""),
            (Provider::LlamaCpp, "\"llama-cpp\""),
            (Provider::Ollama, "\"ollama\""),
        ] {
            assert_eq!(serde_json::to_string(&p).unwrap(), s);
        }
    }
}
