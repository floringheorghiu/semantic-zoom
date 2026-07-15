import { test, expect } from 'vitest';
import { generateAffordanceVisibility } from './selectors';
import type { DocStatus } from './store';

// Generate-affordance visibility matrix (§8.5, §2.7 stub UX) — T7's Check.
test('Untagged x provider-configured -> generate (clickable affordance)', () => {
  expect(generateAffordanceVisibility('untagged', true)).toBe('generate');
});

test('Untagged x no-provider -> stub (§2.7 disabled tooltip UX)', () => {
  expect(generateAffordanceVisibility('untagged', false)).toBe('stub');
});

test('Native (ready) -> hidden regardless of provider config', () => {
  expect(generateAffordanceVisibility('ready', true)).toBe('hidden');
  expect(generateAffordanceVisibility('ready', false)).toBe('hidden');
});

test('every other status -> hidden regardless of provider config', () => {
  const others: DocStatus[] = ['empty', 'corrupt', 'reloading', 'synthesizing'];
  for (const status of others) {
    expect(generateAffordanceVisibility(status, true)).toBe('hidden');
    expect(generateAffordanceVisibility(status, false)).toBe('hidden');
  }
});
