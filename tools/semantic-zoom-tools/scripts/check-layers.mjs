#!/usr/bin/env node
// check-layers.mjs — structural self-check on a hand-authored layers.json,
// run BEFORE assemble.mjs.
//
//   node check-layers.mjs <layers.json>
//
// assemble.mjs already enforces these same constraints and will refuse to
// write a bad payload — this script exists only to catch the mistake a
// step earlier, without needing segments.json, the parser dependencies, or
// a full assemble run. It checks layers.json in isolation:
//   - every section key is referenced by exactly one meta node's `sections`
//   - every meta `sections` entry names a section key that actually exists
//   - no section is referenced by more than one meta node
//   - every section has a non-empty `paragraphs` list
// It does NOT check paragraph IDs against segments.json or contiguity —
// that needs the parsed document and is assemble.mjs's job.

import { readFileSync } from 'node:fs';

function fail(msg) {
  console.error(`check-layers.mjs: ${msg}`);
  process.exit(1);
}

function main() {
  const [, , layersPath] = process.argv;
  if (!layersPath) fail('usage: node check-layers.mjs <layers.json>');

  const layers = JSON.parse(readFileSync(layersPath, 'utf8'));
  if (!Array.isArray(layers.sections) || !Array.isArray(layers.meta)) {
    fail('layers.json must have array fields "sections" and "meta"');
  }

  const sectionKeys = new Set();
  for (const s of layers.sections) {
    if (!s.key) fail('a section is missing its "key"');
    if (sectionKeys.has(s.key)) fail(`duplicate section key "${s.key}"`);
    sectionKeys.add(s.key);
    if (!Array.isArray(s.paragraphs) || s.paragraphs.length === 0) {
      fail(`section "${s.key}": no paragraphs listed`);
    }
  }

  const assigned = new Set();
  const duplicates = [];
  for (const m of layers.meta) {
    if (!Array.isArray(m.sections) || m.sections.length === 0) {
      fail(`meta "${m.title ?? '(untitled)'}": no sections listed`);
    }
    for (const key of m.sections) {
      if (!sectionKeys.has(key)) {
        fail(`meta "${m.title}": references unknown section key "${key}" — ` +
             `typo, or a section that was never added to layers.sections`);
      }
      if (assigned.has(key)) duplicates.push(key);
      assigned.add(key);
    }
  }
  if (duplicates.length) {
    fail(`section(s) claimed by more than one meta node: ${duplicates.join(', ')}`);
  }

  const missing = [...sectionKeys].filter((k) => !assigned.has(k));
  if (missing.length) {
    fail(`section(s) defined in "sections" but not assigned to any meta node's ` +
         `"sections" list: ${missing.join(', ')} — every section must end up ` +
         `under exactly one meta node`);
  }

  console.log(`check-layers.mjs: OK — ${sectionKeys.size} section(s) each assigned to ` +
    `exactly one of ${layers.meta.length} meta node(s)`);
}

main();
