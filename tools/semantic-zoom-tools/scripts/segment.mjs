#!/usr/bin/env node
// segment.mjs — deterministic markdown → block list, D6 content-addressed IDs.
//
// Uses `unified` + `remark-parse` + `unist-util-visit` — the SAME parser
// family Engine B specifies (Implementation_Plan.md §2.7) — instead of an
// ad hoc regex splitter. This is the whole reason this script exists in
// Node rather than reusing the earlier Python fixture-builder: segmentation
// done with a different parser can silently diverge from what the shipping
// app actually produces. Divergence here would be invisible until Engine B
// ships and disagrees with every payload this tool ever generated.
//
// Output (stdout): JSON { docPath, sourceLength, blocks: [...] }
// Each block: { id, kind, span:{start,end}, lang?, text, html }
//
// id derivation (D6, plan §2.1): P-<sha256(text)[:8]>-<ordinal>
//   - ordinal = 0-based occurrence count among blocks sharing that hash,
//     in document order. Identical blocks (repeated separators, duplicate
//     code fences) get distinct, deterministic IDs.
//   - spans are byte offsets (UTF-8) into the source AS GIVEN to this
//     script. Run this against the file BEFORE any payload marker is
//     appended (addendum A2) — assemble.mjs enforces this by always
//     segmenting the pre-payload region only.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { marked } from 'marked';
import { isCliInvocation, prePayloadSource, hasDamagedEofMarker } from './validate.mjs';

const KIND_MAP = {
  heading: 'heading',
  code: 'code',
  list: 'list',
  table: 'table',
  blockquote: 'blockquote',
  paragraph: 'prose',
  thematicBreak: null,   // skipped — not renderable content
  html: 'prose',         // raw HTML blocks: treated as prose, rendered as-is
  definition: null,      // link reference definitions: no visual content
};

function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * unist/mdast `position.offset` is defined as a character index into the JS
 * SOURCE STRING (UTF-16 code units) — NOT a UTF-8 byte offset. The two are
 * identical for pure ASCII, which is why this was invisible against the
 * bundled synthetic example, but this project's actual prose is full of
 * em dashes, arrows, and curly quotes — every one of those is 1 JS "char"
 * but 2-3 UTF-8 bytes, so remark's offsets drift further from true byte
 * positions with every non-ASCII character earlier in the document.
 *
 * The app's Rust side (verify_ids, A2) and this script's own Buffer slicing
 * both operate on real UTF-8 BYTES, so every offset out of remark must be
 * converted before use. This is silently self-consistent if you don't
 * convert — the id and its hash are both derived from the same wrong byte
 * range, so verify_ids() still passes — only the actual sliced CONTENT is
 * corrupted (cut mid-character/mid-word), invisible unless you read it.
 *
 * Returns a lookup: JS string index -> UTF-8 byte index, built in one pass
 * over code points (so surrogate-pair/astral characters convert correctly
 * too, not just BMP ones).
 */
function buildByteOffsetMap(source) {
  const map = new Uint32Array(source.length + 1);
  let byteOffset = 0;
  let charIndex = 0;
  for (const ch of source) { // iterates by CODE POINT, combining surrogate pairs
    map[charIndex] = byteOffset;
    byteOffset += Buffer.byteLength(ch, 'utf8');
    charIndex += ch.length; // 1 for BMP, 2 for astral
  }
  map[charIndex] = byteOffset;
  return map;
}

export function segment(source) {
  const tree = unified().use(remarkParse).parse(source);
  const bytes = Buffer.from(source, 'utf8');
  const byteOffsetOf = buildByteOffsetMap(source);
  const ordinals = new Map(); // hash -> next ordinal

  const rawBlocks = [];
  visit(tree, (node) => {
    if (node.type === 'root') return;
    const kind = KIND_MAP[node.type];
    if (kind === undefined) return; // unrecognized node type: skip, don't crash
    if (kind === null) return;      // recognized but intentionally excluded
    if (!node.position) return;

    // Convert remark's character offsets to real UTF-8 byte offsets (A2) —
    // see buildByteOffsetMap's doc comment for why this is load-bearing.
    const start = byteOffsetOf[node.position.start.offset];
    const end = byteOffsetOf[node.position.end.offset];
    rawBlocks.push({ kind, start, end, node });
    return 'skip'; // don't descend into block children — top-level blocks only
  });

  // Sort by position (visit is already document-order, but be explicit —
  // correctness here matters more than trusting traversal order).
  rawBlocks.sort((a, b) => a.start - b.start);

  const blocks = rawBlocks.map(({ kind, start, end, node }) => {
    const text = bytes.subarray(start, end).toString('utf8');
    const h = contentHash(text);
    const n = ordinals.get(h) ?? 0;
    ordinals.set(h, n + 1);
    const id = `P-${h}-${n}`;

    const out = { id, kind, span: { start, end }, text };
    if (kind === 'code' && node.lang) out.lang = node.lang;

    // HTML rendering: per-block markdown→HTML via `marked`, independent of
    // the remark AST used for offsets/kind. This is a deliberate scope
    // split — remark's AST is authoritative for WHERE and WHAT KIND a block
    // is; marked's CommonMark rendering is authoritative for the HTML the
    // app displays. Both implement CommonMark, so divergence is limited to
    // GFM-extension edge cases (tables, strikethrough), not core structure.
    out.html = kind === 'code'
      ? marked.parse(text).trim()
      : marked.parse(text).trim();

    return out;
  });

  return { sourceLength: bytes.length, blocks };
}

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
