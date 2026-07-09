// src/ui/active-group.ts
//
// The `data-active` marker for the group under the reading focus (plan §4.6).
// CSS turns that attribute into the Figma accent border (`--sz-accent-border`)
// on the MetaCard at k=−2 and on the section card at k=0/−1.
//
// WHY THIS EXISTS SEPARATELY FROM focus-mask.ts
// `focus-mask.ts` is spec-verbatim (§4.3) and only ever *dims* the inactive
// groups via `[data-dimmed]`; before a caret is placed nothing is dimmed, so
// `:not([data-dimmed])` would border every group at once. It also only mounts at
// k=0. The active group is therefore derived independently, via `sectionAtTop`
// below, in `main.ts`'s existing rAF-throttled scroll handler, which already
// holds the cached group boxes.
//
// `sectionAtTop` is NOT the §2.5 zoom-transition anchor (`resolveAnchor` in
// engine/anchor.ts, "nearest box CENTER to viewport center" — that one is
// spec-locked and untouched, still used for cross-level scroll targeting).
// This is a continuous-scroll scrollspy instead: earlier reuse of
// `resolveAnchor` here caused the border to drift, worst around any section
// padded out by a large code block. Root cause: `.pgroup` carries
// `content-visibility: auto` (§4.2) for performance on long documents, so an
// off-screen group's HEIGHT is a `contain-intrinsic-size` placeholder
// (480px) until the browser renders it at least once — but the box cache is
// a one-time snapshot, never refreshed as you scroll. A "nearest CENTER"
// comparison depends on every box's height and was corrupted by that stale
// guess; "which section's top boundary have I scrolled past" depends only on
// `offsetTop` — the cumulative height of everything ABOVE it, which is
// accurate for any group already visited in a normal top-to-bottom read —
// so it never needs an off-screen box's height at all.
//
// D1 (opacity-only) holds: this is an INSTANT attribute swap. No CSS transition
// may ever be attached to `border-color`.
//
// Tauri-free and store-free: plain DOM, so it unit-tests without a running app.

/** The minimal shape `sectionAtTop` needs — deliberately NOT `offsetHeight`. */
export interface TopBox {
  id: string;
  offsetTop: number;
}

/**
 * The section for the continuous reading-view border: the LAST group (in
 * document order) whose top has scrolled to or above `scrollTop` — i.e. the
 * most recently passed section heading. `mounted` MUST already be in
 * top-to-bottom document order (true of `cacheMapBoxes`'s `querySelectorAll`
 * result in main.ts, a simple linear reading column). Defaults to the first
 * group when `scrollTop` is above it (e.g. scrolled to the very top).
 */
export function sectionAtTop(mounted: readonly TopBox[], scrollTop: number): string | null {
  if (mounted.length === 0) return null;
  let best = mounted[0].id;
  for (const box of mounted) {
    if (box.offsetTop > scrollTop) break;
    best = box.id;
  }
  return best;
}

/** `.pgroup` is keyed by `data-sid` at k=0/−1 and by `data-mid` at k=−2. */
function findGroup(layer: HTMLElement, id: string): HTMLElement | null {
  return layer.querySelector<HTMLElement>(
    `.pgroup[data-sid="${id}"], .pgroup[data-mid="${id}"]`,
  );
}

/**
 * Move the `data-active` marker from `prevId`'s group to `activeId`'s.
 *
 * Touches AT MOST two elements and no others — it runs on the scroll path, so a
 * sweep over every `.pgroup` (or a `querySelectorAll('[data-active]')`) would
 * scale with document length. Unchanged id → no DOM write at all. Nulls and ids
 * with no mounted group are tolerated (a group can be scrolled out of a
 * `content-visibility: auto` region, or its layer already replaced).
 */
export function markActiveGroup(
  layer: HTMLElement,
  activeId: string | null,
  prevId: string | null,
): void {
  if (activeId === prevId) return;
  if (prevId) findGroup(layer, prevId)?.removeAttribute('data-active');
  if (activeId) findGroup(layer, activeId)?.setAttribute('data-active', '');
}

/**
 * Drop every `data-active` marker in `layer`. Called ONLY when the layer (or its
 * groups) has been rebuilt — render, zoom-transition settle, hot-reload
 * reconcile — where the caller also resets its remembered `prevId`. On a freshly
 * built layer this matches nothing; after a keyed reconcile it clears the marker
 * off any REUSED node that survived the rebuild (D7 keeps such nodes alive, so
 * `prevId = null` alone would strand the border). Never called per scroll frame.
 */
export function clearActiveGroups(layer: HTMLElement): void {
  for (const el of layer.querySelectorAll<HTMLElement>('.pgroup[data-active]')) {
    el.removeAttribute('data-active');
  }
}
