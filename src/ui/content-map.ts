// Content map sidebar (plan §4.9) — a VS-Code-minimap-style document map.
//
// Tauri-free and store-free by construction (ui/ boundary): this module owns
// only DOM + the pure model/math. `main.ts` injects `onSelect` and drives
// `render` / `setActive` / `setIndicator`; the map NEVER writes scroll itself
// (click-to-scroll must route through the single rAF `scrollCommands$` queue).
//
// D1 is preserved: the indicator moves via `transform: translateY()` with NO
// CSS transition — no layout property is ever animated.

import type { LookupTable, ResolvedIndex, ZoomLevel } from '../engine/schema';

/** One row of the map: a group bar, or a milestone-boundary separator dot. */
export type MapEntry = { kind: 'bar'; id: string } | { kind: 'sep' };

/** A cached layout box of a mounted `.pgroup` (offsetTop/offsetHeight only). */
export interface MapBox {
  id: string;
  offsetTop: number;
  offsetHeight: number;
}

export interface ContentMapHandle {
  teardown(): void;
  render(model: MapEntry[]): void;
  setActive(ids: Set<string>): void;
  setIndicator(offsetPx: number): void;
}

/** Figma: panel `padding:5px`. */
export const MAP_PADDING = 5;
/** Bars and separator dots are both 2px tall. */
export const MAP_ITEM_H = 2;
/** Figma: `gap:6px`; shrinks toward MAP_MIN_GAP to fit the available height. */
export const MAP_GAP = 6;
export const MAP_MIN_GAP = 1;
/** The position-indicator hairline. */
export const MAP_INDICATOR_H = 1;

// --- Pure core (unit-tested) ------------------------------------------------

/**
 * The map model for `level`.
 *
 * At k=0 and k=−1 bars are SECTIONS, with a separator dot inserted at every
 * milestone boundary (wherever `parentOfSection` changes between two adjacent
 * sections). Never a leading or trailing separator. At k=−2 bars are the
 * milestones themselves, with no separators.
 *
 * Iterates `table.order.*` — never `Object.keys` (spec §2.2).
 */
export function buildMapModel(
  table: LookupTable,
  index: ResolvedIndex,
  level: ZoomLevel,
): MapEntry[] {
  const entries: MapEntry[] = [];

  if (level === -2) {
    for (const mid of table.order.meta) {
      if (!table.meta[mid]) continue;
      entries.push({ kind: 'bar', id: mid });
    }
    return entries;
  }

  let prevParent: string | undefined;
  let first = true;
  for (const sid of table.order.sections) {
    if (!table.sections[sid]) continue;
    const parent = index.parentOfSection.get(sid);
    if (!first && parent !== prevParent) entries.push({ kind: 'sep' });
    entries.push({ kind: 'bar', id: sid });
    prevParent = parent;
    first = false;
  }
  return entries;
}

/**
 * The visible-range highlight (LOCKED semantics): every group whose box
 * `[offsetTop, offsetTop + offsetHeight)` intersects the scroll window
 * `[scrollTop, scrollTop + clientHeight)`. Half-open on both sides, so a group
 * that merely touches an edge is not counted.
 */
export function visibleIds(boxes: MapBox[], scrollTop: number, clientHeight: number): Set<string> {
  const out = new Set<string>();
  const top = scrollTop;
  const bottom = scrollTop + clientHeight;
  for (const b of boxes) {
    // `max(start) < min(end)` — the interval-overlap test that stays correct
    // when either interval is EMPTY. The familiar `aStart < bEnd && bStart <
    // aEnd` form silently reports an intersection for a zero-height group, or
    // for a zero-height window (an unmounted / not-yet-laid-out layer).
    const start = Math.max(b.offsetTop, top);
    const end = Math.min(b.offsetTop + b.offsetHeight, bottom);
    if (start < end) out.add(b.id);
  }
  return out;
}

/** Clamp `n` into `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Where the position-indicator sits along a `trackH`-tall track, from the
 * scroll ratio `scrollTop / (scrollHeight − clientHeight)`. A non-scrollable
 * container (or a zero-height track) parks the indicator at 0 rather than
 * dividing by zero.
 */
export function indicatorOffset(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackH: number,
): number {
  const scrollable = scrollHeight - clientHeight;
  if (scrollable <= 0 || trackH <= 0) return 0;
  const ratio = clamp(scrollTop / Math.max(1, scrollable), 0, 1);
  return clamp(ratio * trackH, 0, trackH);
}

/**
 * The pixel distance the indicator may travel inside `host`. Read by main.ts
 * once per refresh and cached — the scroll handler must not re-measure.
 */
export function mapTrackHeight(host: HTMLElement): number {
  const items = host.querySelector<HTMLElement>('.map-items');
  if (!items) return 0;
  return Math.max(0, items.clientHeight - MAP_INDICATOR_H);
}

// --- Mount ------------------------------------------------------------------

/**
 * Mount the map into `host` (the `<aside id="content-map">`, which lives
 * OUTSIDE `#viewport` so `renderLevel`'s `replaceChildren` cannot wipe it).
 * Returns imperative controls; main.ts owns the lifecycle.
 */
export function mountContentMap(
  host: HTMLElement,
  opts: { onSelect: (id: string) => void },
): ContentMapHandle {
  const items = document.createElement('div');
  items.className = 'map-items';

  // The position-indicator is a SIBLING of the scrollable item list so it stays
  // put when the panel overflows and scrolls internally.
  const indicator = document.createElement('div');
  indicator.className = 'map-indicator';
  indicator.setAttribute('aria-hidden', 'true');

  host.replaceChildren(items, indicator);

  /** Live bars by id, so `setActive` can touch only what changed. */
  const bars = new Map<string, HTMLElement>();
  let activeIds = new Set<string>();

  function select(target: EventTarget | null): void {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-bar-id]');
    const id = el?.dataset.barId;
    if (id) opts.onSelect(id);
  }

  // Delegated so a re-render never re-binds listeners.
  const onClick = (e: MouseEvent): void => select(e.target);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-bar-id]');
    if (!el) return;
    e.preventDefault();
    select(e.target);
  };
  items.addEventListener('click', onClick);
  items.addEventListener('keydown', onKeyDown);

  function render(model: MapEntry[]): void {
    bars.clear();
    activeIds = new Set();

    const frag = document.createDocumentFragment();
    for (const entry of model) {
      if (entry.kind === 'sep') {
        const dot = document.createElement('div');
        dot.className = 'map-sep';
        frag.appendChild(dot);
        continue;
      }
      const bar = document.createElement('div');
      bar.className = 'map-bar';
      bar.dataset.barId = entry.id;
      bar.setAttribute('role', 'button');
      bar.setAttribute('tabindex', '0');
      bar.setAttribute('aria-label', entry.id);
      bars.set(entry.id, bar);
      frag.appendChild(bar);
    }
    items.replaceChildren(frag);

    // One forced reflow at render time (NOT in the scroll path): measure the
    // available height, then shrink the 6px gap toward a 1px floor so the bars
    // fit. If even the floor overflows, the item list scrolls internally.
    const n = model.length;
    items.style.gap = `${MAP_GAP}px`;
    items.style.overflowY = 'clip';
    if (n > 1) {
      const avail = host.clientHeight - 2 * MAP_PADDING; // READ
      if (avail > 0) {
        const needed = n * MAP_ITEM_H + MAP_GAP * (n - 1);
        if (needed > avail) {
          const fitted = Math.floor((avail - n * MAP_ITEM_H) / (n - 1));
          items.style.gap = `${clamp(fitted, MAP_MIN_GAP, MAP_GAP)}px`; // WRITE
        }
        const floorNeeded = n * MAP_ITEM_H + MAP_MIN_GAP * (n - 1);
        if (floorNeeded > avail) items.style.overflowY = 'auto';
      }
    }
  }

  function setActive(ids: Set<string>): void {
    for (const id of activeIds) {
      if (!ids.has(id)) bars.get(id)?.removeAttribute('data-active');
    }
    for (const id of ids) {
      if (!activeIds.has(id)) bars.get(id)?.setAttribute('data-active', '');
    }
    activeIds = new Set(ids);
  }

  function setIndicator(offsetPx: number): void {
    // transform ONLY — never `top`, never a CSS transition (D1).
    indicator.style.transform = `translateY(${offsetPx}px)`;
  }

  function teardown(): void {
    items.removeEventListener('click', onClick);
    items.removeEventListener('keydown', onKeyDown);
    bars.clear();
    activeIds = new Set();
    host.replaceChildren();
  }

  return { teardown, render, setActive, setIndicator };
}
