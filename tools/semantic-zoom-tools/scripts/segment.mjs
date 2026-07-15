#!/usr/bin/env node
// segment.mjs — CLI wrapper around the portable segment() core (T4:
// ../../../src/native/zoom-tools/segment.mjs), which is now the single
// implementation shared with the app's Engine B path
// (src/native/engine-b-remote.ts) — this file adds only the Node-specific
// parts: reading the file and the CLI guard.
//
// Uses `unified` + `remark-parse` + `unist-util-visit` — the SAME parser
// family Engine B specifies (Implementation_Plan.md §2.7) — instead of an
// ad hoc regex splitter.
//
// Output (stdout): JSON { docPath, sourceLength, blocks: [...] }
// Each block: { id, kind, span:{start,end}, lang?, text, html }
//
// id derivation (D6, plan §2.1): P-<sha256(text)[:8]>-<ordinal>

import { readFileSync } from 'node:fs';
import { segment } from '../../../src/native/zoom-tools/segment.mjs';
import { isCliInvocation, prePayloadSource, hasDamagedEofMarker } from './validate.mjs';

export { segment };

// ---- CLI ---- (guard via isCliInvocation — see its doc comment in
// validate.mjs for the four ways the previous naive comparison failed open.)
if (isCliInvocation(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node segment.mjs <file.md>');
    process.exit(1);
  }
  // Segment the SAME canonical pre-payload source assemble.mjs will derive
  // spans against (existing payloads stripped, trailing content after them
  // spliced in, whitespace normalized). Segmenting the raw file verbatim —
  // as this CLI originally did — made the documented refresh flow
  // structurally broken for already-tagged files: the payload comment
  // itself segmented as a giant prose block whose id could never resolve
  // once assemble stripped the payload before re-deriving.
  const rawFull = readFileSync(path, 'utf8');
  const source = prePayloadSource(rawFull);
  if (hasDamagedEofMarker(source)) {
    console.error(
      `segment.mjs: ${path} has marker-like text at EOF that is not a valid payload — ` +
      `likely a damaged payload block. Delete it (or restore the file from version ` +
      `control) before segmenting; refusing to treat it as document content.`,
    );
    process.exit(1);
  }
  const result = segment(source);
  console.log(JSON.stringify({ docPath: path, ...result }, null, 2));
}
