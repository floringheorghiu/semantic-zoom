// prompt-tab.ts — Prompt tab: template picker + editable editorial-text
// editor (§Task 9), plus the per-document scope control (§Task 12). Consumes
// `BUILTIN_TEMPLATES` (the shipped editorial layer from synthesis-prompt.mjs)
// and Task 7's `get_prompt_templates` / `set_prompt_templates` Rust commands.
// The dropdown IS the global default picker — whichever template is
// selected when Save/Restore/Delete runs becomes `config.selected`, same
// value `resolveTemplate()` (Task 8) falls back to when a document has no
// per-doc template id.
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

// --- Per-document scope (Task 12) -----------------------------------------
//
// A clearly separable addition on top of the Task 9 global picker above:
// this section owns the `#template-scope` radios and everything that
// depends on which one is checked. It never touches config.selected — doc
// scope only picks an id via `set_doc_template`, it never edits template
// text, so Save/Restore/Delete are hidden the moment scope flips to "doc".
//
// "Current document" lives in `window.localStorage` under this key — the
// same cross-window pattern `state/theme.ts` uses (main.ts writes it on
// document load/close; both webviews share the app origin's localStorage,
// so a `storage` event here mirrors a document open/close from the main
// window). No Rust state, no fourth Rust/TS crossing.
const CURRENT_DOC_KEY = 'sz-current-doc';

/** Sentinel dropdown value for "Follow default (<name>)" in doc scope —
    maps to `set_doc_template(docPath, null)`, clearing the override. */
const FOLLOW_DEFAULT = '__follow_default__';

function currentDocPath(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_DOC_KEY) || null;
  } catch {
    return null;
  }
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
  const scopeFieldset = el<HTMLFieldSetElement>('template-scope');
  const foundDefaultRadio = scopeFieldset.querySelector<HTMLInputElement>(
    'input[name="tscope"][value="default"]',
  );
  const foundDocRadio = scopeFieldset.querySelector<HTMLInputElement>(
    'input[name="tscope"][value="doc"]',
  );
  if (!foundDefaultRadio || !foundDocRadio) {
    throw new Error('prompt-tab: missing #template-scope radios');
  }
  // Re-bound to non-nullable locals: the guard above narrows only within
  // this statement's scope, not inside closures declared later that
  // capture the original (still `| null`-typed) const bindings.
  const scopeDefaultRadio: HTMLInputElement = foundDefaultRadio;
  const scopeDocRadio: HTMLInputElement = foundDocRadio;
  const scopeHint = el<HTMLElement>('template-scope-hint');

  const loaded = await invoke<PromptTemplatesConfig | null>('get_prompt_templates');
  const config: PromptTemplatesConfig = loaded
    ? {
        selected: loaded.selected || 'general',
        overrides: loaded.overrides ?? {},
        custom: loaded.custom ?? [],
      }
    : defaultConfig();

  let currentId = config.selected;
  let scope: 'default' | 'doc' = 'default';

  function templateName(id: string): string {
    return (
      BUILTIN_TEMPLATES.find((b) => b.id === id)?.name ??
      config.custom.find((c) => c.id === id)?.name ??
      'General'
    );
  }

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

  /** `forDocScope` prepends the "Follow default (<name>)" sentinel and
      omits "Add custom…" — doc scope only picks an existing template, it
      never creates one (creating a custom template edits the global
      catalog, a Default-scope-only action). */
  function buildOptions(forDocScope = false): void {
    const options: HTMLOptionElement[] = [];
    if (forDocScope) {
      const follow = document.createElement('option');
      follow.value = FOLLOW_DEFAULT;
      follow.textContent = `Follow default (${templateName(config.selected)})`;
      options.push(follow);
    }
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
    if (!forDocScope) {
      const add = document.createElement('option');
      add.value = ADD_CUSTOM;
      add.textContent = 'Add custom…';
      options.push(add);
    }
    select.replaceChildren(...options);
  }

  /** Fills the textarea + toggles Restore/Delete for a real (non-sentinel)
      selection, and remembers it as the selection to fall back to if the
      user later opens then cancels "Add custom…". Default-scope only —
      doc scope has its own `reflectDocSelection`. */
  function reflectSelection(id: string): void {
    select.value = id;
    textarea.value = effectiveText(id);
    textarea.readOnly = false;
    const builtin = isBuiltin(id);
    saveButton.hidden = false;
    restoreButton.hidden = !builtin;
    deleteButton.hidden = builtin;
    currentId = id;
  }

  /** Doc-scope counterpart: `id === null` means "no override" (Follow
      default). Save/Restore/Delete stay hidden — doc scope only picks. */
  function reflectDocSelection(id: string | null): void {
    select.value = id ?? FOLLOW_DEFAULT;
    textarea.value = effectiveText(id ?? config.selected);
    textarea.readOnly = true;
    saveButton.hidden = true;
    restoreButton.hidden = true;
    deleteButton.hidden = true;
  }

  /** Enables/disables "This document" based on whether a document is open
      (`sz-current-doc` set by main.ts on load/close), and shows the hint
      explaining why when it's disabled. Forces scope back to Default if the
      document that was in doc scope just closed. */
  function refreshScopeAvailability(): void {
    const path = currentDocPath();
    const unavailable = path === null;
    scopeDocRadio.disabled = unavailable;
    scopeHint.hidden = !unavailable;
    if (unavailable && scope === 'doc') {
      scopeDefaultRadio.checked = true;
      void switchScope('default');
    }
  }

  /** The single entry point for a scope change, whether from a radio click
      or a re-sync after the open document changed underneath doc scope. */
  async function switchScope(next: 'default' | 'doc'): Promise<void> {
    scope = next;
    if (next === 'default') {
      buildOptions(false);
      reflectSelection(currentId);
      return;
    }
    buildOptions(true);
    const path = currentDocPath();
    if (path === null) {
      // Guarded by refreshScopeAvailability (the radio is disabled), but
      // stay defensive against a race between the two.
      reflectDocSelection(null);
      return;
    }
    const stored = await invoke<string | null>('get_doc_template', { docPath: path });
    reflectDocSelection(stored ?? null);
  }

  async function handleDocSelect(): Promise<void> {
    const path = currentDocPath();
    if (path === null) return;
    const id = select.value === FOLLOW_DEFAULT ? null : select.value;
    await invoke('set_doc_template', { docPath: path, templateId: id });
    reflectDocSelection(id);
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
    if (scope === 'doc') {
      void handleDocSelect();
      return;
    }
    if (select.value === ADD_CUSTOM) {
      void handleAddCustom();
      return;
    }
    reflectSelection(select.value);
  });

  scopeDefaultRadio.addEventListener('change', () => {
    if (scopeDefaultRadio.checked) void switchScope('default');
  });
  scopeDocRadio.addEventListener('change', () => {
    if (scopeDocRadio.checked) void switchScope('doc');
  });

  // Cross-window sync (same pattern as state/theme.ts): main.ts writes
  // `sz-current-doc` on document load/close in the OTHER webview, so this
  // tab must react to a `storage` event, not just its own local state.
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== CURRENT_DOC_KEY) return;
    refreshScopeAvailability();
    if (scope === 'doc') void switchScope('doc'); // re-fetch for the (possibly new) doc
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
  refreshScopeAvailability();
}
