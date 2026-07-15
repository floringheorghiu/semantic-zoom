#!/usr/bin/env node
// assemble.mjs — CLI wrapper: merge segments + layers.json into a
// LookupTable payload and embed it in the source .md file.
//
//   node assemble.mjs <file.md> <layers.json>
//
// layers.json (authored by the model — the one part of this pipeline that
// IS a language task) has the shape:
//   {
//     "meta": [ { "title": "...", "body": "...", "sections": ["<sectionKey>", ...] } ],
//     "sections": [ { "key": "<sectionKey>", "title": "...", "body": "...",
//                     "paragraphs": ["<P-id>", "<P-id>", ...] } ]
//   }
// `sectionKey` is any string the author chooses to link a section to its
// parent meta node; it never appears in the output payload.
// `paragraphs` MUST be real IDs from segments, listed in the exact
// contiguous document-order run they cover (see CONTIGUITY below).
//
// T4: the merge logic itself (D6 id verification, A1 docHash scope, §4.1
// CONTIGUITY) now lives in ../../../src/native/zoom-tools/assemble.mjs —
// the portable `buildLookupTable()` shared with the app's Engine B path
// (src/native/engine-b-remote.ts). This file adds only what's Node/CLI-only:
// reading files, A3 marker escaping, and writing the final bytes to disk.
//
// This script re-derives the whole payload from scratch every run. It
// never patches an existing embedded payload in place — regenerating from
// segments+layers is what keeps IDs, hashes, and spans mutually consistent.
//
// Enforces, matching Implementation_Plan.md:
//   D6  — every id is content-addressed; re-verified against segments.
//   A1  — docHash covers only bytes preceding the payload marker.
//   A2  — spans reference that same pre-payload region (true by construction).
//   A3  — any literal "-->" inside the JSON payload is escaped as "-->".
//   §4.1 CONTIGUITY — a .pgroup wraps its children as one DOM container;
//         a section's paragraph list must be a contiguous run in document order.

import { readFileSync, writeFileSync } from 'node:fs';
import { buildLookupTable, AssembleError } from '../../../src/native/zoom-tools/assemble.mjs';
import {
  MARKER_HEAD,
  MARKER_TAIL,
  isCliInvocation,
  hasDamagedEofMarker,
  prePayloadSource,
} from './validate.mjs';

function fail(msg) {
  console.error(`assemble.mjs: ${msg}`);
  process.exit(1);
}

function main() {
  const [, , mdPath, layersPath] = process.argv;
  if (!mdPath || !layersPath) fail('usage: node assemble.mjs <file.md> <layers.json>');

  const rawFull = readFileSync(mdPath, 'utf8');
  // The canonical pre-payload source (validate.mjs): genuine payloads
  // stripped (content after them spliced back in as body, never deleted),
  // trailing whitespace normalized so re-runs converge byte-identically.
  // segment.mjs's CLI applies the SAME transformation, so step-1 ids always
  // resolve here.
  const raw = prePayloadSource(rawFull);
  if (hasDamagedEofMarker(raw)) {
    // Marker-LIKE residue at EOF that is not a genuine payload — almost
    // certainly a DAMAGED payload (truncated JSON, mangled merge).
    // Embedding it silently as document content would lock the garbage
    // into the file as prose; refuse loudly instead. Marker text quoted
    // mid-document (prose about the format) has real content after it and
    // sails through untouched.
    fail(
      `found marker-like text at end of file that is not a valid payload — ` +
      `likely a damaged/corrupt payload block. Refusing to embed it as document ` +
      `content. If it is a broken payload, delete the block (from the ` +
      `"${MARKER_HEAD}" line to the closing "${MARKER_TAIL}") or restore the file ` +
      `from version control, then re-run. If it is intentional prose, add real ` +
      `content after it so it no longer sits alone at EOF.`,
    );
  }

  const layers = JSON.parse(readFileSync(layersPath, 'utf8'));

  let table, docHash, prefix;
  try {
    ({ table, docHash, prefix } = buildLookupTable(raw, layers));
  } catch (e) {
    if (e instanceof AssembleError) fail(e.message);
    throw e;
  }

  let payloadJson = JSON.stringify(table);
  // A3: escape any literal "-->" inside string values so the marker's own
  // terminator can't appear mid-payload.
  payloadJson = payloadJson.split('-->').join('--\\u003e');
  // Same discipline for the marker's HEAD text: a section/meta body or code
  // block that quotes the marker syntax (this repo's own format docs do)
  // would otherwise ship the head string verbatim inside the JSON — and the
  // app's Rust extractor locates the payload with rfind(HEAD), which would
  // then land inside the JSON and report the whole file Corrupt. Escaping
  // the head's leading '<' as its JSON unicode escape (backslash-u-0-0-3-c)
  // makes the file bytes unmatchable by any marker scanner while parsing
  // back to the identical string. In valid JSON, '<' only ever occurs
  // inside string values, so a blanket replace is safe.
  payloadJson = payloadJson.split(MARKER_HEAD).join(`\\u003c${MARKER_HEAD.slice(1)}`);

  const out = prefix + `${MARKER_HEAD}\n${payloadJson}\n${MARKER_TAIL}\n`;
  writeFileSync(mdPath, out, 'utf8');

  console.log(`assembled: paragraphs=${Object.keys(table.paragraphs).length} ` +
    `sections=${Object.keys(table.sections).length} meta=${Object.keys(table.meta).length} ` +
    `docHash=${docHash.slice(0, 12)}… -> ${mdPath}`);
}

// ---- CLI ---- (guarded so this module can be imported for its exports —
// e.g. by tests — without running main(). isCliInvocation, not a naive
// URL-string comparison: see its doc comment in validate.mjs for the four
// ways the naive form silently failed open.)
if (isCliInvocation(import.meta.url)) {
  main();
}
