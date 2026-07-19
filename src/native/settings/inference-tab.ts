// inference-tab.ts — Inference tab form logic (§8.2/§8.3).
//
// This module bundles alone into settings.html: it never imports the
// viewport, store, or engine modules, so there is nothing here to leak even
// by accident. The one hard rule: the raw API key value is read from the
// input INSIDE the save handler and never assigned to any module-level or
// closure variable that outlives it — it must not linger in the webview's
// JS heap past the moment it's sent to Rust.
//
// Two-level identity (mirrors provider_config.rs): the Generation Engine
// select chooses the kind (what the Generate picker also chooses between);
// the Provider select chooses the concrete profile within it. Remote has
// three providers, each with its own Keychain key slot; the local engines
// have exactly one provider each.

import { invoke } from '@tauri-apps/api/core';

type EngineKind = 'remote' | 'ollama' | 'custom-local';
type Provider = 'cerebras' | 'xiaomi' | 'openrouter' | 'llama-cpp' | 'ollama';

interface ProviderConfig {
  kind: EngineKind;
  provider: Provider;
  base_url: string;
  model: string;
}

/** Sentinel option value for the free-text model field. */
const CUSTOM_MODEL = '__custom__';

// Mirrors src-tauri/src/commands/provider_config.rs::preset_for() — kept in
// sync manually since this is presentation-only prefill, not the source of
// truth (Rust owns the persisted config; its provider_serde_names test pins
// the wire strings). Model lists are curated (user-ratified 2026-07-17);
// "Other…" always allows a model not listed here.
const PROVIDERS: Record<
  Provider,
  { label: string; kind: EngineKind; base_url: string; models: string[] }
> = {
  cerebras: {
    label: 'Cerebras',
    kind: 'remote',
    base_url: 'https://api.cerebras.ai/v1',
    models: ['gemma-4-31b', 'gpt-oss-120b', 'zai-glm-4.7'],
  },
  xiaomi: {
    label: 'Xiaomi',
    kind: 'remote',
    base_url: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'remote',
    // The Rust client appends /chat/completions itself — the bare /api/v1
    // root, never the full endpoint path.
    base_url: 'https://openrouter.ai/api/v1',
    models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'xiaomi/mimo-v2.5', 'z-ai/glm-5.2'],
  },
  'llama-cpp': {
    label: 'Llama.cpp',
    kind: 'custom-local',
    base_url: 'http://127.0.0.1:8080',
    models: [
      'yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q4_K_M',
      'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_XL',
    ],
  },
  ollama: {
    label: 'Ollama',
    kind: 'ollama',
    base_url: 'http://localhost:11434/v1',
    models: ['gemma4:latest', 'qwen3-coder:latest'],
  },
};

const ENGINE_PROVIDERS: Record<EngineKind, Provider[]> = {
  remote: ['cerebras', 'xiaomi', 'openrouter'],
  'custom-local': ['llama-cpp'],
  ollama: ['ollama'],
};

export function initInferenceTab(): void {
  function el<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`inference-tab: missing #${id}`);
    return found as T;
  }

  const engineSelect = el<HTMLSelectElement>('engine');
  const providerSelect = el<HTMLSelectElement>('provider');
  const baseUrlInput = el<HTMLInputElement>('base-url');
  const modelSelect = el<HTMLSelectElement>('model');
  const modelCustomRow = el<HTMLDivElement>('model-custom-row');
  const modelCustomInput = el<HTMLInputElement>('model-custom');
  const keyRow = el<HTMLDivElement>('key-row');
  const apiKeyInput = el<HTMLInputElement>('api-key');
  const saveButton = el<HTMLButtonElement>('save');
  const removeKeyButton = el<HTMLButtonElement>('remove-key');
  const statusLine = el<HTMLDivElement>('status-line');

  function currentEngine(): EngineKind {
    return engineSelect.value as EngineKind;
  }

  function currentProvider(): Provider {
    return providerSelect.value as Provider;
  }

  function rebuildProviderOptions(engine: EngineKind, selected?: Provider): void {
    providerSelect.replaceChildren(
      ...ENGINE_PROVIDERS[engine].map((p) => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = PROVIDERS[p].label;
        return opt;
      }),
    );
    providerSelect.value = selected && PROVIDERS[selected].kind === engine
      ? selected
      : ENGINE_PROVIDERS[engine][0];
    // A single-provider engine still shows the row (the profile name is
    // information), but a choice of one is not a choice.
    providerSelect.disabled = ENGINE_PROVIDERS[engine].length === 1;
  }

  /** Fill the model dropdown for `provider`; `model` lands on its list entry
      or on "Other…" + the free-text field when it isn't curated. */
  function rebuildModelOptions(provider: Provider, model: string): void {
    const options = PROVIDERS[provider].models.map((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      return opt;
    });
    const custom = document.createElement('option');
    custom.value = CUSTOM_MODEL;
    custom.textContent = 'Other…';
    modelSelect.replaceChildren(...options, custom);

    if (model && !PROVIDERS[provider].models.includes(model)) {
      modelSelect.value = CUSTOM_MODEL;
      modelCustomInput.value = model;
    } else {
      modelSelect.value = model || PROVIDERS[provider].models[0];
      modelCustomInput.value = '';
    }
    updateCustomModelVisibility();
  }

  function updateCustomModelVisibility(): void {
    modelCustomRow.hidden = modelSelect.value !== CUSTOM_MODEL;
  }

  function selectedModel(): string {
    return modelSelect.value === CUSTOM_MODEL ? modelCustomInput.value.trim() : modelSelect.value;
  }

  function updateKeyFieldVisibility(): void {
    keyRow.hidden = currentEngine() !== 'remote';
  }

  async function refreshKeyStatus(): Promise<void> {
    if (currentEngine() !== 'remote') {
      removeKeyButton.hidden = true;
      statusLine.textContent = '';
      return;
    }
    const hasKey = await invoke<boolean>('get_api_key_status', { provider: currentProvider() });
    statusLine.textContent = hasKey ? 'API key saved ✓' : 'No key set';
    removeKeyButton.hidden = !hasKey;
  }

  /** Reflect a config record into every field. */
  function applyConfig(config: ProviderConfig): void {
    engineSelect.value = config.kind;
    rebuildProviderOptions(config.kind, config.provider);
    baseUrlInput.value = config.base_url;
    rebuildModelOptions(config.provider, config.model);
    updateKeyFieldVisibility();
  }

  async function loadConfig(): Promise<void> {
    const config = await invoke<ProviderConfig>('get_provider_config');
    applyConfig(config);
    await refreshKeyStatus();
  }

  /** Switching provider (or engine) prefills from the last saved profile for
      that provider — Rust falls back to the preset when none was saved — so
      flipping Cerebras → OpenRouter → Cerebras round-trips your edits. */
  async function switchToProvider(provider: Provider): Promise<void> {
    const config = await invoke<ProviderConfig>('get_saved_provider_profile', { provider });
    applyConfig(config);
    await refreshKeyStatus();
  }

  engineSelect.addEventListener('change', () => {
    void switchToProvider(ENGINE_PROVIDERS[currentEngine()][0]);
  });

  providerSelect.addEventListener('change', () => {
    void switchToProvider(currentProvider());
  });

  modelSelect.addEventListener('change', updateCustomModelVisibility);

  async function handleSave(): Promise<void> {
    const kind = currentEngine();
    const provider = currentProvider();
    const config: ProviderConfig = {
      kind,
      provider,
      base_url: baseUrlInput.value,
      model: selectedModel(),
    };
    await invoke('set_provider_config', { config });

    if (kind === 'remote' && apiKeyInput.value) {
      await invoke('save_api_key', { key: apiKeyInput.value, provider });
      apiKeyInput.value = '';
    }

    await refreshKeyStatus();
  }

  saveButton.addEventListener('click', () => {
    void handleSave();
  });

  async function handleRemoveKey(): Promise<void> {
    await invoke('delete_api_key', { provider: currentProvider() });
    await refreshKeyStatus();
  }

  removeKeyButton.addEventListener('click', () => {
    void handleRemoveKey();
  });

  void loadConfig();
}
