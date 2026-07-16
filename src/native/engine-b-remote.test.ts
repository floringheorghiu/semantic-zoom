// engine-b-remote.test.ts — per-message edge cases for the real Synthesizer.
// The provider bridge (`llm_complete` via @tauri-apps/api invoke) is mocked:
// these tests are about what the synthesizer refuses BEFORE any network
// call, so a mock that records invocations is the whole point, not a shortcut.

import { test, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { remoteSynthesizer, estimateTokens, MAX_INPUT_TOKENS } from './engine-b-remote';

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

test('estimateTokens uses the ~4-chars-per-token heuristic', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('abcd')).toBe(1);
  expect(estimateTokens('a'.repeat(401))).toBe(101); // rounds up — refusal must err conservative
});
