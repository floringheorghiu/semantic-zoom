#!/usr/bin/env node
// validate.mjs — standalone check for an already-embedded .md file.
// Used directly by the assembler's own self-check, by the skill's final
// step, and by the PostToolUse hook (hooks/hooks.json) so drift is caught
// the moment ANY tool writes to a payload-bearing file — not just when
// this plugin's own assemble.mjs was used.
//
//   node validate.mjs <file.md>
//
// Exit 0, silent: no marker present (not this tool's concern) OR valid.
// Exit 1: marker present but malformed/invalid — prints one finding per line.
//
// Mirrors, independently, everything Implementation_Plan.md §2.3/§2.6
// specifies for the Rust side:
//   - extraction via the LAST "-->" occurrence (A3 defense in depth)
//   - referential integrity (dangling parents, missing/duplicate children)
//   - D6 id↔content-hash agreement (verify_ids)
//   - A1 docHash agreement (recomputed over pre-marker bytes)

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MARKER_HEAD = '<!-- semantic-zoom:payload:v1';
const MARKER_TAIL = '-->';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Exported so hook-validate.mjs can call this in-process — no subprocess,
// no second ${CLAUDE_PLUGIN_ROOT}-dependent path to resolve (see README's
// note on the documented CLAUDE_PLUGIN_ROOT-unset flakiness for some hook
// events; sidestepping the problem beats defending against it twice).
// Returns { ok: true, noMarker?: true } or { ok: false, errors: string[] }.
export function validate(raw) {
  const head = raw.indexOf(MARKER_HEAD);
  if (head === -1) return { ok: true, noMarker: true };

  const jsonStart = head + MARKER_HEAD.length;
  // rfind, not find (A3): a producer that failed to escape an internal
  // "-->" would otherwise truncate here silently. Matching the last
  // occurrence is what the Rust extractor does per the plan's hardening.
  const tail = raw.lastIndexOf(MARKER_TAIL);
  if (tail === -1 || tail < jsonStart) {
    return { ok: false, errors: ['malformed marker: no closing "-->" found after payload head'] };
  }

  const preMarker = raw.slice(0, head);
  const preMarkerBytes = Buffer.from(preMarker, 'utf8');

  let jsonText = raw.slice(jsonStart, tail).trim();
  jsonText = jsonText.split('--\\u003e').join('-->'); // reverse A3 escaping

  let table;
  try {
    table = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, errors: [`payload is not valid JSON: ${e.message}`] };
  }

  const errors = [];

  if (table.version !== 1) errors.push(`unsupported version: ${table.version}`);

  // A1: docHash must cover exactly the pre-marker bytes.
  const expectedHash = sha256(preMarkerBytes);
  if (table.docHash !== expectedHash) {
    errors.push(`docHash mismatch: payload says ${table.docHash?.slice(0, 12)}…, ` +
      `recomputed ${expectedHash.slice(0, 12)}… — file was edited without re-running assemble.mjs`);
  }

  // Referential integrity, mirroring Rust validate().
  const { meta = {}, sections = {}, paragraphs = {}, order = {} } = table;

  for (const [pid, p] of Object.entries(paragraphs)) {
    if (p.level !== 0) errors.push(`${pid}: level must be 0`);
    if (!sections[p.parent]) errors.push(`${pid}: dangling parent ${p.parent}`);

    // D6 self-check (verify_ids): recompute hash from the span slice.
    const slice = preMarkerBytes.subarray(p.span.start, p.span.end).toString('utf8');
    if (!slice.trim()) {
      errors.push(`${pid}: span slice is empty — spans likely computed against the wrong region (A2)`);
    } else {
      const h = createHash('sha256').update(slice, 'utf8').digest('hex').slice(0, 8);
      if (!pid.startsWith(`P-${h}-`)) {
        errors.push(`${pid}: content hash mismatch (span text hashes to ${h}, id claims otherwise)`);
      }
    }
  }

  for (const [sid, s] of Object.entries(sections)) {
    if (s.level !== -1) errors.push(`${sid}: level must be -1`);
    if (!meta[s.parent]) errors.push(`${sid}: dangling parent ${s.parent}`);
    if (!s.children || s.children.length === 0) errors.push(`${sid}: no children`);
    for (const c of s.children ?? []) {
      if (!paragraphs[c]) errors.push(`${sid}: missing child ${c}`);
      else if (paragraphs[c].parent !== sid) errors.push(`${c}: parent mismatch (claims ${paragraphs[c].parent}, section says ${sid})`);
    }
  }

  for (const [mid, m] of Object.entries(meta)) {
    if (m.level !== -2) errors.push(`${mid}: level must be -2`);
    if (!m.children || m.children.length === 0) errors.push(`${mid}: no children`);
    for (const c of m.children ?? []) {
      if (!sections[c]) errors.push(`${mid}: missing child ${c}`);
    }
  }

  const coveredParagraphs = new Set(Object.values(sections).flatMap((s) => s.children ?? []));
  const orphanParagraphs = Object.keys(paragraphs).filter((p) => !coveredParagraphs.has(p));
  if (orphanParagraphs.length) errors.push(`orphan paragraph(s) not claimed by any section: ${orphanParagraphs.join(', ')}`);

  const coveredSections = new Set(Object.values(meta).flatMap((m) => m.children ?? []));
  const orphanSections = Object.keys(sections).filter((s) => !coveredSections.has(s));
  if (orphanSections.length) errors.push(`orphan section(s) not claimed by any meta node: ${orphanSections.join(', ')}`);

  // order arrays must be permutations of the actual key sets
  for (const [label, arr, keys] of [
    ['order.meta', order.meta, Object.keys(meta)],
    ['order.sections', order.sections, Object.keys(sections)],
    ['order.paragraphs', order.paragraphs, Object.keys(paragraphs)],
  ]) {
    if (!arr) { errors.push(`${label} missing`); continue; }
    const a = new Set(arr), b = new Set(keys);
    if (a.size !== b.size || [...a].some((x) => !b.has(x))) errors.push(`${label} does not match the actual node set`);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node validate.mjs <file.md>');
    process.exit(1);
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`cannot read ${path}: ${e.message}`);
    process.exit(1);
  }
  const result = validate(raw);
  if (!result.ok) {
    console.error(`INVALID (${path}) — ${result.errors.length} issue(s):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  process.exit(0);
}
