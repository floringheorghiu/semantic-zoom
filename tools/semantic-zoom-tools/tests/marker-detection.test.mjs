// Regression coverage for bug #3 (see README's "A second real bug"):
// assemble.mjs's marker detection used a bare indexOf/lastIndexOf on the
// marker TEXT with no check that what followed was an actual payload — so
// a document that merely DESCRIBES the marker syntax in its own prose (this
// plugin's own docs/semantic-zoom-tools.md, in practice) got its
// explanatory sentence mistaken for an existing payload and truncated.
//
// findExistingMarkerStart fixes this two ways, tested separately below:
// requiring the candidate region to parse as JSON at all, AND requiring it
// to have the shape of a real LookupTable (not just any valid JSON value) —
// the second check matches what the app's real Rust extractor guarantees
// via a typed deserialize, not just "is this JSON."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingMarkerStart, looksLikeLookupTable } from '../scripts/assemble.mjs';

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
  assert.equal(findExistingMarkerStart(source), -1);
});

test('prose whose illustrative example happens to be syntactically valid JSON, but the wrong shape, is not mistaken for a payload', () => {
  // A minimal, syntactically-valid JSON object shown as a tiny example of
  // "the shape" — passes a bare JSON.parse, but has none of the required
  // top-level keys a real LookupTable must have.
  const source =
    'A minimal example: `<!-- semantic-zoom:payload:v1\n{"example": true}\n-->`\n\n' +
    'The rest of this document must survive completely intact.\n';
  assert.equal(findExistingMarkerStart(source), -1);
});

test('a real, well-formed LookupTable payload IS recognized as an existing marker', () => {
  const json = JSON.stringify(REAL_TABLE);
  const source = `Some content.\n\n<!-- semantic-zoom:payload:v1\n${json}\n-->\n`;
  const found = findExistingMarkerStart(source);
  assert.equal(found, source.lastIndexOf('<!-- semantic-zoom:payload:v1'));
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
