// assemble.mjs — portable core extracted from
// tools/semantic-zoom-tools/scripts/assemble.mjs (T4): merges segments +
// layers into a LookupTable object. Unlike the CLI script, this module does
// NOT touch the filesystem and does NOT embed the marker/apply A3 escaping
// — those stay CLI-specific (tools/semantic-zoom-tools/scripts/assemble.mjs)
// or become Rust's job (write_payload, T8) for the app path. This file's
// only output is the table object + docHash, built purely from strings.
//
// Enforces the same contract as the original: D6 content-addressed ids,
// A1 docHash scope, §4.1 contiguity. Throws AssembleError with a message
// naming the exact violation on any failure — never returns a partial table.

import { segment } from './segment.mjs';
import { contentHash8, sha256HexOfBytes } from './sha256.mjs';

export class AssembleError extends Error {}

function fail(msg) {
  throw new AssembleError(msg);
}

/**
 * @param {string} raw pre-payload source (already stripped of any existing
 *   payload and whitespace-normalized — callers use marker.mjs's
 *   prePayloadSource for this).
 * @param {{meta: object[], sections: object[]}} layers model-authored grouping.
 * @returns {{ table: object, docHash: string }}
 */
export function buildLookupTable(raw, layers) {
  const rawBytes = new TextEncoder().encode(raw);
  const { blocks } = segment(raw);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const validIds = new Set(byId.keys());
  const indexOf = new Map(blocks.map((b, i) => [b.id, i]));

  const claimed = new Set();
  const paragraphs = {};
  const sections = {};
  const sectionOrder = [];

  for (const s of layers.sections) {
    if (!s.paragraphs || s.paragraphs.length === 0) {
      fail(`section "${s.key}": no paragraphs listed`);
    }
    const idxs = s.paragraphs.map((id) => {
      if (!validIds.has(id)) {
        fail(`section "${s.key}": id ${id} does not exist in segments — ` +
          `never invent IDs, re-run segment() if content changed`);
      }
      if (claimed.has(id)) fail(`paragraph ${id} claimed by more than one section`);
      claimed.add(id);
      return indexOf.get(id);
    });
    const sorted = [...idxs].sort((a, b) => a - b);
    if (JSON.stringify(idxs) !== JSON.stringify(sorted)) {
      fail(`section "${s.key}": paragraphs must be listed in document order`);
    }
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k] !== sorted[k - 1] + 1) {
        fail(`section "${s.key}": paragraphs are not contiguous in document order ` +
          `(gap between position ${sorted[k - 1]} and ${sorted[k]}) — a .pgroup ` +
          `must wrap one uninterrupted run of blocks (plan §4.1)`);
      }
    }

    const sid = `S-${contentHash8(byId.get(s.paragraphs[0]).text)}`;
    sections[s.key] = { sid, title: s.title, body: s.body, children: s.paragraphs };
    sectionOrder.push(s.key);
    for (const id of s.paragraphs) {
      const b = byId.get(id);
      paragraphs[id] = {
        id, level: 0, parent: sid, kind: b.kind,
        span: b.span, html: b.html, ...(b.lang ? { lang: b.lang } : {}),
      };
    }
  }

  const sidOrdinals = new Map();
  for (const key of sectionOrder) {
    const base = sections[key].sid;
    const n = sidOrdinals.get(base) ?? 0;
    sidOrdinals.set(base, n + 1);
    sections[key].sid = `${base}-${n}`;
  }
  for (const key of sectionOrder) {
    for (const pid of sections[key].children) paragraphs[pid].parent = sections[key].sid;
  }

  const uncovered = blocks.filter((b) => !claimed.has(b.id));
  if (uncovered.length) {
    fail(`${uncovered.length} block(s) not assigned to any section, e.g. ${uncovered[0].id} ` +
      `(${uncovered[0].kind}: ${uncovered[0].text.slice(0, 40)}…)`);
  }

  const meta = {};
  const metaOrder = [];
  const seenSectionKeys = new Set();
  layers.meta.forEach((m, i) => {
    const mid = `M${i + 1}`;
    const childSids = m.sections.map((key) => {
      if (!sections[key]) fail(`meta "${m.title}": references unknown section key "${key}"`);
      if (seenSectionKeys.has(key)) fail(`section "${key}" claimed by more than one meta node`);
      seenSectionKeys.add(key);
      return sections[key].sid;
    });
    if (childSids.length === 0) fail(`meta "${m.title}": no sections listed`);
    meta[mid] = { id: mid, level: -2, title: m.title, body: m.body, children: childSids };
    metaOrder.push(mid);
  });
  const uncoveredSections = sectionOrder.filter((k) => !seenSectionKeys.has(k));
  if (uncoveredSections.length) fail(`section(s) not assigned to any meta node: ${uncoveredSections.join(', ')}`);

  const sectionNodes = {};
  for (const key of sectionOrder) {
    const s = sections[key];
    const parentMid = metaOrder.find((mid) => meta[mid].children.includes(s.sid));
    sectionNodes[s.sid] = { id: s.sid, level: -1, parent: parentMid, children: s.children, title: s.title, body: s.body };
  }

  const orderParagraphs = blocks.map((b) => b.id);
  const orderSections = sectionOrder.map((k) => sections[k].sid);

  // A1: docHash over the exact bytes that will precede the marker in the
  // written file — same newline-padding convention as the CLI's assemble.mjs.
  const prefix = raw + (raw.endsWith('\n') ? '' : '\n') + '\n';
  const docHash = sha256HexOfBytes(new TextEncoder().encode(prefix));

  const table = {
    version: 1,
    docHash,
    meta,
    sections: sectionNodes,
    paragraphs,
    order: { meta: metaOrder, sections: orderSections, paragraphs: orderParagraphs },
  };

  // D6 self-check: recompute every id from its own span, mirroring Rust
  // verify_ids() so this can never produce a table the app itself would reject.
  const decoder = new TextDecoder('utf-8');
  for (const [id, p] of Object.entries(paragraphs)) {
    const slice = decoder.decode(rawBytes.subarray(p.span.start, p.span.end));
    const h = contentHash8(slice);
    if (!id.startsWith(`P-${h}-`)) fail(`internal error: ${id} does not match recomputed hash P-${h}-*`);
  }

  return { table, docHash, prefix };
}
