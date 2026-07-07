import type { LookupTable, ResolvedIndex, ZoomLevel } from '../engine/schema';

/**
 * Static three-level renderer (§4.1). Builds the level's DOM into a fresh
 * child container and swaps it in as the viewport's single child.
 *
 * Iterate `table.order.*` arrays — NEVER `Object.keys` (spec §2.2 rule): the
 * order arrays are the document-order contract; object key order is not.
 *
 * Keyed reconciliation (DOM node reuse for hot reload) lands in Task 3.2; a
 * fresh-child swap is correct for a static render.
 */
export function renderLevel(
  container: HTMLElement,
  table: LookupTable,
  _index: ResolvedIndex,
  level: ZoomLevel,
): void {
  const layer = document.createElement('div');
  layer.className = 'level-layer';
  layer.dataset.level = String(level);

  // A centered reading column caps line length for comfortable reading
  // (~70ch prose / a touch wider for raw so tables and code fit).
  const column = document.createElement('div');
  column.className = 'reading-column';
  layer.appendChild(column);

  if (level === 0) {
    for (const sid of table.order.sections) {
      const section = table.sections[sid];
      if (!section) continue;
      const group = document.createElement('section');
      group.className = 'pgroup';
      group.dataset.sid = sid;
      for (const pid of section.children) {
        const paragraph = table.paragraphs[pid];
        if (!paragraph) continue;
        const node = document.createElement('div');
        node.className = 'pnode';
        node.dataset.pid = pid;
        node.dataset.kind = paragraph.kind;
        node.innerHTML = paragraph.html;
        // Let wide tables scroll inside the reading column instead of
        // blowing it out horizontally (Ask 4).
        for (const tbl of node.querySelectorAll('table')) {
          const scroll = document.createElement('div');
          scroll.className = 'table-scroll';
          tbl.replaceWith(scroll);
          scroll.appendChild(tbl);
        }
        group.appendChild(node);
      }
      column.appendChild(group);
    }
  } else if (level === -1) {
    for (const sid of table.order.sections) {
      const section = table.sections[sid];
      if (!section) continue;
      const group = document.createElement('section');
      group.className = 'pgroup';
      group.dataset.sid = sid;
      const title = document.createElement('h2');
      title.className = 'summary-title';
      title.textContent = section.title;
      group.appendChild(title);
      renderSummaryBody(group, section.body);
      column.appendChild(group);
    }
  } else {
    // level === -2 (Story)
    for (const mid of table.order.meta) {
      const meta = table.meta[mid];
      if (!meta) continue;
      const group = document.createElement('section');
      group.className = 'pgroup';
      group.dataset.mid = mid;
      const title = document.createElement('h1');
      title.className = 'meta-title';
      title.textContent = meta.title;
      group.appendChild(title);
      renderSummaryBody(group, meta.body);
      column.appendChild(group);
    }
  }

  container.replaceChildren(layer);
  container.dataset.zoom = String(level);
}

// --- Summary body rendering (Story / Section prose) -------------------------

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
