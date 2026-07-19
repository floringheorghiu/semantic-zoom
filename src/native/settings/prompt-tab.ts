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
  const addCustomForm = el<HTMLDivElement>('template-add-custom');
  const newNameInput = el<HTMLInputElement>('template-new-name');
  const addConfirmButton = el<HTMLButtonElement>('template-add-confirm');
  const addCancelButton = el<HTMLButtonElement>('template-add-cancel');

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

  /** Shows the inline naming form in place of the normal Save/Restore/
      Delete row, disabling the textarea and those buttons so the UI isn't
      ambiguous mid-creation. */
  function showAddCustomForm(): void {
    addCustomForm.hidden = false;
    textarea.disabled = true;
    saveButton.disabled = true;
    restoreButton.disabled = true;
    deleteButton.disabled = true;
    newNameInput.value = '';
    newNameInput.focus();
  }

  function hideAddCustomForm(): void {
    addCustomForm.hidden = true;
    textarea.disabled = false;
    saveButton.disabled = false;
    restoreButton.disabled = false;
    deleteButton.disabled = false;
  }

  /** Cancel path: same as the old window.prompt()-cancel behavior — hide
      the form and fall back to whatever was selected before "Add custom…"
      was chosen. */
  function cancelAddCustom(): void {
    hideAddCustomForm();
    newNameInput.value = '';
    reflectSelection(currentId);
  }

  async function confirmAddCustom(): Promise<void> {
    const name = newNameInput.value.trim();
    if (!name) {
      newNameInput.focus();
      return;
    }
    const entry = { id: crypto.randomUUID(), name, text: effectiveText('general') };
    config.custom.push(entry);
    config.selected = entry.id;
    await invoke('set_prompt_templates', { templates: config });
    buildOptions();
    reflectSelection(entry.id);
    hideAddCustomForm();
  }

  select.addEventListener('change', () => {
    if (select.value === ADD_CUSTOM) {
      // Revert the dropdown to the prior selection immediately so it
      // doesn't visibly sit on "Add custom…" while the inline form is
      // open — mirrors the old cancel-path behavior.
      reflectSelection(currentId);
      showAddCustomForm();
      return;
    }
    reflectSelection(select.value);
  });

  addConfirmButton.addEventListener('click', () => {
    void confirmAddCustom();
  });

  addCancelButton.addEventListener('click', () => {
    cancelAddCustom();
  });

  newNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void confirmAddCustom();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelAddCustom();
    }
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
    config.selected = id;
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
