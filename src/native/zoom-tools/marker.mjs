// marker.mjs — portable payload-marker detection, extracted from
// tools/semantic-zoom-tools/scripts/validate.mjs's dependency-free base.
// Pure string operations only (no node:fs, no node:crypto, no process) —
// safe to import from both the Node CLI and the Tauri webview.
//
// validate.mjs re-exports these rather than duplicating them, so this file
// is the single source; a marker-format change (v2) has exactly one site.

export const MARKER_HEAD = '<!-- semantic-zoom:payload:v1';
export const MARKER_TAIL = '-->';

export const REQUIRED_TOP_LEVEL_KEYS = ['version', 'docHash', 'meta', 'sections', 'paragraphs', 'order'];

export function looksLikeLookupTable(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    REQUIRED_TOP_LEVEL_KEYS.every((key) => key in value)
  );
}

/**
 * Locate an EXISTING, genuine payload: returns { head, end } or null.
 * See tools/semantic-zoom-tools/scripts/validate.mjs's original doc comment
 * for the full rationale (backward head scan, first-tail-after-head rule).
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

/** Strip every genuine payload from `raw`, preserving trailing content after one. */
export function stripPayloads(raw) {
  let text = raw;
  for (let found = findExistingPayload(text); found; found = findExistingPayload(text)) {
    const pre = text.slice(0, found.head).replace(/\s+$/, '');
    const trailing = text.slice(found.end).trim();
    text = trailing ? `${pre}\n\n${trailing}` : pre;
  }
  return text;
}

/** True when marker-LIKE text sits at EOF without being a genuine payload. */
export function hasDamagedEofMarker(text) {
  const lastHead = text.lastIndexOf(MARKER_HEAD);
  if (lastHead === -1) return false;
  const lastTail = text.lastIndexOf(MARKER_TAIL);
  const blockEnd = lastTail > lastHead ? lastTail + MARKER_TAIL.length : text.length;
  return text.slice(blockEnd).trim() === '';
}

/** The canonical pre-payload source both segment() and assemble() derive ids/spans from. */
export function prePayloadSource(raw) {
  return stripPayloads(raw).replace(/\s+$/, '');
}
