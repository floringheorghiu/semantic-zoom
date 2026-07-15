// check-layers.mjs — portable core extracted from
// tools/semantic-zoom-tools/scripts/check-layers.mjs (T4). Structural
// self-check on a model-authored layers object, before the parser/hash work
// in assemble.mjs runs. Pure logic, no fs — returns { ok, errors } instead
// of the CLI's console.error+exit(1), since both Node and the webview need
// a caller-controlled failure path, not a process exit.

export function checkLayers(layers) {
  const errors = [];
  if (!Array.isArray(layers.sections) || !Array.isArray(layers.meta)) {
    return { ok: false, errors: ['layers must have array fields "sections" and "meta"'] };
  }

  const sectionKeys = new Set();
  for (const s of layers.sections) {
    if (!s.key) { errors.push('a section is missing its "key"'); continue; }
    if (sectionKeys.has(s.key)) { errors.push(`duplicate section key "${s.key}"`); continue; }
    sectionKeys.add(s.key);
    if (!Array.isArray(s.paragraphs) || s.paragraphs.length === 0) {
      errors.push(`section "${s.key}": no paragraphs listed`);
    }
  }

  const assigned = new Set();
  const duplicates = [];
  for (const m of layers.meta) {
    if (!Array.isArray(m.sections) || m.sections.length === 0) {
      errors.push(`meta "${m.title ?? '(untitled)'}": no sections listed`);
      continue;
    }
    for (const key of m.sections) {
      if (!sectionKeys.has(key)) {
        errors.push(`meta "${m.title}": references unknown section key "${key}" — ` +
          `typo, or a section that was never added to layers.sections`);
        continue;
      }
      if (assigned.has(key)) duplicates.push(key);
      assigned.add(key);
    }
  }
  if (duplicates.length) {
    errors.push(`section(s) claimed by more than one meta node: ${duplicates.join(', ')}`);
  }

  const missing = [...sectionKeys].filter((k) => !assigned.has(k));
  if (missing.length) {
    errors.push(`section(s) defined in "sections" but not assigned to any meta node's ` +
      `"sections" list: ${missing.join(', ')} — every section must end up ` +
      `under exactly one meta node`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, sectionCount: sectionKeys.size, metaCount: layers.meta.length };
}
