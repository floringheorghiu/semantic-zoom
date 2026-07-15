// output-contract.mjs — mechanical checks on the model's raw JSON response,
// per docs/prompts/engine-b-synthesis.md's "Output contract" section. Runs
// BEFORE the response is reshaped into layers.json / handed to
// buildLookupTable — catches drops/dupes/reorders/forbidden-key leakage
// with one purpose-built check each, so a retry's corrective message names
// the exact violation instead of a generic "invalid output."

function forbiddenKeysPresent(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null; // guard against pathological cycles
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = forbiddenKeysPresent(v, seen);
      if (found) return found;
    }
    return null;
  }
  for (const key of ['id', 'level', 'parent', 'docHash', 'order']) {
    if (key in value) return key;
  }
  for (const v of Object.values(value)) {
    const found = forbiddenKeysPresent(v, seen);
    if (found) return found;
  }
  return null;
}

function containsMarkerCloser(value, seen = new Set()) {
  if (typeof value === 'string') return value.includes('-->');
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some((v) => containsMarkerCloser(v, seen));
}

/**
 * @param {unknown} parsed the model's JSON.parse'd response
 * @param {string[]} inputIds the paragraph index ids, in document order
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkOutputContract(parsed, inputIds) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'top-level output must be a single JSON object' };
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'meta,sections') {
    return { ok: false, error: `top-level keys must be exactly "meta" and "sections" — got: ${keys.join(', ') || '(none)'}` };
  }
  if (!parsed.meta || typeof parsed.meta !== 'object' || Array.isArray(parsed.meta)) {
    return { ok: false, error: '"meta" must be a single object with "title" and "body"' };
  }
  if (typeof parsed.meta.title !== 'string' || !parsed.meta.title.trim()) {
    return { ok: false, error: '"meta.title" must be a non-empty string' };
  }
  if (typeof parsed.meta.body !== 'string' || !parsed.meta.body.trim()) {
    return { ok: false, error: '"meta.body" must be a non-empty string' };
  }
  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    return { ok: false, error: '"sections" must be a non-empty array' };
  }
  for (let i = 0; i < parsed.sections.length; i++) {
    const s = parsed.sections[i];
    if (!s || typeof s !== 'object') return { ok: false, error: `sections[${i}] must be an object` };
    if (!Array.isArray(s.children) || s.children.length === 0) {
      return { ok: false, error: `sections[${i}] ("${s.title ?? '?'}") must have a non-empty "children" array` };
    }
    if (typeof s.title !== 'string' || !s.title.trim()) {
      return { ok: false, error: `sections[${i}] must have a non-empty "title"` };
    }
    if (typeof s.body !== 'string' || !s.body.trim()) {
      return { ok: false, error: `sections[${i}] ("${s.title}") must have a non-empty "body"` };
    }
  }

  const emitted = parsed.sections.flatMap((s) => s.children);
  if (emitted.length !== inputIds.length || emitted.some((id, i) => id !== inputIds[i])) {
    const emittedSet = new Set(emitted);
    const inputSet = new Set(inputIds);
    const missing = inputIds.filter((id) => !emittedSet.has(id));
    const extra = emitted.filter((id) => !inputSet.has(id));
    const dupes = emitted.filter((id, i) => emitted.indexOf(id) !== i);
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (extra.length) parts.push(`invented/unknown: ${extra.join(', ')}`);
    if (dupes.length) parts.push(`duplicated: ${[...new Set(dupes)].join(', ')}`);
    if (!parts.length) parts.push('order does not match the input paragraph order');
    return {
      ok: false,
      error: `the concatenation of all sections[].children must equal the input id list exactly, in order — ${parts.join('; ')}`,
    };
  }

  const forbidden = forbiddenKeysPresent(parsed);
  if (forbidden) {
    return { ok: false, error: `forbidden key "${forbidden}" present in output — id/level/parent/docHash/order are derived deterministically, never emit them` };
  }

  if (containsMarkerCloser(parsed)) {
    return { ok: false, error: 'a string value contains the literal "-->" sequence — describe it in words instead (e.g. "the comment-closing arrow")' };
  }

  return { ok: true };
}

/** Strip a ```json ... ``` or ``` ... ``` fence if the model added one despite instructions. */
export function stripMarkdownFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Collapse repeats of the same id WITHIN one section's children (keeping the
 * first occurrence), before checkOutputContract runs. Mechanical tolerance in
 * the same spirit as stripMarkdownFence, prompted by a real, deterministic
 * failure: a markdown table is ONE block to remark (so one P- id), but a
 * model reading its 8 rows emits that id once per row it describes —
 * `[P-x, P-y, P-y, P-y, ...]` — and at temperature 0 it repeats the exact
 * mistake on every retry, so the retry budget can never save it. A repeat
 * inside a single section is unambiguous about the one thing the model is
 * being asked (which section does this block belong to?); collapsing it
 * loses nothing. A duplicate across TWO sections is a genuine grouping
 * conflict and still fails the contract check untouched. Runs shape-
 * defensively: anything malformed is returned as-is for checkOutputContract
 * to name properly.
 */
export function normalizeSynthesisOutput(parsed) {
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.sections)) return parsed;
  return {
    ...parsed,
    sections: parsed.sections.map((s) => {
      if (!s || typeof s !== 'object' || !Array.isArray(s.children)) return s;
      const seen = new Set();
      const children = s.children.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return { ...s, children };
    }),
  };
}

/** Reshape the model's {meta, sections[].children} output into assemble.mjs's layers.json shape. */
export function toAssemblerLayers(parsed) {
  const sections = parsed.sections.map((s, i) => ({
    key: `s${i}`,
    title: s.title,
    body: s.body,
    paragraphs: s.children,
  }));
  return {
    meta: [{ title: parsed.meta.title, body: parsed.meta.body, sections: sections.map((s) => s.key) }],
    sections,
  };
}
