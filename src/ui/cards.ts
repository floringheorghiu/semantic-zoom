// src/ui/cards.ts
//
// Card chrome for the semantic levels (plan §4.4) — the Figma `MetaCard`
// (node 36:718) at Story (k=−2), the milestone divider at Sections (k=−1), and
// the muted mono S-id label shown at k=−1/k=0.
//
// Tauri-free and store-free: schema types + DOM only, so every string helper is
// a pure function that unit-tests without a running app.
//
// LAYOUT INVARIANT: nothing built here may be `position: relative/absolute`,
// and nothing here may introduce a positioned ancestor of a `.pnode`. The
// anchor engine (`mountedBoxes`, `measureTargetTop`) and the content map read
// `offsetTop` against `.level-layer` as the offsetParent — a positioned
// `.pgroup`/`.metacard` would silently rebase every measurement. The S-id label
// is therefore a normal-flow, text-aligned block, NOT an absolutely-placed tag.
//
// `renderSummaryBody` lives here (rather than in `viewport.ts`) so the card
// builders can use it without an import cycle; `viewport.ts` re-exports it.

import type { LookupTable } from '../engine/schema';

// --- Pure id formatting ------------------------------------------------------

/** `P-<hash>-<ordinal>` / `S-<hash>-<ordinal>` (D6). */
const ID_RE = /^([A-Za-z]+)-([0-9A-Za-z]+)-(\d+)$/;

/**
 * `S-ab80d77b-0` → `S-ab80d77b…`: keep the `X-` prefix and the (≤8-char) content
 * hash, drop the ordinal, mark the elision. Anything that is not a D6 id — a
 * positional meta id like `M1`, an empty string, a stray hyphen — is returned
 * verbatim rather than mangled.
 */
export function truncateId(id: string): string {
  const m = ID_RE.exec(id);
  if (!m) return id;
  return `${m[1]}-${m[2].slice(0, 8)}…`;
}

/**
 * The footer's ID range for a group's ordered child ids: `''` when empty, the
 * single truncated id when there is exactly one, otherwise
 * `first – last` (en dash, spaced).
 */
export function idRange(childIds: string[]): string {
  if (childIds.length === 0) return '';
  const first = truncateId(childIds[0]);
  if (childIds.length === 1) return first;
  return `${first} – ${truncateId(childIds[childIds.length - 1])}`;
}

/** `1 section` / `N sections`. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- Builders ----------------------------------------------------------------

/**
 * The Figma `MetaCard` — ONE per meta node, only at Story (k=−2). The card IS
 * the `.pgroup[data-mid]` (focus-mask, content-map and the zoom transition all
 * key off that attribute), so the chrome adds no wrapper element.
 */
export function buildMetaCard(table: LookupTable, mid: string): HTMLElement {
  const card = document.createElement('section');
  card.className = 'pgroup metacard';
  card.dataset.mid = mid;

  const meta = table.meta[mid];
  if (!meta) return card;

  // --- header: `M1` + milestone title, both in the accent ---
  const head = document.createElement('header');
  head.className = 'metacard-head';

  const label = document.createElement('span');
  label.className = 'metacard-label';
  label.textContent = mid;

  const title = document.createElement('h2');
  title.className = 'metacard-title';
  title.textContent = meta.title;

  head.append(label, title);

  // --- body: the existing summary rendering (badges restyled in step 6) ---
  const body = document.createElement('div');
  body.className = 'metacard-body';
  renderSummaryBody(body, meta.body);

  // --- footer: "N sections" · flexible rule · truncated S-id range ---
  const foot = document.createElement('footer');
  foot.className = 'metacard-foot';

  const count = document.createElement('span');
  count.className = 'metacard-count';
  count.textContent = plural(meta.children.length, 'section');

  const rule = document.createElement('span');
  rule.className = 'metacard-rule';
  rule.setAttribute('aria-hidden', 'true');

  const ids = document.createElement('span');
  ids.className = 'metacard-ids';
  ids.textContent = idRange(meta.children);

  foot.append(count, rule, ids);

  card.append(head, body, foot);
  return card;
}

/**
 * The k=−1 milestone divider: the same `M1` + title type as a card header, but
 * a plain in-flow block placed BEFORE the first section of each milestone.
 * Deliberately not a `.pgroup` — it is chrome, not an anchorable node.
 */
export function buildMilestoneDivider(table: LookupTable, mid: string): HTMLElement {
  const divider = document.createElement('div');
  divider.className = 'milestone-divider';
  divider.dataset.mid = mid;

  const label = document.createElement('span');
  label.className = 'milestone-label';
  label.textContent = mid;

  const title = document.createElement('span');
  title.className = 'milestone-title';
  title.textContent = table.meta[mid]?.title ?? '';

  divider.append(label, title);
  return divider;
}

/**
 * The muted mono S-id shown at k=0 / k=−1. A normal-flow block that right-aligns
 * its text — see the layout invariant at the top of this file: absolutely
 * positioning this label would require a positioned `.pgroup` and break every
 * `offsetTop` read in the anchor engine.
 */
export function buildSidLabel(sid: string): HTMLElement {
  const label = document.createElement('div');
  label.className = 'sid-label';
  label.textContent = truncateId(sid);
  return label;
}

// --- Summary body rendering (Story / Section prose) --------------------------

interface LabeledSegment {
  label: string;
  text: string;
}

/** A block like `**Next step:** read the table` → { label, text }. */
const LABEL_RE = /^\*\*(.+?):\*\*\s*([\s\S]*)$/;

/**
 * Render a summary body. When the body is a set of `**Label:** value`
 * blocks (the Story/Section convention), render them as a card of
 * badge-tagged rows so the labels stop reading as a wall of bold text
 * (Ask 3). Otherwise render plain prose paragraphs with inline emphasis.
 */
export function renderSummaryBody(host: HTMLElement, body: string): void {
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const segments: LabeledSegment[] = [];
  let allLabeled = blocks.length > 0;

  for (const block of blocks) {
    const m = LABEL_RE.exec(block);
    if (m) {
      segments.push({ label: m[1].trim(), text: m[2].trim() });
    } else {
      allLabeled = false;
    }
  }

  if (allLabeled) {
    const card = document.createElement('div');
    card.className = 'summary-card';
    for (const seg of segments) {
      const row = document.createElement('div');
      row.className = 'summary-row';

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.variant = badgeVariant(seg.label);
      badge.textContent = seg.label;

      const text = document.createElement('p');
      text.className = 'summary-text';
      text.innerHTML = inlineFormat(seg.text);

      row.append(badge, text);
      card.appendChild(row);
    }
    host.appendChild(card);
    return;
  }

  const prose = document.createElement('div');
  prose.className = 'summary-body';
  for (const block of blocks) {
    const p = document.createElement('p');
    p.innerHTML = inlineFormat(block);
    prose.appendChild(p);
  }
  // Empty body → still emit an empty container so callers/tests are stable.
  if (blocks.length === 0) prose.textContent = body;
  host.appendChild(prose);
}

/** Map a label to a semantic badge variant (used for its color). */
function badgeVariant(label: string): string {
  const l = label.toLowerCase();
  if (/(cover|overview|summary|about)/.test(l)) return 'covers';
  if (/(accomplish|done|shipped|complete)/.test(l)) return 'done';
  if (/(block|risk|caveat|warning|issue)/.test(l)) return 'blocker';
  if (/(prereq|prerequisite|dependenc|require)/.test(l)) return 'prereq';
  if (/(next|todo|upcoming|follow)/.test(l)) return 'next';
  return 'default';
}

/** Escape HTML, then render `**bold**` and `` `code` `` inline. */
function inlineFormat(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
}
