// Regression coverage for bug #1 (see README's "A real bug this caught"):
// segment.mjs originally used remark/unist's node.position.offset directly
// as a byte span. That offset is a UTF-16 code-unit CHARACTER index, not a
// UTF-8 byte offset — identical for pure ASCII, which is exactly why the
// bug was invisible against an all-ASCII fixture. This file exists so that
// class of bug can never silently come back: every case below hinges on
// non-ASCII characters (em dashes, arrows, curly quotes) appearing BEFORE
// the block under test, which is what makes character-offset vs
// byte-offset drift compound and become visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segment } from '../scripts/segment.mjs';

test('a code block after non-ASCII prose gets an exact, unmangled span', () => {
  const source =
    '# Title\n\n' +
    'Some prose with an em dash — and an arrow → and curly quotes "like this".\n\n' +
    '```bash\n' +
    'echo hello\n' +
    '```\n';

  const { blocks } = segment(source);
  const code = blocks.find((b) => b.kind === 'code');
  assert.ok(code, 'expected a code block');

  // The exact byte slice segment.mjs's own span points to must equal the
  // fenced block verbatim — not truncated, not shifted, not garbled.
  const bytes = Buffer.from(source, 'utf8');
  const sliced = bytes.subarray(code.span.start, code.span.end).toString('utf8');
  assert.equal(sliced, '```bash\necho hello\n```');
  assert.equal(code.text, sliced);
});

test('a prose block is not truncated mid-word by an earlier non-ASCII run', () => {
  // Two em dashes and an arrow ahead of this paragraph, deliberately dense —
  // the UTF-16/UTF-8 drift compounds with every one of them.
  const source =
    'Intro — with an arrow → and another dash — for good measure.\n\n' +
    'This paragraph must remain completely intact, not cut off mid retrying.\n';

  const { blocks } = segment(source);
  const prose = blocks.find((b) => b.text.startsWith('This paragraph'));
  assert.ok(prose, 'expected to find the second prose block by its real starting text');
  assert.equal(
    prose.text,
    'This paragraph must remain completely intact, not cut off mid retrying.',
  );
});

test('duplicate-content blocks get distinct, deterministic ordinals', () => {
  const source =
    '```js\nconsole.log(1)\n```\n\n' +
    'separator\n\n' +
    '```js\nconsole.log(1)\n```\n';

  const { blocks } = segment(source);
  const codeBlocks = blocks.filter((b) => b.kind === 'code');
  assert.equal(codeBlocks.length, 2);
  assert.notEqual(codeBlocks[0].id, codeBlocks[1].id);
  const [hash0] = codeBlocks[0].id.split('-').slice(1);
  const [hash1] = codeBlocks[1].id.split('-').slice(1);
  assert.equal(hash0, hash1, 'identical content must hash identically');
  assert.equal(codeBlocks[0].id, `P-${hash0}-0`);
  assert.equal(codeBlocks[1].id, `P-${hash1}-1`);
});
