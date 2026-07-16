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
});

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

test('oversized refusal happens before any provider call', async () => {
  await remoteSynthesizer.synthesize(oversizedDoc(), signal()).catch(() => {});
  expect(invokeMock).not.toHaveBeenCalled();
});

test('a failed run reports meta for the FINAL attempt (count, temperature, usage)', async () => {
  // Every attempt returns unparseable JSON → the full retry ladder runs.
  invokeMock
    .mockResolvedValueOnce({ content: 'not json', usage: { promptTokens: 10, completionTokens: 1 } })
    .mockResolvedValueOnce({ content: 'still not json', usage: { promptTokens: 11, completionTokens: 2 } })
    .mockResolvedValueOnce({ content: 'nope', usage: { promptTokens: 12, completionTokens: 3 } });

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
  invokeMock.mockResolvedValue({ content: 'not json' });
  await remoteSynthesizer.synthesize('# Doc\n\nA paragraph.', signal()).catch(() => {});
  expect(lastSynthesisRunMeta()).not.toBeNull();

  // …then an oversized doc must RESET it, not leak the old run's numbers.
  await remoteSynthesizer.synthesize(oversizedDoc(), signal()).catch(() => {});
  expect(lastSynthesisRunMeta()).toBeNull();
});

test('a provider response without usage yields usage: null, not an error', async () => {
  invokeMock.mockResolvedValue({ content: 'not json' });
  await remoteSynthesizer.synthesize('# Doc\n\nA paragraph.', signal()).catch(() => {});
  expect(lastSynthesisRunMeta()!.usage).toBeNull();
});

test('estimateTokens uses the ~4-chars-per-token heuristic', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('abcd')).toBe(1);
  expect(estimateTokens('a'.repeat(401))).toBe(101); // rounds up — refusal must err conservative
});
