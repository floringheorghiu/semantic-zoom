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
//
// T4: the payload-marker primitives (MARKER_HEAD/TAIL, findExistingPayload,
// stripPayloads, hasDamagedEofMarker, prePayloadSource,
// REQUIRED_TOP_LEVEL_KEYS, looksLikeLookupTable) and the SHA-256
// implementation now live in ../../../src/native/zoom-tools/ — a portable
// module shared with the app's Engine B path (src/native/engine-b-remote.ts),
// not duplicated here. This file re-exports them so every existing import
// site (tests, other scripts, the hook) keeps working unchanged.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { contentHash8, sha256HexOfBytes } from '../../../src/native/zoom-tools/sha256.mjs';
import {
  MARKER_HEAD,
  MARKER_TAIL,
  REQUIRED_TOP_LEVEL_KEYS,
  looksLikeLookupTable,
  findExistingPayload,
  stripPayloads,
  hasDamagedEofMarker,
  prePayloadSource,
} from '../../../src/native/zoom-tools/marker.mjs';

export {
  MARKER_HEAD,
  MARKER_TAIL,
  REQUIRED_TOP_LEVEL_KEYS,
  looksLikeLookupTable,
  findExistingPayload,
  stripPayloads,
  hasDamagedEofMarker,
  prePayloadSource,
};

/**
 * True when this module is the file node was asked to run (CLI), false when
 * imported. The naive `import.meta.url === 'file://' + process.argv[1]`
 * comparison used previously is wrong in four separate ways: argv[1] may be
 * relative (`node validate.mjs x.md`), may contain characters that
 * percent-encode in URLs (spaces, non-ASCII), may reach the script through a
 * symlink (node resolves the main module's realpath; even /tmp vs
 * /private/tmp on macOS broke it), and never matches on Windows drive paths.
 * In every one of those cases the guard silently evaluates false and the
 * script exits 0 HAVING DONE NOTHING — the caller reads that as success.
 * realpath + pathToFileURL handles all four.
 */
export function isCliInvocation(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// Exported so hook-validate.mjs can call this in-process — no subprocess,
// no second ${CLAUDE_PLUGIN_ROOT}-dependent path to resolve (see README's
// note on the documented CLAUDE_PLUGIN_ROOT-unset flakiness for some hook
// events; sidestepping the problem beats defending against it twice).
// Returns { ok: true, noMarker?: true } or { ok: false, errors: string[] }.
export function validate(raw) {
  // Use the same backward-scan + shape-check as findExistingPayload(),
  // not a bare lastIndexOf/lastIndexOf pair: a single "last head, last
  // tail" scan treats ANY prose that merely quotes the marker syntax (e.g.
  // this plugin's own skill docs, or docs/prompts/payload-format.md) as a
  // corrupt payload, because the marker text itself matches HEAD with no
  // real JSON following it. Scanning candidates backward and requiring a
  // shape match before accepting one lets such prose fall through to
  // "no marker" instead of "corrupt marker" — this exact gap shipped once
  // (this function mirrored the naive form even after findExistingPayload
  // was hardened) and misclassified this skill's own SKILL.md as corrupt.
  const found = findExistingPayload(raw);
  let head, tail, table;

  if (found) {
    ({ head } = found);
    const jsonStart = head + MARKER_HEAD.length;
    tail = raw.indexOf(MARKER_TAIL, jsonStart); // first "-->" after head — see findExistingPayload's doc comment (A3)
    let jsonText = raw.slice(jsonStart, tail).trim();
    jsonText = jsonText.split('--\\u003e').join('-->'); // reverse A3 escaping
    table = JSON.parse(jsonText); // guaranteed to parse: findExistingPayload already confirmed this
  } else if (hasDamagedEofMarker(raw)) {
    return {
      ok: false,
      errors: ['marker-like text at end of file did not parse as a valid payload ' +
        '(truncated JSON or corrupted merge)'],
    };
  } else {
    return { ok: true, noMarker: true };
  }

  const preMarker = raw.slice(0, head);
  const preMarkerBytes = new TextEncoder().encode(preMarker);

  const errors = [];

  if (table.version !== 1) errors.push(`unsupported version: ${table.version}`);

  // A1: docHash must cover exactly the pre-marker bytes.
  const expectedHash = sha256HexOfBytes(preMarkerBytes);
  if (table.docHash !== expectedHash) {
    errors.push(`docHash mismatch: payload says ${table.docHash?.slice(0, 12)}…, ` +
      `recomputed ${expectedHash.slice(0, 12)}… — file was edited without re-running assemble.mjs`);
  }

  // Referential integrity, mirroring Rust validate().
  const { meta = {}, sections = {}, paragraphs = {}, order = {} } = table;
  const decoder = new TextDecoder('utf-8');

  for (const [pid, p] of Object.entries(paragraphs)) {
    if (p.level !== 0) errors.push(`${pid}: level must be 0`);
    if (!sections[p.parent]) errors.push(`${pid}: dangling parent ${p.parent}`);

    // D6 self-check (verify_ids): recompute hash from the span slice.
    const slice = decoder.decode(preMarkerBytes.subarray(p.span.start, p.span.end));
    if (!slice.trim()) {
      errors.push(`${pid}: span slice is empty — spans likely computed against the wrong region (A2)`);
    } else {
      const h = contentHash8(slice);
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
if (isCliInvocation(import.meta.url)) {
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
