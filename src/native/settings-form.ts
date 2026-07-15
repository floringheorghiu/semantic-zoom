// settings-form.ts — Settings window form logic (§8.2/§8.3).
//
// This module bundles alone into settings.html: it never imports the
// viewport, store, or engine modules, so there is nothing here to leak even
// by accident. The one hard rule: the raw API key value is read from the
// input INSIDE the save handler and never assigned to any module-level or
// closure variable that outlives it — it must not linger in the webview's
// JS heap past the moment it's sent to Rust.

import { invoke } from '@tauri-apps/api/core';

type ProviderKind = 'remote' | 'ollama' | 'custom-local';

interface ProviderConfig {
  kind: ProviderKind;
  base_url: string;
  model: string;
}

// Mirrors src-tauri/src/commands/provider_config.rs::preset() — kept in
// sync manually since this is presentation-only prefill, not the source of
// truth (Rust owns the persisted config).
const PRESETS: Record<ProviderKind, Omit<ProviderConfig, 'kind'>> = {
  remote: { base_url: '', model: '' },
  ollama: { base_url: 'http://localhost:11434/v1', model: 'gemma4:latest' },
  'custom-local': { base_url: 'http://localhost:8080/v1', model: '' },
};

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`settings-form: missing #${id}`);
  return found as T;
}

const providerSelect = el<HTMLSelectElement>('provider');
const baseUrlInput = el<HTMLInputElement>('base-url');
const modelInput = el<HTMLInputElement>('model');
const keyRow = el<HTMLDivElement>('key-row');
const apiKeyInput = el<HTMLInputElement>('api-key');
const saveButton = el<HTMLButtonElement>('save');
const removeKeyButton = el<HTMLButtonElement>('remove-key');
const statusLine = el<HTMLDivElement>('status-line');

function updateKeyFieldVisibility(): void {
  keyRow.hidden = providerSelect.value !== 'remote';
}

async function refreshKeyStatus(): Promise<void> {
  if (providerSelect.value !== 'remote') {
    removeKeyButton.hidden = true;
    statusLine.textContent = '';
    return;
  }
  const hasKey = await invoke<boolean>('get_api_key_status');
  statusLine.textContent = hasKey ? 'API key saved ✓' : 'No key set';
  removeKeyButton.hidden = !hasKey;
}

async function loadConfig(): Promise<void> {
  const config = await invoke<ProviderConfig>('get_provider_config');
  providerSelect.value = config.kind;
  baseUrlInput.value = config.base_url;
  modelInput.value = config.model;
  updateKeyFieldVisibility();
  await refreshKeyStatus();
}

providerSelect.addEventListener('change', () => {
  const preset = PRESETS[providerSelect.value as ProviderKind];
  baseUrlInput.value = preset.base_url;
  modelInput.value = preset.model;
  updateKeyFieldVisibility();
  void refreshKeyStatus();
});

async function handleSave(): Promise<void> {
  const kind = providerSelect.value as ProviderKind;
  const config: ProviderConfig = { kind, base_url: baseUrlInput.value, model: modelInput.value };
  await invoke('set_provider_config', { config });

  if (kind === 'remote' && apiKeyInput.value) {
    await invoke('save_api_key', { key: apiKeyInput.value });
    apiKeyInput.value = '';
  }

  await refreshKeyStatus();
}

saveButton.addEventListener('click', () => {
  void handleSave();
});

async function handleRemoveKey(): Promise<void> {
  await invoke('delete_api_key');
  await refreshKeyStatus();
}

removeKeyButton.addEventListener('click', () => {
  void handleRemoveKey();
});

void loadConfig();
