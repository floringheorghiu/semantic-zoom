// engine-b-remote.test.ts — per-message edge cases for the real Synthesizer.
// The provider bridge (`llm_complete` via @tauri-apps/api invoke) is mocked:
// these tests are about what the synthesizer refuses BEFORE any network
// call, so a mock that records invocations is the whole point, not a shortcut.

import { test, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  remoteSynthesizer,
  estimateTokens,
  lastSynthesisRunMeta,
  MAX_INPUT_TOKENS,
} from './engine-b-remote';

beforeEach(() => {
  invokeMock.mockReset();
  mockLlmResponses(); // default: get_prompt_templates -> null, llm_complete -> { content: 'not json' }
});

/**
 * Task 8: `synthesize()` now issues a `get_prompt_templates` invoke at run
 * start, before any `llm_complete` call. Tests below care about the
 * `llm_complete` response sequence, not the template config, so this helper
 * routes by command: `get_prompt_templates` always resolves to `null`
 * (falls back to the 'general' builtin, per resolveTemplate's contract),
 * and `llm_complete` responses are supplied by the caller, one per call, in
 * order — the same shape the old `mockResolvedValueOnce` chains had, just
 * command-aware so the extra invoke doesn't shift the queue by one.
 */
function mockLlmResponses(...responses: unknown[]): void {
  let call = 0;
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'get_prompt_templates') return Promise.resolve(null);
    if (cmd === 'llm_complete') {
      const next = responses.length > 0 ? responses[Math.min(call, responses.length - 1)] : { content: 'not json' };
      call++;
      return Promise.resolve(next);
    }
    return Promise.resolve(undefined);
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** A document whose synthesis prompt is guaranteed past the ceiling:
    unique paragraphs (so segmentation keeps them all) totalling well over
    MAX_INPUT_TOKENS * 4 characters. */
function oversizedDoc(): string {
  const paras: string[] = ['# Big document'];
  const target = MAX_INPUT_TOKENS * 4 * 1.2;
  let size = 0;
  for (let i = 0; size < target; i++) {
    const p = `Paragraph ${i} ${'x'.repeat(400)}`;
    paras.push(p);
    size += p.length;
  }
  return paras.join('\n\n');
}

test('oversized document is refused with a clear message, per D10 (no silent truncation)', async () => {
  await expect(
    remoteSynthesizer.synthesize(oversizedDoc(), signal()),
  ).rejects.toThrow(/too large.*context limit/i);
});

test('oversized refusal happens before any llm_complete call', async () => {
  // The template-config fetch (get_prompt_templates) DOES happen before the
  // pre-flight size check (Task 8: the resolved template's text is part of
  // what's measured) — it's the provider-facing llm_complete call the D10
  // refusal must precede, and that invariant still holds.
  mockLlmResponses();
  await remoteSynthesizer.synthesize(oversizedDoc(), signal()).catch(() => {});
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'llm_complete')).toBe(false);
});

test('a failed run reports meta for the FINAL attempt (count, temperature, usage)', async () => {
  // Every attempt returns unparseable JSON → the full retry ladder runs.
  mockLlmResponses(
    { content: 'not json', usage: { promptTokens: 10, completionTokens: 1 } },
    { content: 'still not json', usage: { promptTokens: 11, completionTokens: 2 } },
    { content: 'nope', usage: { promptTokens: 12, completionTokens: 3 } },
  );

  await expect(
    remoteSynthesizer.synthesize('# Doc\n\nOne real paragraph.', signal()),
  ).rejects.toThrow(/failed after 3 attempts/i);

  const meta = lastSynthesisRunMeta();
  expect(meta).not.toBeNull();
  expect(meta!.attempts).toBe(3);
  expect(meta!.temperature).toBe(0.6); // ladder's last rung
  expect(meta!.usage).toEqual({ promptTokens: 12, completionTokens: 3 }); // final attempt's, not a sum
});

test('meta is null after a pre-flight refusal (no provider call to describe)', async () => {
  // Seed stale meta from a previous failed run…
  mockLlmResponses({ content: 'not json' });
  await remoteSynthesizer.synthesize('# Doc\n\nA paragraph.', signal()).catch(() => {});
  expect(lastSynthesisRunMeta()).not.toBeNull();

  // …then an oversized doc must RESET it, not leak the old run's numbers.
  await remoteSynthesizer.synthesize(oversizedDoc(), signal()).catch(() => {});
  expect(lastSynthesisRunMeta()).toBeNull();
});

test('a provider response without usage yields usage: null, not an error', async () => {
  mockLlmResponses({ content: 'not json' });
  await remoteSynthesizer.synthesize('# Doc\n\nA paragraph.', signal()).catch(() => {});
  expect(lastSynthesisRunMeta()!.usage).toBeNull();
});

test('estimateTokens uses the ~4-chars-per-token heuristic', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('abcd')).toBe(1);
  expect(estimateTokens('a'.repeat(401))).toBe(101); // rounds up — refusal must err conservative
});
