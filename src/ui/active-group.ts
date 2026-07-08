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
// k=0. The active group is therefore derived independently, from spec §2.5's own
// anchor rule 2 — "the mounted node whose center is closest to the viewport
// center" — via `resolveAnchor(null, boxes, center)` in `main.ts`'s existing
// rAF-throttled scroll handler, which already holds the cached group boxes.
//
// D1 (opacity-only) holds: this is an INSTANT attribute swap. No CSS transition
// may ever be attached to `border-color`.
//
// Tauri-free and store-free: plain DOM, so it unit-tests without a running app.

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
