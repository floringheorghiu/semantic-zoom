// Regression coverage for the marker-detection bug family (see README's
// "A second real bug"): marker location must never mistake marker TEXT for
// a real payload. A document that merely DESCRIBES the marker syntax in
// prose (this plugin's own docs/semantic-zoom-tools.md, in practice) got
// its explanatory sentence matched by a bare indexOf/lastIndexOf and
// everything after it truncated as "the old payload".
//
// findExistingPayload defends in layers, each tested separately below:
// the candidate region must parse as JSON at all; it must have the shape
// of a real LookupTable (not just any valid JSON — matching the Rust
// extractor's typed deserialize); the tail is the FIRST `-->` after the
// head (A3 guarantees a real payload contains no literal one, and a
// whole-file last-tail scan let stray `-->`s after the payload corrupt
// detection); and heads are scanned backward so quoted examples never
// shadow a real payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Imported from validate.mjs — the dependency-free base module where the
// shared detection primitives live (so these tests also run without the
// segment/assemble dependency chain, i.e. before npm install).
import { findExistingPayload, looksLikeLookupTable } from '../scripts/validate.mjs';

const REAL_TABLE = {
  version: 1,
  docHash: 'a'.repeat(64),
  meta: {},
  sections: {},
  paragraphs: {},
  order: { meta: [], sections: [], paragraphs: [] },
};

test('prose that quotes the marker as a non-JSON illustrative example is not mistaken for a payload', () => {
  const source =
    'This tool embeds a `<!-- semantic-zoom:payload:v1 ... -->` block at the end of the file.\n\n' +
    'The rest of this document must survive completely intact.\n';
  assert.equal(findExistingPayload(source), null);
});

test('prose whose illustrative example happens to be syntactically valid JSON, but the wrong shape, is not mistaken for a payload', () => {
  // A minimal, syntactically-valid JSON object shown as a tiny example of
  // "the shape" — passes a bare JSON.parse, but has none of the required
  // top-level keys a real LookupTable must have.
  const source =
    'A minimal example: `<!-- semantic-zoom:payload:v1\n{"example": true}\n-->`\n\n' +
    'The rest of this document must survive completely intact.\n';
  assert.equal(findExistingPayload(source), null);
});

test('a real, well-formed LookupTable payload IS recognized, with exact head and end offsets', () => {
  const json = JSON.stringify(REAL_TABLE);
  const doc = 'Some content.\n\n';
  const source = `${doc}<!-- semantic-zoom:payload:v1\n${json}\n-->\n`;
  const found = findExistingPayload(source);
  assert.ok(found, 'expected the payload to be found');
  // Hardcoded expectations, NOT recomputed with the same string search the
  // implementation uses — a shared-bug recomputation would stay green
  // through exactly the regressions this test exists to catch.
  assert.equal(found.head, 15); // 'Some content.\n\n'.length
  assert.equal(found.end, source.length - 1); // everything but the final \n
});

test('a real payload is still found when marker text is ALSO quoted in prose before it', () => {
  const json = JSON.stringify(REAL_TABLE);
  const source =
    'Prose quoting `<!-- semantic-zoom:payload:v1 ... -->` as an example.\n\n' +
    `<!-- semantic-zoom:payload:v1\n${json}\n-->\n`;
  const found = findExistingPayload(source);
  assert.ok(found, 'the real payload must win over the earlier prose mention');
  assert.equal(source.slice(found.end - 3, found.end), '-->');
  assert.ok(found.head > 20, 'must be the real marker, not the prose mention at index 14');
});

test("a stray '-->' in content AFTER the real payload does not break detection (first-tail rule)", () => {
  const json = JSON.stringify(REAL_TABLE);
  const source =
    `Content.\n\n<!-- semantic-zoom:payload:v1\n${json}\n-->\n\n` +
    'Appended note: A --> B\n';
  const found = findExistingPayload(source);
  assert.ok(found, 'payload must still be detected despite the later stray tail');
  // end must be the payload's own closer, not the stray one in the note.
  assert.equal(source.slice(found.end).includes('Appended note'), true);
});

test('looksLikeLookupTable rejects arrays, null, and objects missing required keys', () => {
  assert.equal(looksLikeLookupTable(null), false);
  assert.equal(looksLikeLookupTable([1, 2, 3]), false);
  assert.equal(looksLikeLookupTable({}), false);
  assert.equal(looksLikeLookupTable({ example: true }), false);
  // Actually OMIT the key (not just set it to undefined — a spread with an
  // undefined value still leaves the key present via `in`).
  const { order, ...withoutOrder } = REAL_TABLE;
  assert.equal(looksLikeLookupTable(withoutOrder), false);
});

test('looksLikeLookupTable accepts a real LookupTable shape', () => {
  assert.equal(looksLikeLookupTable(REAL_TABLE), true);
});
