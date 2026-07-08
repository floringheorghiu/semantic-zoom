// src/ui/header.ts
//
// Per-level document header (plan §4.2): a title + a level-specific subtitle
// that lives at the TOP of the reading content and scrolls with it. Tauri-free
// and store-free — pure functions over the `LookupTable` plus a small DOM
// builder, so the counts/strings are unit-testable without a running app.
import type { LookupTable, ZoomLevel } from '../engine/schema';

/** `${n} paragraph` / `${n} paragraphs` — sensible singular/plural. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Strip HTML from a pre-rendered fragment, returning its plain text. */
function plainText(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The first level-0 paragraph that is a heading (document order), or null. */
function firstHeadingPid(table: LookupTable): string | null {
  for (const pid of table.order.paragraphs) {
    if (table.paragraphs[pid]?.kind === 'heading') return pid;
  }
  return null;
}

/**
 * The document title: the plain text of the FIRST k=0 heading paragraph in
 * document order. Falls back to `'Semantic Zoom'` when the doc has no heading.
 */
export function docTitle(table: LookupTable): string {
  const pid = firstHeadingPid(table);
  if (pid) {
    const text = plainText(table.paragraphs[pid].html);
    if (text) return text;
  }
  return 'Semantic Zoom';
}

/**
 * The id of the paragraph used as the document title (see `docTitle`), so the
 * k=0 body render can skip it and avoid showing the title twice. `null` when
 * there is no heading to promote.
 */
export function titlePid(table: LookupTable): string | null {
  return firstHeadingPid(table);
}

/**
 * A level-specific subtitle with counts drawn from `table.order`:
 *   0  → `Detail view · N paragraphs`
 *   −1 → `Plain-English walkthrough · S sections across M milestones`
 *   −2 → `Executive milestone view · M milestones · S sections`
 */
export function levelSubtitle(level: ZoomLevel, table: LookupTable): string {
  const P = table.order.paragraphs.length;
  const S = table.order.sections.length;
  const M = table.order.meta.length;
  if (level === 0) return `Detail view · ${plural(P, 'paragraph')}`;
  if (level === -1) {
    return `Plain-English walkthrough · ${plural(S, 'section')} across ${plural(M, 'milestone')}`;
  }
  return `Executive milestone view · ${plural(M, 'milestone')} · ${plural(S, 'section')}`;
}

/**
 * Build the `<header class="doc-header">` block (title + subtitle) for `level`.
 * Prepended to the reading column so it scrolls with the content.
 */
export function buildHeader(table: LookupTable, level: ZoomLevel): HTMLElement {
  const header = document.createElement('header');
  header.className = 'doc-header';

  const h1 = document.createElement('h1');
  h1.className = 'doc-title';
  h1.textContent = docTitle(table);

  const subtitle = document.createElement('p');
  subtitle.className = 'doc-subtitle';
  subtitle.textContent = levelSubtitle(level, table);

  header.append(h1, subtitle);
  return header;
}
