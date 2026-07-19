// prompt-tab.test.ts — Task 9's Prompt tab: template picker + editor.
//
// `@tauri-apps/api/core`'s `invoke` is mocked (same pattern as
// engine-b-remote.test.ts): these tests are about the tab's state machine
// (dropdown contents, effective-text resolution, Save/Restore/Delete/Add
// custom), not about the real Tauri bridge.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_TEMPLATES } from '../zoom-tools/synthesis-prompt.mjs';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { initPromptTab } from './prompt-tab';

const CUSTOM_ID = 'custom-1';
const CUSTOM_TEXT = '2. Custom instructions here.';
const OVERRIDE_TEXT = '2. Overridden PRD instructions.';

function seededConfig() {
  return {
    selected: 'general',
    overrides: { prd: OVERRIDE_TEXT },
    custom: [{ id: CUSTOM_ID, name: 'My custom', text: CUSTOM_TEXT }],
  };
}

function mount(): void {
  document.body.innerHTML = `
    <fieldset id="template-scope">
      <label><input type="radio" name="tscope" value="default" checked /> Default</label>
      <label><input type="radio" name="tscope" value="doc" /> This document</label>
    </fieldset>
    <div id="template-scope-hint" hidden></div>
    <label for="template-select">Template
      <select id="template-select"></select>
    </label>
    <label for="template-text">Instructions
      <textarea id="template-text" rows="14" spellcheck="false"></textarea>
    </label>
    <div id="template-add-custom" hidden>
      <label for="template-new-name">New template name
        <input id="template-new-name" type="text" />
      </label>
      <div class="row">
        <button id="template-add-confirm" type="button">Create</button>
        <button id="template-add-cancel" type="button">Cancel</button>
      </div>
    </div>
    <div class="row">
      <button id="template-save" type="button">Save</button>
      <button id="template-restore" type="button">Restore default</button>
      <button id="template-delete" type="button" hidden>Delete</button>
    </div>
    <div id="template-note"></div>`;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function scopeRadio(value: 'default' | 'doc'): HTMLInputElement {
  return document.querySelector(`input[name="tscope"][value="${value}"]`) as HTMLInputElement;
}

function setCurrentDoc(path: string | null): void {
  if (path === null) window.localStorage.removeItem('sz-current-doc');
  else window.localStorage.setItem('sz-current-doc', path);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'get_prompt_templates') return Promise.resolve(seededConfig());
    if (cmd === 'set_prompt_templates') return Promise.resolve(undefined);
    if (cmd === 'get_doc_template') return Promise.resolve(null);
    if (cmd === 'set_doc_template') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
  window.localStorage.clear();
  mount();
});

describe('prompt tab', () => {
  it('lists 5 builtins + the custom template + Add custom…', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual([...BUILTIN_TEMPLATES.map((b) => b.id), CUSTOM_ID, '__add__']);
    expect(select.options.length).toBe(BUILTIN_TEMPLATES.length + 2);
  });

  it('shows effective text for a builtin, override winning over shipped', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');

    select.value = 'prd';
    select.dispatchEvent(new Event('change'));

    expect(textarea.value).toBe(OVERRIDE_TEXT);
  });

  it('shows Delete and hides Restore for a custom template; the reverse for a builtin', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const restoreButton = el<HTMLButtonElement>('template-restore');
    const deleteButton = el<HTMLButtonElement>('template-delete');

    select.value = CUSTOM_ID;
    select.dispatchEvent(new Event('change'));
    expect(deleteButton.hidden).toBe(false);
    expect(restoreButton.hidden).toBe(true);

    select.value = 'general';
    select.dispatchEvent(new Event('change'));
    expect(deleteButton.hidden).toBe(true);
    expect(restoreButton.hidden).toBe(false);
  });

  it('Save on a builtin writes the edited text under overrides', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');
    const saveButton = el<HTMLButtonElement>('template-save');

    select.value = 'task-report';
    select.dispatchEvent(new Event('change'));
    textarea.value = 'my tweaked task-report instructions';
    saveButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    expect(call).toBeDefined();
    const templates = call![1].templates;
    expect(templates.overrides['task-report']).toBe('my tweaked task-report instructions');
    expect(templates.selected).toBe('task-report');
  });

  it('Save on a builtin whose text matches shipped default deletes the overrides key', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');
    const saveButton = el<HTMLButtonElement>('template-save');

    select.value = 'prd';
    select.dispatchEvent(new Event('change'));
    const prdBuiltin = BUILTIN_TEMPLATES.find((b) => b.id === 'prd')!;
    textarea.value = prdBuiltin.text;
    saveButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    const templates = call![1].templates;
    expect('prd' in templates.overrides).toBe(false);
  });

  it('Save on a custom template updates its entry', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');
    const saveButton = el<HTMLButtonElement>('template-save');

    select.value = CUSTOM_ID;
    select.dispatchEvent(new Event('change'));
    textarea.value = 'updated custom text';
    saveButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    const templates = call![1].templates;
    const custom = templates.custom.find((c: { id: string }) => c.id === CUSTOM_ID);
    expect(custom.text).toBe('updated custom text');
    expect(templates.selected).toBe(CUSTOM_ID);
  });

  it('Restore removes the overrides key and refills shipped text', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');
    const restoreButton = el<HTMLButtonElement>('template-restore');

    select.value = 'prd';
    select.dispatchEvent(new Event('change'));
    expect(textarea.value).toBe(OVERRIDE_TEXT);

    restoreButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const prdBuiltin = BUILTIN_TEMPLATES.find((b) => b.id === 'prd')!;
    expect(textarea.value).toBe(prdBuiltin.text);

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    const templates = call![1].templates;
    expect('prd' in templates.overrides).toBe(false);
  });

  it('Restore sets config.selected to the restored template, even without a prior Save', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const restoreButton = el<HTMLButtonElement>('template-restore');

    // config.selected loads as 'general' (seededConfig). Select 'prd' — an
    // overridden builtin — WITHOUT clicking Save, then click Restore.
    select.value = 'prd';
    select.dispatchEvent(new Event('change'));

    restoreButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    expect(call).toBeDefined();
    const templates = call![1].templates;
    expect(templates.selected).toBe('prd');
  });

  it('Add custom… reveals an inline naming form and hides/disables the normal controls', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');
    const saveButton = el<HTMLButtonElement>('template-save');
    const restoreButton = el<HTMLButtonElement>('template-restore');
    const deleteButton = el<HTMLButtonElement>('template-delete');
    const addCustomForm = el<HTMLDivElement>('template-add-custom');

    select.value = '__add__';
    select.dispatchEvent(new Event('change'));

    expect(addCustomForm.hidden).toBe(false);
    expect(textarea.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);
    expect(restoreButton.disabled).toBe(true);
    expect(deleteButton.disabled).toBe(true);
    // Dropdown reverts immediately so it doesn't visibly sit on "Add custom…".
    expect(select.value).toBe('general');
  });

  it('Add custom… + Create with a name seeds text from General, appends and selects it, then hides the form', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');
    const newNameInput = el<HTMLInputElement>('template-new-name');
    const addConfirmButton = el<HTMLButtonElement>('template-add-confirm');
    const addCustomForm = el<HTMLDivElement>('template-add-custom');

    select.value = '__add__';
    select.dispatchEvent(new Event('change'));

    newNameInput.value = 'New style';
    addConfirmButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const generalBuiltin = BUILTIN_TEMPLATES.find((b) => b.id === 'general')!;
    expect(textarea.value).toBe(generalBuiltin.text);
    expect(addCustomForm.hidden).toBe(true);

    const values = Array.from(select.options).map((o) => o.value);
    expect(values.length).toBe(BUILTIN_TEMPLATES.length + 3); // +existing custom +new custom +__add__

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    const templates = call![1].templates;
    const added = templates.custom.find((c: { name: string }) => c.name === 'New style');
    expect(added).toBeDefined();
    expect(added.text).toBe(generalBuiltin.text);
    expect(templates.selected).toBe(added.id);
    expect(select.value).toBe(added.id);
  });

  it('Add custom… + Enter in the name field confirms, same as clicking Create', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const newNameInput = el<HTMLInputElement>('template-new-name');

    select.value = '__add__';
    select.dispatchEvent(new Event('change'));

    newNameInput.value = 'Enter style';
    newNameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await Promise.resolve();
    await Promise.resolve();

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    const templates = call![1].templates;
    expect(templates.custom.find((c: { name: string }) => c.name === 'Enter style')).toBeDefined();
  });

  it('Add custom… + Cancel hides the form, restores currentId, and creates nothing', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const newNameInput = el<HTMLInputElement>('template-new-name');
    const addCancelButton = el<HTMLButtonElement>('template-add-cancel');
    const addCustomForm = el<HTMLDivElement>('template-add-custom');
    const saveButton = el<HTMLButtonElement>('template-save');

    select.value = '__add__';
    select.dispatchEvent(new Event('change'));
    newNameInput.value = 'Abandoned';
    addCancelButton.click();

    expect(addCustomForm.hidden).toBe(true);
    expect(select.value).toBe('general');
    expect(saveButton.disabled).toBe(false);

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    expect(call).toBeUndefined();
  });

  it('Add custom… + Escape in the name field cancels, same as clicking Cancel', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const newNameInput = el<HTMLInputElement>('template-new-name');
    const addCustomForm = el<HTMLDivElement>('template-add-custom');

    select.value = '__add__';
    select.dispatchEvent(new Event('change'));
    newNameInput.value = 'Abandoned';
    newNameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(addCustomForm.hidden).toBe(true);
    expect(select.value).toBe('general');

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    expect(call).toBeUndefined();
  });

  it('Add custom… + Create with an empty/whitespace name does not create an entry', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const newNameInput = el<HTMLInputElement>('template-new-name');
    const addConfirmButton = el<HTMLButtonElement>('template-add-confirm');
    const addCustomForm = el<HTMLDivElement>('template-add-custom');

    select.value = '__add__';
    select.dispatchEvent(new Event('change'));
    newNameInput.value = '   ';
    addConfirmButton.click();
    await Promise.resolve();
    await Promise.resolve();

    // Form stays open — nothing was created.
    expect(addCustomForm.hidden).toBe(false);
    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    expect(call).toBeUndefined();
  });

  it('Delete removes the custom entry and selects general', async () => {
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const deleteButton = el<HTMLButtonElement>('template-delete');

    select.value = CUSTOM_ID;
    select.dispatchEvent(new Event('change'));
    deleteButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(select.value).toBe('general');
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain(CUSTOM_ID);

    const call = invokeMock.mock.calls.find((c) => c[0] === 'set_prompt_templates');
    const templates = call![1].templates;
    expect(templates.custom.find((c: { id: string }) => c.id === CUSTOM_ID)).toBeUndefined();
    expect(templates.selected).toBe('general');
  });
});

describe('prompt tab — per-document scope (Task 12)', () => {
  it('"This document" is disabled with a hint when no document is open', async () => {
    setCurrentDoc(null);
    await initPromptTab();

    expect(scopeRadio('doc').disabled).toBe(true);
    expect(el<HTMLElement>('template-scope-hint').hidden).toBe(false);
  });

  it('"This document" is enabled with no hint once a document is open', async () => {
    setCurrentDoc('/docs/plan.md');
    await initPromptTab();

    expect(scopeRadio('doc').disabled).toBe(false);
    expect(el<HTMLElement>('template-scope-hint').hidden).toBe(true);
  });

  it('selecting "This document" loads get_doc_template and shows "Follow default" when unset', async () => {
    setCurrentDoc('/docs/plan.md');
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');

    scopeRadio('doc').checked = true;
    scopeRadio('doc').dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('get_doc_template', { docPath: '/docs/plan.md' });
    const generalBuiltin = BUILTIN_TEMPLATES.find((b) => b.id === 'general')!;
    const firstOption = select.options[0];
    expect(firstOption.textContent).toBe(`Follow default (${generalBuiltin.name})`);
    expect(select.value).toBe(firstOption.value);
  });

  it('selecting "This document" shows the stored per-doc template when one is set', async () => {
    setCurrentDoc('/docs/plan.md');
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_prompt_templates') return Promise.resolve(seededConfig());
      if (cmd === 'get_doc_template') return Promise.resolve('prd');
      return Promise.resolve(undefined);
    });
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');

    scopeRadio('doc').checked = true;
    scopeRadio('doc').dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(select.value).toBe('prd');
    expect(textarea.value).toBe(OVERRIDE_TEXT); // effectiveText('prd') — override wins
  });

  it('picking a template in doc scope calls set_doc_template and never touches config.selected', async () => {
    setCurrentDoc('/docs/plan.md');
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');

    scopeRadio('doc').checked = true;
    scopeRadio('doc').dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    select.value = 'prd';
    select.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('set_doc_template', {
      docPath: '/docs/plan.md',
      templateId: 'prd',
    });
    expect(invokeMock.mock.calls.some((c) => c[0] === 'set_prompt_templates')).toBe(false);
  });

  it('picking "Follow default" in doc scope calls set_doc_template with a null id', async () => {
    setCurrentDoc('/docs/plan.md');
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_prompt_templates') return Promise.resolve(seededConfig());
      if (cmd === 'get_doc_template') return Promise.resolve('prd');
      return Promise.resolve(undefined);
    });
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');

    scopeRadio('doc').checked = true;
    scopeRadio('doc').dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    select.value = select.options[0].value; // the "Follow default" sentinel
    select.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('set_doc_template', {
      docPath: '/docs/plan.md',
      templateId: null,
    });
  });

  it('Save/Restore/Delete are hidden in doc scope', async () => {
    setCurrentDoc('/docs/plan.md');
    await initPromptTab();
    const saveButton = el<HTMLButtonElement>('template-save');
    const restoreButton = el<HTMLButtonElement>('template-restore');
    const deleteButton = el<HTMLButtonElement>('template-delete');

    scopeRadio('doc').checked = true;
    scopeRadio('doc').dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(saveButton.hidden).toBe(true);
    expect(restoreButton.hidden).toBe(true);
    expect(deleteButton.hidden).toBe(true);
  });

  it('switching back to Default restores the global dropdown, editable text, and Save', async () => {
    setCurrentDoc('/docs/plan.md');
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');
    const saveButton = el<HTMLButtonElement>('template-save');

    scopeRadio('doc').checked = true;
    scopeRadio('doc').dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    scopeRadio('default').checked = true;
    scopeRadio('default').dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(select.value).toBe('general'); // config.selected from seededConfig
    expect(textarea.readOnly).toBe(false);
    expect(saveButton.hidden).toBe(false);
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('__add__');
    expect(values).not.toContain('__follow_default__');
  });

  it('a storage event for sz-current-doc re-syncs availability from the other window', async () => {
    setCurrentDoc(null);
    await initPromptTab();
    expect(scopeRadio('doc').disabled).toBe(true);

    setCurrentDoc('/docs/plan.md');
    window.dispatchEvent(new StorageEvent('storage', { key: 'sz-current-doc' }));
    await Promise.resolve();

    expect(scopeRadio('doc').disabled).toBe(false);
  });
});
