// prompt-tab.ts — Prompt tab: template picker + editable editorial-text
// editor (§Task 9). Consumes `BUILTIN_TEMPLATES` (the shipped editorial
// layer from synthesis-prompt.mjs) and Task 7's `get_prompt_templates` /
// `set_prompt_templates` Rust commands. The dropdown IS the global default
// picker — whichever template is selected when Save/Restore/Delete runs
// becomes `config.selected`, same value `resolveTemplate()` (Task 8) falls
// back to when a document has no per-doc template id.
//
// Bundles alone into settings.html, same discipline as inference-tab.ts /
// general-tab.ts: never imports the viewport, store, or engine modules.

import { invoke } from '@tauri-apps/api/core';
import { BUILTIN_TEMPLATES } from '../zoom-tools/synthesis-prompt.mjs';
import type { PromptTemplatesConfig } from '../template-resolve';

/** Sentinel option value for "Add custom…" — same pattern as the model
    dropdown's `__custom__` in inference-tab.ts. */
const ADD_CUSTOM = '__add__';

function defaultConfig(): PromptTemplatesConfig {
  return { selected: 'general', overrides: {}, custom: [] };
}

export async function initPromptTab(): Promise<void> {
  function el<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`prompt-tab: missing #${id}`);
    return found as T;
  }

  const select = el<HTMLSelectElement>('template-select');
  const textarea = el<HTMLTextAreaElement>('template-text');
  const saveButton = el<HTMLButtonElement>('template-save');
  const restoreButton = el<HTMLButtonElement>('template-restore');
  const deleteButton = el<HTMLButtonElement>('template-delete');

  const loaded = await invoke<PromptTemplatesConfig | null>('get_prompt_templates');
  const config: PromptTemplatesConfig = loaded
    ? {
        selected: loaded.selected || 'general',
        overrides: loaded.overrides ?? {},
        custom: loaded.custom ?? [],
      }
    : defaultConfig();

  let currentId = config.selected;

  function isBuiltin(id: string): boolean {
    return BUILTIN_TEMPLATES.some((b) => b.id === id);
  }

  function shippedText(id: string): string | undefined {
    return BUILTIN_TEMPLATES.find((b) => b.id === id)?.text;
  }

  /** overrides[id] ?? builtin.text for builtins; the entry's own text for
      customs. Falls back to General's shipped text if `id` resolves to
      neither (defensive — should not happen in practice). */
  function effectiveText(id: string): string {
    const builtin = shippedText(id);
    if (builtin !== undefined) return config.overrides[id] ?? builtin;
    const custom = config.custom.find((c) => c.id === id);
    if (custom) return custom.text;
    return BUILTIN_TEMPLATES[0].text;
  }

  function buildOptions(): void {
    const options: HTMLOptionElement[] = [];
    for (const b of BUILTIN_TEMPLATES) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.name;
      options.push(opt);
    }
    for (const c of config.custom) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      options.push(opt);
    }
    const add = document.createElement('option');
    add.value = ADD_CUSTOM;
    add.textContent = 'Add custom…';
    options.push(add);
    select.replaceChildren(...options);
  }

  /** Fills the textarea + toggles Restore/Delete for a real (non-sentinel)
      selection, and remembers it as the selection to fall back to if the
      user later opens then cancels "Add custom…". */
  function reflectSelection(id: string): void {
    select.value = id;
    textarea.value = effectiveText(id);
    const builtin = isBuiltin(id);
    restoreButton.hidden = !builtin;
    deleteButton.hidden = builtin;
    currentId = id;
  }

  async function handleAddCustom(): Promise<void> {
    const name = window.prompt('Template name');
    if (!name) {
      reflectSelection(currentId);
      return;
    }
    const entry = { id: crypto.randomUUID(), name, text: effectiveText('general') };
    config.custom.push(entry);
    config.selected = entry.id;
    await invoke('set_prompt_templates', { templates: config });
    buildOptions();
    reflectSelection(entry.id);
  }

  select.addEventListener('change', () => {
    if (select.value === ADD_CUSTOM) {
      void handleAddCustom();
      return;
    }
    reflectSelection(select.value);
  });

  async function handleSave(): Promise<void> {
    const id = select.value;
    if (id === ADD_CUSTOM) return;
    const text = textarea.value;
    const builtin = shippedText(id);
    if (builtin !== undefined) {
      if (text === builtin) delete config.overrides[id];
      else config.overrides[id] = text;
    } else {
      const custom = config.custom.find((c) => c.id === id);
      if (custom) custom.text = text;
    }
    config.selected = id;
    await invoke('set_prompt_templates', { templates: config });
    currentId = id;
  }

  saveButton.addEventListener('click', () => {
    void handleSave();
  });

  async function handleRestore(): Promise<void> {
    const id = select.value;
    delete config.overrides[id];
    await invoke('set_prompt_templates', { templates: config });
    reflectSelection(id);
  }

  restoreButton.addEventListener('click', () => {
    void handleRestore();
  });

  async function handleDelete(): Promise<void> {
    config.custom = config.custom.filter((c) => c.id !== select.value);
    config.selected = 'general';
    await invoke('set_prompt_templates', { templates: config });
    buildOptions();
    reflectSelection('general');
  }

  deleteButton.addEventListener('click', () => {
    void handleDelete();
  });

  buildOptions();
  reflectSelection(currentId);
}
