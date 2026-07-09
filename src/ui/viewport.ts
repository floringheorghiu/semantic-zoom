import { Subject, animationFrameScheduler, Observable } from 'rxjs';
import { observeOn, switchMap } from 'rxjs/operators';

import type { LookupTable, ResolvedIndex, ZoomLevel } from '../engine/schema';
import {
  resolveAnchor,
  recordPlace,
  mapAcrossLevels,
  centerScrollTop,
  type MountedBox,
  type MapCtx,
} from '../engine/anchor';
import { selectZoom } from '../state/selectors';
import { buildHeader, titlePid } from './header';
import {
  buildMetaCard,
  buildMilestoneDivider,
  buildSidLabel,
  renderSummaryBody,
} from './cards';

// `renderSummaryBody` moved to ./cards (the card builders need it, and importing
// it back from here would be a cycle). Re-exported so existing importers — and
// summary.test.ts — keep their `from './viewport'` path.
export { renderSummaryBody };

/**
 * Static three-level renderer (§4.1). Swaps the freshly-built level layer in as
 * the viewport's single child. Delegates DOM construction to `buildLevel` so the
 * zoom transition (§2.5) can build a SECOND layer without re-implementing it —
 * `renderLevel` keeps its original observable behavior (build + replaceChildren).
 *
 * Keyed reconciliation (DOM node reuse for hot reload) lands in Task 3.2; a
 * fresh-child swap is correct for a static render.
 */
export function renderLevel(
  container: HTMLElement,
  table: LookupTable,
  index: ResolvedIndex,
  level: ZoomLevel,
): void {
  container.replaceChildren(buildLevel(table, index, level));
  container.dataset.zoom = String(level);
}

/**
 * Build the fully-populated `.level-layer` for `level` (reading column +
 * groups/cards/tables) and return it WITHOUT mounting it. This is everything
 * `renderLevel` builds except the `container.replaceChildren` swap, so the
 * transition effect can append it as an overlay layer.
 *
 * Iterate `table.order.*` arrays — NEVER `Object.keys` (spec §2.2 rule): the
 * order arrays are the document-order contract; object key order is not.
 *
 * Card chrome (§4.4) is delegated to `./cards`: k=−2 is a `MetaCard` per meta
 * node, k=−1 is plain section blocks with a milestone divider before the first
 * section of each milestone. Everything stays in normal flow — no `.pgroup`
 * ancestor is ever positioned, so `.pnode.offsetTop` keeps resolving against
 * `.level-layer` for the anchor engine.
 */
export function buildLevel(
  table: LookupTable,
  index: ResolvedIndex,
  level: ZoomLevel,
): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'level-layer';
  layer.dataset.level = String(level);

  // A centered reading column caps line length for comfortable reading
  // (~70ch prose / a touch wider for raw so tables and code fit).
  const column = document.createElement('div');
  column.className = 'reading-column';
  layer.appendChild(column);

  // Per-level header (title + subtitle) at the top of the reading content,
  // scrolling with it (§4.2). Prepended for ALL three levels.
  column.appendChild(buildHeader(table, level));

  if (level === 0) {
    // The heading promoted to the doc title must not render again in the body.
    const skipPid = titlePid(table);
    for (const sid of table.order.sections) {
      if (!table.sections[sid]) continue;
      column.appendChild(buildGroup(table, index, sid, skipPid));
    }
  } else if (level === -1) {
    // No per-section cards here (§4.4) — a milestone divider announces each new
    // milestone, then its sections render as plain blocks.
    let prevMid: string | undefined;
    for (const sid of table.order.sections) {
      const section = table.sections[sid];
      if (!section) continue;

      const mid = index.parentOfSection.get(sid);
      if (mid !== undefined && mid !== prevMid && table.meta[mid]) {
        column.appendChild(buildMilestoneDivider(table, mid));
      }
      prevMid = mid;

      const group = document.createElement('section');
      group.className = 'pgroup';
      group.dataset.sid = sid;
      group.appendChild(buildSidLabel(sid));
      const title = document.createElement('h2');
      title.className = 'summary-title';
      title.textContent = section.title;
      group.appendChild(title);
      renderSummaryBody(group, section.body);
      column.appendChild(group);
    }
  } else {
    // level === -2 (Story): one MetaCard per meta node; the card IS the .pgroup.
    for (const mid of table.order.meta) {
      if (!table.meta[mid]) continue;
      column.appendChild(buildMetaCard(table, mid));
    }
  }

  return layer;
}

/**
 * Build ONE level-0 `.pgroup[data-sid]` group (its `.pnode` paragraphs + table
 * scroll-wraps) WITHOUT mounting it. Factored out of `buildLevel` so the keyed
 * hot-reload reconciler (Task 3.2, `reconcile` in state/reload.ts) can rebuild a
 * single changed group without re-implementing paragraph rendering — one source
 * of truth for what a group's DOM looks like.
 *
 * `skipPid` (optional) is the paragraph promoted to the document title
 * (`titlePid`); when it falls in this group its `.pnode` is skipped so the
 * heading isn't shown twice. This changes only the rendered DOM — NOT the
 * group's reconcile key (which derives from `table.sections[sid].children`), so
 * D7 keyed reuse is unaffected.
 */
export function buildGroup(
  table: LookupTable,
  _index: ResolvedIndex,
  sid: string,
  skipPid?: string | null,
): HTMLElement {
  const group = document.createElement('section');
  group.className = 'pgroup';
  group.dataset.sid = sid;
  // Normal-flow, right-aligned S-id (§4.4). Prepended rather than absolutely
  // placed: `.pgroup` must stay unpositioned so `.pnode.offsetTop` keeps
  // resolving against `.level-layer` (anchor engine + content map).
  group.appendChild(buildSidLabel(sid));
  const section = table.sections[sid];
  if (!section) return group;
  for (const pid of section.children) {
    if (pid === skipPid) continue;
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
  return group;
}

// --- Zoom transition: two-frame layer crossfade (§2.5, D8) ------------------

/**
 * The single rAF-scheduled scroll-write queue (spec §3.2). EVERY scroll write
 * in the transition path funnels through this Subject; `observeOn` batches the
 * actual `el.scrollTop = top` to an animation frame so a layout read never sits
 * mid-write. Never assign `.scrollTop` directly elsewhere in the transition.
 */
export const scrollCommands$ = new Subject<{ el: HTMLElement; top: number }>();
scrollCommands$.pipe(observeOn(animationFrameScheduler)).subscribe(({ el, top }) => {
  el.scrollTop = top;
});

/** State snapshot the transition reads at the moment a ZOOM_SET fires. */
export interface ZoomTransitionState {
  table: LookupTable;
  index: ResolvedIndex;
  /** The level currently mounted (the transition's SOURCE). */
  level: ZoomLevel;
  caret: { paragraphId: string | null; offset: number };
  lastCaretIn: Map<string, string>;
  lastAnchorIn: Map<string, string>;
}

/** The dataset attribute carrying a node's id at a given level. */
function idAttr(level: ZoomLevel): 'pid' | 'sid' | 'mid' {
  return level === 0 ? 'pid' : level === -1 ? 'sid' : 'mid';
}

/**
 * Cached layout boxes of the mounted anchor-candidate elements at `level`
 * (paragraphs at 0, groups at −1/−2). Plain `offsetTop`/`offsetHeight` reads of
 * the already-laid-out CURRENT layer — no `getBoundingClientRect` loop (§2.5).
 */
function mountedBoxes(layer: HTMLElement, level: ZoomLevel): MountedBox[] {
  const selector = level === 0 ? '.pnode' : '.pgroup';
  const attr = idAttr(level);
  const boxes: MountedBox[] = [];
  for (const el of layer.querySelectorAll<HTMLElement>(selector)) {
    const id = el.dataset[attr];
    if (!id) continue;
    boxes.push({ id, offsetTop: el.offsetTop, offsetHeight: el.offsetHeight });
  }
  return boxes;
}

/** Find the element carrying `id` at `level` inside `layer`. */
function findNode(layer: HTMLElement, level: ZoomLevel, id: string): HTMLElement | null {
  const selector =
    level === 0
      ? `.pnode[data-pid="${id}"]`
      : level === -1
        ? `.pgroup[data-sid="${id}"]`
        : `.pgroup[data-mid="${id}"]`;
  return layer.querySelector<HTMLElement>(selector);
}

/**
 * Measure where `layer` must scroll to center the target node, or null if the
 * node isn't in this layer.
 *
 * `.pgroup` carries `content-visibility: auto` (§4.2, D8), so a group whose
 * contents the browser has SKIPPED gives its descendants no layout box at all:
 * `offsetParent` is null and `el.offsetTop` reads **0**. At target −1/−2 the
 * node we measure IS the `.pgroup` (which always has a box), but at target 0 it
 * is a `.pnode` inside one — so an unguarded read returned 0, `centerScrollTop`
 * clamped to 0, and every zoom back into raw text slammed the view to the top
 * of the document.
 *
 * The fix is to force just the target's OWN group to render for the duration of
 * the read, then restore whatever was there. Exactly one group is un-skipped,
 * so this stays the "one contained layout" §2.5 asks for — not a full-tree
 * relayout. All reads happen together, before the caller writes any scroll.
 */
export function measureTargetTop(
  layer: HTMLElement,
  level: ZoomLevel,
  targetId: string,
): number | null {
  const el = findNode(layer, level, targetId);
  if (!el) return null;

  const group = el.closest<HTMLElement>('.pgroup');
  // At −1/−2 the target IS its group: it already has a box, nothing to force.
  const forced = group && group !== el ? group : null;
  const saved = forced ? forced.style.contentVisibility : '';
  if (forced) forced.style.contentVisibility = 'visible';

  // --- reads (all of them, together) ---
  const offsetTop = el.offsetTop;
  const offsetHeight = el.offsetHeight;
  const clientHeight = layer.clientHeight;
  const scrollHeight = layer.scrollHeight;

  if (forced) forced.style.contentVisibility = saved;

  return centerScrollTop({ offsetTop, offsetHeight }, { clientHeight, scrollHeight });
}

/** Frames of scroll convergence allowed after the frame-n+1 measurement. */
const SETTLE_FRAMES = 5;

/**
 * Measure → scroll → re-measure until the scroll position converges.
 *
 * Why a loop and not a single read: groups ABOVE the target are still skipped,
 * so their heights come from `contain-intrinsic-size` ESTIMATES — the target's
 * `offsetTop` is therefore approximate on the first pass. Scrolling to it makes
 * the browser render that region, the real sizes land, and the next measurement
 * lands on the true value. This is not "estimated-height centering" (which §2.5
 * forbids): every pass measures real layout, and the fixpoint is exact.
 *
 * Capped at `SETTLE_FRAMES` (~5 frames ≈ 80ms), well inside the 200ms opacity
 * fade — the layer is still fading up, so no intermediate position is visible.
 * Scroll is ONLY ever written through `scrollCommands$` (§3.2).
 */
export function settleScroll(
  layer: HTMLElement,
  level: ZoomLevel,
  targetId: string,
  framesLeft: number,
  schedule: (cb: () => void) => void = (cb) => void requestAnimationFrame(cb),
): void {
  const top = measureTargetTop(layer, level, targetId);
  if (top === null) return;
  if (Math.abs(layer.scrollTop - top) <= 1) return; // converged
  scrollCommands$.next({ el: layer, top }); // the single rAF-scheduled queue
  if (framesLeft > 0) {
    schedule(() => settleScroll(layer, level, targetId, framesLeft - 1, schedule));
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The two-frame transition to `target` as an Observable so `switchMap` can abort
 * an in-flight one (spec §3.2 row 1). Frame n appends the target layer hidden;
 * frame n+1 measures + scrolls + starts the opacity fade; `transitionend`
 * unmounts the old layer. The returned teardown cleans up on abort/completion.
 */
function runTransition(
  viewport: HTMLElement,
  getState: () => ZoomTransitionState | null,
  target: ZoomLevel,
  onSettled?: (level: ZoomLevel) => void,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    const st = getState();
    if (!st || !st.table || !st.index || target === st.level) {
      subscriber.complete();
      return;
    }
    const source = st.level;
    const oldLayer = viewport.querySelector<HTMLElement>('.level-layer');

    // --- Anchor at the SOURCE level (cached offsets of the current layer). ---
    const center = oldLayer ? oldLayer.scrollTop + oldLayer.clientHeight / 2 : 0;
    const boxes = oldLayer ? mountedBoxes(oldLayer, source) : [];
    // The caret is a LEVEL-0 concept (§2.5 rule 1) — it's only a valid anchor
    // when zooming FROM raw. At −1/−2 fall back to nearest-center (a section/
    // meta id); otherwise a stale caret pid would be mapped as if it were a
    // section id (`table.sections[pid]` → undefined) and crash the transition.
    const caretAnchor = source === 0 ? st.caret.paragraphId : null;
    const anchorId = resolveAnchor(caretAnchor, boxes, center);

    // Remember the place we're leaving (whole ancestor chain) so zooming back
    // in feels "remembered" — see `recordPlace` (§2.5).
    if (anchorId) recordPlace(source, anchorId, st.index, st.lastCaretIn, st.lastAnchorIn);

    const ctx: MapCtx = {
      index: st.index,
      table: st.table,
      lastCaretIn: st.lastCaretIn,
      lastAnchorIn: st.lastAnchorIn,
    };
    // Defense in depth: a malformed anchor must NEVER throw here — this runs
    // inside the switchMap's inner observable, so an uncaught throw errors the
    // subscription and permanently stops all future zoom switches. Degrade to
    // an un-centered transition instead of crashing.
    let targetId: string | null = null;
    if (anchorId) {
      try {
        targetId = mapAcrossLevels(source, target, anchorId, ctx);
      } catch (err) {
        console.error('[zoom] anchor mapping failed; transitioning without centering:', err);
        targetId = null;
      }
    }

    // --- Frame n: append target layer hidden. NO layout read here (D8). ---
    const newLayer = buildLevel(st.table, st.index, target);
    newLayer.setAttribute('data-entering', ''); // opacity:0 via CSS
    newLayer.style.visibility = 'hidden';
    viewport.appendChild(newLayer);
    viewport.setAttribute('data-transitioning', ''); // gates will-change (§4.2)

    let done = false;
    let timeoutId: ReturnType<typeof setTimeout> | 0 = 0;
    let onEnd: ((e: TransitionEvent) => void) | null = null;

    // Every rAF this transition owns (frame n+1, the settle chain, the
    // reduced-motion finish), so an abort (switchMap) cancels all of them.
    // Ids are dropped as they fire, so teardown never cancels a stale id.
    const pendingRafs = new Set<number>();
    const raf = (cb: () => void): number => {
      const id = requestAnimationFrame(() => {
        pendingRafs.delete(id);
        cb();
      });
      pendingRafs.add(id);
      return id;
    };

    // --- Frame n+1: contained measure → scroll → start fade. ---
    raf(() => {
      // Measure + scroll, then converge over the next few frames while the
      // skipped groups above the target resolve their real heights.
      if (targetId) settleScroll(newLayer, target, targetId, SETTLE_FRAMES, raf);
      newLayer.style.visibility = 'visible';
      newLayer.removeAttribute('data-entering'); // starts the 200ms opacity fade

      const finish = (): void => {
        if (done) return;
        done = true;
        if (onEnd) newLayer.removeEventListener('transitionend', onEnd);
        if (timeoutId) clearTimeout(timeoutId);
        oldLayer?.remove();
        viewport.removeAttribute('data-transitioning');
        viewport.dataset.zoom = String(target);
        // Transition has settled into its FINAL layer: let the owner (main.ts)
        // (re)mount caret + focus-mask against the layer that actually remains.
        onSettled?.(target);
        subscriber.complete();
      };

      if (prefersReducedMotion()) {
        // CSS sets `transition:none` → no transitionend fires; swap next frame.
        raf(finish);
      } else {
        onEnd = (e: TransitionEvent) => {
          if (e.propertyName === 'opacity') finish();
        };
        newLayer.addEventListener('transitionend', onEnd);
        // Safety net if transitionend never arrives (e.g. jsdom, tab hidden).
        timeoutId = setTimeout(finish, 400);
      }
    });

    return () => {
      // Cancels frame n+1 AND any still-queued settle frame.
      for (const id of pendingRafs) cancelAnimationFrame(id);
      pendingRafs.clear();
      if (timeoutId) clearTimeout(timeoutId);
      if (onEnd) newLayer.removeEventListener('transitionend', onEnd);
      if (!done) {
        // Superseded (switchMap abort) before settling: drop the half-mounted
        // entering layer and leave the old layer for the successor transition.
        newLayer.remove();
        viewport.removeAttribute('data-transitioning');
      }
    };
  });
}

/**
 * Mount the zoom-transition effect (spec §2.5 / §3.2). Subscribes to the zoom
 * selector through `switchMap`, so a fresh ZOOM_SET aborts the in-flight
 * transition. `getState` supplies the current doc + SOURCE level + place memory.
 * Returns a teardown that unsubscribes the effect.
 */
export function mountZoomTransitions(
  viewport: HTMLElement,
  getState: () => ZoomTransitionState | null,
  onSettled?: (level: ZoomLevel) => void,
): () => void {
  const sub = selectZoom()
    .pipe(switchMap((target) => runTransition(viewport, getState, target, onSettled)))
    .subscribe();
  return () => sub.unsubscribe();
}

