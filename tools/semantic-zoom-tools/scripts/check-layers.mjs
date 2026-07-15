#!/usr/bin/env node
// check-layers.mjs — CLI wrapper around the portable checkLayers() core
// (T4: ../../../src/native/zoom-tools/check-layers.mjs), run BEFORE
// assemble.mjs on a hand-authored layers.json.
//
//   node check-layers.mjs <layers.json>
//
// assemble.mjs already enforces these same constraints and will refuse a
// bad payload — this script exists only to catch the mistake a step
// earlier, without needing segments, the parser dependencies, or a full
// assemble run. It checks layers.json in isolation:
//   - every section key is referenced by exactly one meta node's `sections`
//   - every meta `sections` entry names a section key that actually exists
//   - no section is referenced by more than one meta node
//   - every section has a non-empty `paragraphs` list
// It does NOT check paragraph IDs against segments or contiguity — that
// needs the parsed document and is assemble.mjs's job.

import { readFileSync } from 'node:fs';
import { checkLayers } from '../../../src/native/zoom-tools/check-layers.mjs';
import { isCliInvocation } from './validate.mjs';

function fail(msg) {
  console.error(`check-layers.mjs: ${msg}`);
  process.exit(1);
}

function main() {
  const [, , layersPath] = process.argv;
  if (!layersPath) fail('usage: node check-layers.mjs <layers.json>');

  const layers = JSON.parse(readFileSync(layersPath, 'utf8'));
  const result = checkLayers(layers);
  if (!result.ok) fail(result.errors[0]);

  console.log(`check-layers.mjs: OK — ${result.sectionCount} section(s) each assigned to ` +
    `exactly one of ${result.metaCount} meta node(s)`);
}

if (isCliInvocation(import.meta.url)) {
  main();
}
