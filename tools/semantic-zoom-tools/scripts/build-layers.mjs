#!/usr/bin/env node
// build-layers.mjs — starting-point helper for authoring layers.json on
// large files, where grouping ~100+ blocks by hand gets tedious.
//
// Usage:
//   node scripts/segment.mjs <file.md> | node scripts/build-layers.mjs > layers.json
//   node scripts/build-layers.mjs /tmp/segments.json > layers.json
//
// This is a STARTING POINT, not a generic zero-config tool. You MUST edit
// META_GROUPS and classify() below for the document you're tagging — the
// same grouping decision the skill's own step 2 asks a model to make by
// hand, just expressed as code instead of prose when there are too many
// sections to reason about one at a time. Ported from a Python helper an
// agent (MiMo Code) built ad hoc while tagging a large file in a sibling
// project; the algorithm is unchanged, just rewritten in JS to match this
// toolkit's dependency-free-script convention rather than adding a Python
// dependency to a Node plugin.
//
// Section splitting: every `##` heading starts a new section, running
// until the next `##` heading (so `###`+ subheadings and their content
// stay inside the enclosing `##` section — coarser than hand-grouping by
// subsection, but a reasonable default for a first pass). Content before
// the first `##` (including the `#` title) becomes a "preamble" section.
//
// Validates its own output before printing it (duplicate/missing
// paragraphs, duplicate/missing section-to-meta assignment, contiguity
// gaps) and reports warnings to stderr — this overlaps with what
// check-layers.mjs and assemble.mjs already enforce, deliberately: this
// script's checks run before either of those, on the grouping decision
// alone, without needing the source file or a full assemble pass.

import { readFileSync } from 'node:fs';

// ─── Customize these for your document ────────────────────────────────────

const META_GROUPS = [
  {
    title: 'Group 1 — Short human title',
    body: 'Plain-language narrative of what this group covers. Write for someone who wants the arc, not a table of contents.',
    match: ['keyword1', 'keyword2'], // section title substrings that map here
  },
  {
    title: 'Group 2 — Another grouping',
    body: 'What was accomplished / prerequisites / next step.',
    match: ['keyword3'],
  },
  // Add more groups as needed. Last group is the catch-all.
  {
    title: 'Other',
    body: 'Miscellaneous items.',
    match: [], // empty = catch-all
  },
];

/**
 * Map a section title to a META_GROUPS index. Override for each document.
 * Matching strategy: iterate META_GROUPS in order; first match wins. Each
 * group's `match` list contains substrings (case-insensitive), or a regex
 * via a "re:" prefix (e.g. "re:\\bphase\\s+ii\\b") — use regex with word
 * boundaries for numbered/ordered items (Phase I/II/III, Task 1-11) to
 * avoid "Phase I" matching inside "Phase II".
 */
function classify(sectionTitle) {
  const titleLower = sectionTitle.toLowerCase();
  for (let i = 0; i < META_GROUPS.length; i++) {
    for (const kw of META_GROUPS[i].match) {
      if (kw.startsWith('re:')) {
        if (new RegExp(kw.slice(3)).test(titleLower)) return i;
      } else if (titleLower.includes(kw.toLowerCase())) {
        return i;
      }
    }
  }
  return META_GROUPS.length - 1; // catch-all
}

// ─── Boilerplate below — usually no need to edit ───────────────────────────

function readSegments() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(readFileSync(arg, 'utf8'));
  return JSON.parse(readFileSync(0, 'utf8')); // stdin
}

function main() {
  const { blocks } = readSegments();

  // Build sections: each `##` heading starts a new section.
  const sections = [];
  let current = null;
  const preambleIds = [];

  for (const b of blocks) {
    const isH1 = b.kind === 'heading' && b.text.startsWith('# ') && !b.text.startsWith('## ');
    const isH2 = b.kind === 'heading' && b.text.startsWith('## ');
    if (isH1) {
      preambleIds.push(b.id);
    } else if (isH2) {
      current = { key: b.id, title: b.text.replace(/^#+\s*/, '').trim(), body: '', paragraphs: [b.id] };
      sections.push(current);
    } else if (current) {
      current.paragraphs.push(b.id);
    } else {
      preambleIds.push(b.id);
    }
  }

  if (preambleIds.length) {
    sections.unshift({
      key: 'preamble',
      title: blocks[0] ? blocks[0].text.replace(/^#+\s*/, '').trim() : 'Preamble',
      body: 'Document header and introduction.',
      paragraphs: preambleIds,
    });
  }

  // Assign sections to meta groups.
  const metaLists = META_GROUPS.map(() => []);
  for (const s of sections) metaLists[classify(s.title)].push(s.key);

  const meta = META_GROUPS
    .map((g, i) => ({ title: g.title, body: g.body, sections: metaLists[i] }))
    .filter((_, i) => metaLists[i].length > 0);

  const layers = {
    meta,
    sections: sections.map((s) => ({ key: s.key, title: s.title, body: s.body, paragraphs: s.paragraphs })),
  };

  // ─── Validation (warnings to stderr; doesn't block output) ───────────────
  const allPara = new Set();
  let dupes = 0;
  for (const s of layers.sections) {
    for (const pid of s.paragraphs) {
      if (allPara.has(pid)) { console.error(`WARNING: duplicate paragraph ${pid}`); dupes++; }
      allPara.add(pid);
    }
  }

  const blockIds = new Set(blocks.map((b) => b.id));
  const missing = [...blockIds].filter((id) => !allPara.has(id));
  if (missing.length) console.error(`WARNING: ${missing.length} blocks not in any section: ${missing.join(', ')}`);

  const allSectionKeys = new Set();
  let sectionDupes = 0;
  for (const m of layers.meta) {
    for (const sk of m.sections) {
      if (allSectionKeys.has(sk)) { console.error(`WARNING: duplicate section ${sk}`); sectionDupes++; }
      allSectionKeys.add(sk);
    }
  }

  const sectionKeySet = new Set(layers.sections.map((s) => s.key));
  const missingS = [...sectionKeySet].filter((k) => !allSectionKeys.has(k));
  if (missingS.length) console.error(`WARNING: ${missingS.length} sections not in any meta: ${missingS.join(', ')}`);

  const blockIndex = new Map(blocks.map((b, i) => [b.id, i]));
  let gaps = 0;
  for (const s of layers.sections) {
    const indices = s.paragraphs.map((pid) => blockIndex.get(pid)).filter((i) => i !== undefined);
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1] + 1) {
        console.error(`WARNING: section '${s.title}' has gap at block index ${indices[i - 1]} -> ${indices[i]}`);
        gaps++;
      }
    }
  }

  console.error(`Sections: ${layers.sections.length}, Meta: ${layers.meta.length}`);
  console.error(`Paragraphs: ${allPara.size}/${blockIds.size}, Dupes: ${dupes + sectionDupes}, Gaps: ${gaps}`);

  process.stdout.write(JSON.stringify(layers, null, 2) + '\n');
}

main();
