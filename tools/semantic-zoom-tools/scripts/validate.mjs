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

import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Exported as the single JS source of the marker sentinels — assemble.mjs
// imports these rather than declaring its own copies, so a marker-format
// change (v2) has exactly one JS site to update. (Rust hardcodes its own
// copy by design — the two sides are deliberate mirrors of the contract in
// docs/prompts/payload-format.md.)
export const MARKER_HEAD = '<!-- semantic-zoom:payload:v1';
export const MARKER_TAIL = '-->';

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

// ---------------------------------------------------------------------------
// Shared payload-detection primitives. These live HERE (the dependency-free
// base of the plugin's import graph) so segment.mjs and assemble.mjs can both
// use them without a cycle (assemble imports segment, so nothing here may
// import either). validate() below deliberately does NOT use
// findExistingPayload: its job is to mirror what the app reports for a file
// (a marker-shaped-but-broken block is Corrupt, not absent), whereas these
// primitives answer the authoring-side question "is there a genuine payload
// here to strip before re-deriving?".
// ---------------------------------------------------------------------------

/**
 * The LookupTable's required top-level keys, per the JSON Schema in
 * docs/prompts/payload-format.md and the Rust struct's typed deserialize.
 * Hand-copied deliberately: the plugin must stay standalone-installable
 * (CLAUDE_PLUGIN_ROOT can live outside this repo), so it can't reach into
 * src/engine/payload.schema.json at runtime — tests/schema-drift.test.mjs
 * pins the two lists together whenever the repo copy is present instead.
 */
export const REQUIRED_TOP_LEVEL_KEYS = ['version', 'docHash', 'meta', 'sections', 'paragraphs', 'order'];

/**
 * Shape gate for "is this parsed JSON actually a LookupTable": mirrors the
 * Rust extractor's typed `serde_json::from_str::<LookupTable>`, which
 * rejects wrong-shaped JSON as surely as non-JSON. Without this, a prose
 * document quoting a small valid-JSON example of the payload would be
 * mistaken for a real payload (a bare JSON.parse check let exactly that
 * through).
 */
export function looksLikeLookupTable(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    REQUIRED_TOP_LEVEL_KEYS.every((key) => key in value)
  );
}

/**
 * Locate an EXISTING, genuine payload: returns { head, end } (end = index
 * just past the closing tail) or null.
 *
 * Why this is more than a `lastIndexOf(MARKER_HEAD)`: prose that merely
 * DESCRIBES the marker syntax contains the marker text with no payload
 * anywhere (a real incident while tagging docs/semantic-zoom-tools.md —
 * the doc's own opening sentence got matched and everything after it was
 * truncated as "the old payload"). So a candidate only counts if its
 * content parses as JSON AND has the LookupTable shape, mirroring the
 * Rust extractor's typed deserialize.
 *
 * Two deliberate details:
 * - The tail is the FIRST `-->` after the head, not the file's last: A3
 *   escaping guarantees a payload this tool wrote contains no literal
 *   `-->`, so the first one after the head IS the payload's own closer.
 *   Scanning for the LAST tail let any stray `-->` in content after the
 *   payload corrupt the candidate slice and un-detect a tagged file.
 * - Heads are scanned backward (last first), so marker text quoted in
 *   prose BEFORE a real payload never shadows it, and a quoted example
 *   that doesn't parse simply falls through to the next candidate.
 *
 * No un-escape before JSON.parse: the A3-escaped sequence in the file
 * bytes is already a legal JSON string escape, which JSON.parse resolves
 * natively.
 */
export function findExistingPayload(rawFull) {
  let searchEnd = rawFull.length;
  while (searchEnd > 0) {
    const head = rawFull.lastIndexOf(MARKER_HEAD, searchEnd - 1);
    if (head === -1) return null;
    const jsonStart = head + MARKER_HEAD.length;
    const tail = rawFull.indexOf(MARKER_TAIL, jsonStart);
    if (tail !== -1) {
      let parsed;
      try {
        parsed = JSON.parse(rawFull.slice(jsonStart, tail).trim());
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && looksLikeLookupTable(parsed)) {
        return { head, end: tail + MARKER_TAIL.length };
      }
    }
    searchEnd = head;
  }
  return null;
}

/**
 * Strip every genuine payload from `raw`, PRESERVING any content that sits
 * after one: text appended after the (invisible) payload comment is the
 * natural way a file grows at EOF, and a bare `slice(0, head)` silently
 * deleted it. Spliced content is joined with a blank line so it becomes
 * ordinary trailing blocks of the body. Loops in case earlier tool
 * versions ever accreted multiple payloads.
 *
 * This is THE definition of the pre-payload source both CLIs must agree
 * on: segment.mjs segments exactly this text, and assemble.mjs re-derives
 * spans against exactly this text — any divergence between the two would
 * make step-1 ids unresolvable in step 3.
 */
export function stripPayloads(raw) {
  let text = raw;
  for (let found = findExistingPayload(text); found; found = findExistingPayload(text)) {
    const pre = text.slice(0, found.head).replace(/\s+$/, '');
    const trailing = text.slice(found.end).trim();
    text = trailing ? `${pre}\n\n${trailing}` : pre;
  }
  return text;
}

/**
 * True when marker-LIKE text sits at EOF (nothing but whitespace after it)
 * without being a genuine payload — almost certainly a DAMAGED payload
 * (truncated JSON, mangled merge). Callers should refuse loudly rather
 * than silently treat the garbage as document content (which would lock it
 * into the file as prose while the app shows the file as Corrupt). Marker
 * text quoted mid-document has real content after it and returns false.
 * Call on ALREADY-STRIPPED text (stripPayloads) so a genuine payload
 * doesn't mask damaged residue.
 */
export function hasDamagedEofMarker(text) {
  const lastHead = text.lastIndexOf(MARKER_HEAD);
  if (lastHead === -1) return false;
  const lastTail = text.lastIndexOf(MARKER_TAIL);
  const blockEnd = lastTail > lastHead ? lastTail + MARKER_TAIL.length : text.length;
  return text.slice(blockEnd).trim() === '';
}

/**
 * The canonical pre-payload source both segment.mjs (CLI) and assemble.mjs
 * derive ids/spans from: genuine payloads stripped, trailing whitespace
 * normalized (so repeated assembly converges byte-identically instead of
 * accumulating padding).
 */
export function prePayloadSource(raw) {
  return stripPayloads(raw).replace(/\s+$/, '');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Exported so hook-validate.mjs can call this in-process — no subprocess,
// no second ${CLAUDE_PLUGIN_ROOT}-dependent path to resolve (see README's
// note on the documented CLAUDE_PLUGIN_ROOT-unset flakiness for some hook
// events; sidestepping the problem beats defending against it twice).
// Returns { ok: true, noMarker?: true } or { ok: false, errors: string[] }.
export function validate(raw) {
  // lastIndexOf, not indexOf: the app's Rust extractor locates the head
  // with `rfind` too, not just the tail below — the real payload lives at
  // EOF. A forward indexOf here matches the first occurrence of the marker
  // TEXT anywhere in the file, which is a real failure mode for a document
  // that describes the marker syntax in its own prose (this file's sibling
  // assemble.mjs hit exactly this while tagging docs/semantic-zoom-tools.md
  // — its own explanatory sentence mentioning the marker got matched as if
  // it were a real payload).
  const head = raw.lastIndexOf(MARKER_HEAD);
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
