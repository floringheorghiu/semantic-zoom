// segment.mjs — deterministic markdown -> block list, D6 content-addressed
// IDs. Portable core extracted from
// tools/semantic-zoom-tools/scripts/segment.mjs (T4): identical algorithm,
// but built on Web-standard primitives (TextEncoder/TextDecoder, the
// portable sha256.mjs) instead of node:crypto/Buffer, so this ONE file
// backs both the Node CLI and the Tauri webview (src/native/engine-b-remote.ts).
//
// `segment()` MUST stay synchronous: tests/segment.test.mjs (an
// unmodifiable oracle, per CLAUDE.md) calls `const { blocks } = segment(source)`
// without awaiting.
//
// id derivation (D6, plan §2.1): P-<sha256(text)[:8]>-<ordinal>

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { marked } from 'marked';
import { contentHash8 } from './sha256.mjs';

const KIND_MAP = {
  heading: 'heading',
  code: 'code',
  list: 'list',
  table: 'table',
  blockquote: 'blockquote',
  paragraph: 'prose',
  thematicBreak: null,
  html: 'prose',
  definition: null,
};

/**
 * unist/mdast `position.offset` is a JS-string (UTF-16 code unit) index,
 * not a UTF-8 byte offset — see the original segment.mjs's doc comment for
 * the full incident writeup (a silent corruption bug this conversion
 * fixes). Builds a JS-string-index -> UTF-8-byte-index lookup in one pass
 * over code points.
 */
function buildByteOffsetMap(source) {
  const map = new Uint32Array(source.length + 1);
  let byteOffset = 0;
  let charIndex = 0;
  const encoder = new TextEncoder();
  for (const ch of source) {
    map[charIndex] = byteOffset;
    byteOffset += encoder.encode(ch).length;
    charIndex += ch.length;
  }
  map[charIndex] = byteOffset;
  return map;
}

/** @param {string} source @returns {{ sourceLength: number, blocks: object[] }} */
export function segment(source) {
  const tree = unified().use(remarkParse).parse(source);
  const bytes = new TextEncoder().encode(source);
  const decoder = new TextDecoder('utf-8');
  const byteOffsetOf = buildByteOffsetMap(source);
  const ordinals = new Map();

  const rawBlocks = [];
  visit(tree, (node) => {
    if (node.type === 'root') return;
    const kind = KIND_MAP[node.type];
    if (kind === undefined) return;
    if (kind === null) return;
    if (!node.position) return;

    const start = byteOffsetOf[node.position.start.offset];
    const end = byteOffsetOf[node.position.end.offset];
    rawBlocks.push({ kind, start, end, node });
    return 'skip';
  });

  rawBlocks.sort((a, b) => a.start - b.start);

  const blocks = rawBlocks.map(({ kind, start, end, node }) => {
    const text = decoder.decode(bytes.subarray(start, end));
    const h = contentHash8(text);
    const n = ordinals.get(h) ?? 0;
    ordinals.set(h, n + 1);
    const id = `P-${h}-${n}`;

    const out = { id, kind, span: { start, end }, text };
    if (kind === 'code' && node.lang) out.lang = node.lang;
    out.html = marked.parse(text).trim();

    return out;
  });

  return { sourceLength: bytes.length, blocks };
}
