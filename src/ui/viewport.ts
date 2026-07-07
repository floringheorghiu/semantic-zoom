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
        group.appendChild(node);
      }
      layer.appendChild(group);
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
      const body = document.createElement('div');
      body.className = 'summary-body';
      body.textContent = section.body;
      group.append(title, body);
      layer.appendChild(group);
    }
  } else {
    // level === -2
    for (const mid of table.order.meta) {
      const meta = table.meta[mid];
      if (!meta) continue;
      const group = document.createElement('section');
      group.className = 'pgroup';
      group.dataset.mid = mid;
      const title = document.createElement('h1');
      title.className = 'meta-title';
      title.textContent = meta.title;
      const body = document.createElement('div');
      body.className = 'meta-body';
      body.textContent = meta.body;
      group.append(title, body);
      layer.appendChild(group);
    }
  }

  container.replaceChildren(layer);
  container.dataset.zoom = String(level);
}
