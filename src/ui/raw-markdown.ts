// src/ui/raw-markdown.ts
//
// Styled fallback for `Untagged`/`Corrupt` docs (plan §2.6): no payload means
// no `LookupTable`, so there are no `S-`/`P-` ids to key `.pgroup`/`.pnode` on
// (D6 — never fabricate one). But the raw markdown can still be rendered with
// the SAME typography/chrome as native k=0 — headings, tables, code blocks —
// instead of a single unstyled `<pre>` dump.
//
// One-shot, whole-document parse (not per-block slicing): slicing the raw text
// per top-level block before parsing would break constructs that span blocks
// (reference-style links, footnotes). Parsing once and then splitting the
// RESULT by top-level HTML elements gets the same per-block `.pnode` shape
// without that risk.
//
// Tauri-free: DOM + the remark/rehype unified pipeline only.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { decoratePnode } from './viewport';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify);

/**
 * Build the `.level-layer[data-level='0']` for a raw (untagged/corrupt) doc:
 * one `.pnode` per top-level markdown block, styled identically to native
 * k=0 paragraphs — just with no `data-pid` (nothing for the caret or the
 * content map to anchor to; both stay disabled for these docs).
 */
export function buildRawLevel(raw: string): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'level-layer';
  layer.dataset.level = '0';

  const column = document.createElement('div');
  column.className = 'reading-column';
  layer.appendChild(column);

  const html = String(processor.processSync(raw));
  const parsed = document.createElement('div');
  parsed.innerHTML = html;

  for (const block of Array.from(parsed.children)) {
    const node = document.createElement('div');
    node.className = 'pnode';
    node.appendChild(block);
    decoratePnode(node);
    column.appendChild(node);
  }

  return layer;
}
