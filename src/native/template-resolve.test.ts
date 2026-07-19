// template-resolve.test.ts — resolveTemplate's fallback chain (Task 8).
// docTemplateId -> config.selected -> 'general', never throwing on
// unknown/deleted ids. Pure function, no invoke() mocking needed here.

import { test, expect } from 'vitest';
import { resolveTemplate, type PromptTemplatesConfig } from './template-resolve';
import { DEFAULT_EDITORIAL } from './zoom-tools/synthesis-prompt.mjs';

test('null config falls back to general / DEFAULT_EDITORIAL', () => {
  const tpl = resolveTemplate(null);
  expect(tpl.id).toBe('general');
  expect(tpl.text).toBe(DEFAULT_EDITORIAL);
});

test('selected builtin with an override uses the override text, not the shipped default', () => {
  const config: PromptTemplatesConfig = {
    selected: 'prd',
    overrides: { prd: 'custom PRD editorial text' },
    custom: [],
  };
  const tpl = resolveTemplate(config);
  expect(tpl.id).toBe('prd');
  expect(tpl.text).toBe('custom PRD editorial text');
});

test('selected custom id resolves to the custom template text', () => {
  const config: PromptTemplatesConfig = {
    selected: 'my-custom',
    overrides: {},
    custom: [{ id: 'my-custom', name: 'My Custom', text: 'my custom editorial text' }],
  };
  const tpl = resolveTemplate(config);
  expect(tpl.id).toBe('my-custom');
  expect(tpl.name).toBe('My Custom');
  expect(tpl.text).toBe('my custom editorial text');
});

test('selected id that matches nothing falls back to general', () => {
  const config: PromptTemplatesConfig = {
    selected: 'does-not-exist',
    overrides: {},
    custom: [],
  };
  const tpl = resolveTemplate(config);
  expect(tpl.id).toBe('general');
  expect(tpl.text).toBe(DEFAULT_EDITORIAL);
});

test('docTemplateId beats config.selected', () => {
  const config: PromptTemplatesConfig = {
    selected: 'prd',
    overrides: {},
    custom: [],
  };
  const tpl = resolveTemplate(config, 'research');
  expect(tpl.id).toBe('research');
});

test('a deleted custom docTemplateId falls back to config.selected', () => {
  const config: PromptTemplatesConfig = {
    selected: 'task-report',
    overrides: {},
    custom: [], // the custom template the doc was tagged with is gone
  };
  const tpl = resolveTemplate(config, 'now-deleted-custom-id');
  expect(tpl.id).toBe('task-report');
});
