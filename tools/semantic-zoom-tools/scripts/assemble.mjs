#!/usr/bin/env node
// assemble.mjs — merge segments.json + layers.json into a LookupTable
// payload and embed it in the source .md file.
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
// `paragraphs` MUST be real IDs from segments.json, listed in the exact
// contiguous document-order run they cover (see CONTIGUITY below).
//
// This script re-derives the whole payload from scratch every run. It
// never patches an existing embedded payload in place — regenerating from
// segments+layers is what keeps IDs, hashes, and spans mutually consistent;
// a hand-patch is exactly how the earlier Python fixture script's
// assumptions could have quietly drifted from Rust's.
//
// Enforces, matching Implementation_Plan.md:
//   D6  — every id is content-addressed; re-verified against segments.json.
//   A1  — docHash covers only bytes preceding the payload marker.
//   A2  — spans reference that same pre-payload region (true by construction:
//         segments.json was built from the file before this script ever runs).
//   A3  — any literal "-->" inside the JSON payload is escaped as "--\u003e".
//   §4.1 CONTIGUITY — a .pgroup wraps its children as one DOM container
//         (plan §4.1). A section's paragraph list must be a contiguous run
//         in document order; this script rejects non-contiguous groupings
//         rather than silently producing a payload the renderer can't
//         express as one wrapper element.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { segment } from './segment.mjs';
import {
  MARKER_HEAD,
  MARKER_TAIL,
  isCliInvocation,
  hasDamagedEofMarker,
  prePayloadSource,
} from './validate.mjs';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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
  const rawBytes = Buffer.from(raw, 'utf8');

  const layers = JSON.parse(readFileSync(layersPath, 'utf8'));
  const { blocks } = segment(raw);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const validIds = new Set(byId.keys());

  // ---- validate section paragraph lists: real IDs, contiguous, no reuse ----
  const claimed = new Set();
  const paragraphs = {};
  const sections = {};
  const sectionOrder = [];

  // Map each block id to its index in document order for contiguity checks.
  const indexOf = new Map(blocks.map((b, i) => [b.id, i]));

  for (const s of layers.sections) {
    if (!s.paragraphs || s.paragraphs.length === 0) {
      fail(`section "${s.key}": no paragraphs listed`);
    }
    const idxs = s.paragraphs.map((id) => {
      if (!validIds.has(id)) {
        fail(`section "${s.key}": id ${id} does not exist in segments.json — ` +
             `never invent IDs, re-run segment.mjs if content changed`);
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

    const sid = `S-${contentHashOfLeading(byId.get(s.paragraphs[0]).text)}`;
    // ordinal for repeated leading-block sections, same scheme as paragraphs
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

  // Resolve section ID collisions (two sections with identical leading-block
  // text) the same way paragraph IDs do: ordinal by first-appearance order.
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

  // ---- meta layer ----
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

  // ---- final section objects (drop the internal `key`) ----
  const sectionNodes = {};
  for (const key of sectionOrder) {
    const s = sections[key];
    const parentMid = metaOrder.find((mid) => meta[mid].children.includes(s.sid));
    sectionNodes[s.sid] = { id: s.sid, level: -1, parent: parentMid, children: s.children, title: s.title, body: s.body };
  }

  const orderParagraphs = blocks.map((b) => b.id);
  const orderSections = sectionOrder.map((k) => sections[k].sid);

  // ---- A1: docHash over the EXACT bytes that will precede the marker in
  // the WRITTEN file, not the pre-normalization source. A naive
  // `sha256(raw)` disagrees with a reader that hashes
  // `finalFile.slice(0, finalFile.lastIndexOf(MARKER_HEAD))` (rfind, per
  // the app's real extractor — see the lastIndexOf note near the top of
  // this file), because that slice includes whatever newline padding this
  // script inserts before the marker. Build the exact prefix first, hash
  // that, embed after. ----
  const prefix = raw + (raw.endsWith('\n') ? '' : '\n') + '\n';
  const docHash = sha256(Buffer.from(prefix, 'utf8'));

  const table = {
    version: 1,
    docHash,
    meta,
    sections: sectionNodes,
    paragraphs,
    order: { meta: metaOrder, sections: orderSections, paragraphs: orderParagraphs },
  };

  // ---- D6 self-check: recompute every id from its own span, mirroring
  // Rust verify_ids() so a payload this script produces can never fail
  // the check the app itself will run. ----
  for (const [id, p] of Object.entries(paragraphs)) {
    const slice = rawBytes.subarray(p.span.start, p.span.end).toString('utf8');
    const h = createHash('sha256').update(slice, 'utf8').digest('hex').slice(0, 8);
    if (!id.startsWith(`P-${h}-`)) fail(`internal error: ${id} does not match recomputed hash P-${h}-*`);
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

  console.log(`assembled: paragraphs=${Object.keys(paragraphs).length} ` +
    `sections=${Object.keys(sectionNodes).length} meta=${Object.keys(meta).length} ` +
    `docHash=${docHash.slice(0, 12)}… -> ${mdPath}`);
}

function contentHashOfLeading(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

// ---- CLI ---- (guarded so this module can be imported for its exports —
// e.g. by tests — without running main(). isCliInvocation, not a naive
// URL-string comparison: see its doc comment in validate.mjs for the four
// ways the naive form silently failed open.)
if (isCliInvocation(import.meta.url)) {
  main();
}
