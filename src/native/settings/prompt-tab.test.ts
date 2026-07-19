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
    <label for="template-select">Template
      <select id="template-select"></select>
    </label>
    <label for="template-text">Instructions
      <textarea id="template-text" rows="14" spellcheck="false"></textarea>
    </label>
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

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'get_prompt_templates') return Promise.resolve(seededConfig());
    if (cmd === 'set_prompt_templates') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
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

  it('Add custom… prompts for a name, seeds text from General, appends and selects it', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('New style');
    await initPromptTab();
    const select = el<HTMLSelectElement>('template-select');
    const textarea = el<HTMLTextAreaElement>('template-text');

    select.value = '__add__';
    select.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(promptSpy).toHaveBeenCalled();
    const generalBuiltin = BUILTIN_TEMPLATES.find((b) => b.id === 'general')!;
    expect(textarea.value).toBe(generalBuiltin.text);

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
