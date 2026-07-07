import { test, expect } from 'vitest';
import { stubSynthesizer, segment } from './engine-b';

test('stubSynthesizer rejects with ENGINE_B_NOT_IMPLEMENTED', async () => {
  await expect(
    stubSynthesizer.synthesize('# x', new AbortController().signal),
  ).rejects.toThrow('ENGINE_B_NOT_IMPLEMENTED');
});

test('segment returns top-level block spans with numeric byte offsets', () => {
  const out = segment('# H\n\npara\n\n```js\nx\n```');

  const kinds = out.map((b) => b.kind);
  expect(kinds).toEqual(['heading', 'paragraph', 'code']);

  for (const block of out) {
    expect(typeof block.start).toBe('number');
    expect(typeof block.end).toBe('number');
    expect(block.end).toBeGreaterThan(block.start);
  }
});
