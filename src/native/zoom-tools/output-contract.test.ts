import { test, expect } from 'vitest';
import { checkOutputContract, normalizeSynthesisOutput } from './output-contract.mjs';

// Pinned to the real incident (2026-07-15): a markdown table is ONE block to
// remark, so one P- id — but gemma4 reading its 8 rows emitted that id once
// per row, deterministically, on every retry. normalizeSynthesisOutput
// collapses that noise; genuine cross-section duplicates must still fail.

const IDS = ['P-aaaa1111-0', 'P-bbbb2222-0', 'P-cccc3333-0'];

function output(sections: { children: string[]; title?: string; body?: string }[]) {
  return {
    meta: { title: 'T', body: 'B' },
    sections: sections.map((s, i) => ({ title: s.title ?? `S${i}`, body: s.body ?? 'body', children: s.children })),
  };
}

test('within-section repeats collapse to the first occurrence and then pass the contract', () => {
  const raw = output([
    { children: ['P-aaaa1111-0', 'P-bbbb2222-0'] },
    // The incident shape: the table block's id repeated once per table row.
    { children: ['P-cccc3333-0', 'P-cccc3333-0', 'P-cccc3333-0', 'P-cccc3333-0'] },
  ]);
  const normalized = normalizeSynthesisOutput(raw) as typeof raw;
  expect(normalized.sections[1].children).toEqual(['P-cccc3333-0']);
  expect(checkOutputContract(normalized, IDS)).toEqual({ ok: true });
});

test('non-consecutive repeats within ONE section also collapse (id unambiguously belongs there)', () => {
  const raw = output([{ children: ['P-aaaa1111-0', 'P-bbbb2222-0', 'P-aaaa1111-0', 'P-cccc3333-0'] }]);
  const normalized = normalizeSynthesisOutput(raw) as typeof raw;
  expect(normalized.sections[0].children).toEqual(IDS);
  expect(checkOutputContract(normalized, IDS)).toEqual({ ok: true });
});

test('a duplicate across TWO sections is a genuine grouping conflict and still fails', () => {
  const raw = output([
    { children: ['P-aaaa1111-0', 'P-bbbb2222-0'] },
    { children: ['P-bbbb2222-0', 'P-cccc3333-0'] },
  ]);
  const normalized = normalizeSynthesisOutput(raw) as typeof raw;
  // Nothing to collapse within either section — the conflict survives intact.
  expect(normalized.sections[0].children).toEqual(['P-aaaa1111-0', 'P-bbbb2222-0']);
  expect(normalized.sections[1].children).toEqual(['P-bbbb2222-0', 'P-cccc3333-0']);
  const result = checkOutputContract(normalized, IDS);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('duplicated: P-bbbb2222-0');
});

test('already-clean output passes through byte-equivalent', () => {
  const raw = output([{ children: [...IDS] }]);
  const normalized = normalizeSynthesisOutput(raw) as typeof raw;
  expect(normalized.sections[0].children).toEqual(IDS);
  expect(checkOutputContract(normalized, IDS)).toEqual({ ok: true });
});

test('malformed shapes pass through untouched for checkOutputContract to name', () => {
  expect(normalizeSynthesisOutput(null)).toBeNull();
  expect(normalizeSynthesisOutput('not an object')).toBe('not an object');
  expect(normalizeSynthesisOutput({ meta: {} })).toEqual({ meta: {} });
  const badSection = { meta: { title: 't', body: 'b' }, sections: [{ title: 'x' }] };
  expect(normalizeSynthesisOutput(badSection)).toEqual(badSection);
});
