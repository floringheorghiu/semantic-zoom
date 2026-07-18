import { Subject, animationFrameScheduler, Observable } from 'rxjs';
import { observeOn, switchMap } from 'rxjs/operators';

import type { LookupTable, ResolvedIndex, ZoomLevel } from '../engine/schema';
import {
  resolveAnchor,
  recordPlace,
  mapAcrossLevels,
  topAlignScrollTop,
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
const CHEVRON_SVG =
  '<svg class="chevron" viewBox="0 0 12 8" width="12" height="8" aria-hidden="true" focusable="false">' +
  '<path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Cap a code block's height (~200px) with a chevron toggle to expand it.
 * Always added, even to a block short enough that collapsing changes
 * nothing visible: whether a block's TRUE height exceeds the cap can't be
 * measured reliably here, since `buildGroup` runs on a DETACHED element
 * (before it's ever laid out) — and even once mounted, `.pgroup` carries
 * `content-visibility: auto` (§4.2), so a `<pre>` inside a currently
 * off-screen group would read a false `scrollHeight` anyway (the same
 * failure mode `mountedBoxes` in this file already works around
 * elsewhere). A harmless no-op toggle on a short block is a fair trade for
 * not reintroducing that whole class of bug here.
 */
function wrapCodeBlock(pre: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  pre.replaceWith(wrap);
  wrap.appendChild(pre);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'code-expand-toggle';
  toggle.setAttribute('aria-label', 'Toggle full code block');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = CHEVRON_SVG;
  toggle.addEventListener('click', () => {
    const expanded = wrap.hasAttribute('data-expanded');
    if (expanded) wrap.removeAttribute('data-expanded');
    else wrap.setAttribute('data-expanded', '');
    toggle.setAttribute('aria-expanded', String(!expanded));
  });
  wrap.appendChild(toggle);
}

/**
 * Post-process a freshly-built `.pnode`'s inner HTML: wrap wide tables so they
 * scroll instead of blowing out the reading column (Ask 4), and cap code
 * blocks behind the chevron toggle (above). Shared by `buildGroup` (native
 * k=0 paragraphs) and the untagged/raw-markdown renderer (`./raw-markdown`)
 * so both paths get identical table/code treatment from one place.
 */
export function decoratePnode(node: HTMLElement): void {
  for (const tbl of node.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    tbl.replaceWith(scroll);
    scroll.appendChild(tbl);
  }
  for (const pre of node.querySelectorAll<HTMLElement>('pre')) {
    wrapCodeBlock(pre);
  }
}

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
    decoratePnode(node);
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
 *
 * At level 0 the candidates are `.pnode`s, DESCENDANTS of `.pgroup` — which
 * carries `content-visibility: auto` (§4.2, D8). Per `measureTargetTop`'s own
 * comment: a group the browser has SKIPPED gives its descendants NO layout
 * box at all — `offsetTop` reads exactly 0, not an estimate. Confirmed by
 * reproduction (see zoomout-debug.test.ts): with clean, accurate offsets this
 * same "nearest to center" math correctly picks the first section from a
 * fresh, unscrolled document; only real content-visibility-skipped `.pnode`s
 * derail it — reported as the anchor jumping to an unrelated, often much
 * later, section on the very first zoom-out with no caret and no scrolling.
 *
 * Fix: force every `.pgroup` visible for the duration of this read (restored
 * after), the same technique `measureTargetTop` already uses for its single
 * target — applied here to ALL groups, since `resolveAnchor` needs accurate
 * candidates across the whole document, not just one node. This is a genuine
 * "one contained layout" cost paid once per zoom action (D8 already budgets
 * for that), not a per-scroll-frame cost — though on a very large document
 * this reintroduces the full-tree layout D8 specifically avoids; unverified
 * against the 10k-paragraph stress fixture.
 */
/**
 * `el`'s offsetTop RELATIVE TO `layer`, by summing the `offsetParent` chain —
 * never a bare `el.offsetTop`.
 *
 * Why the walk is load-bearing: `content-visibility: auto` on `.pgroup`
 * (§4.2) implies layout containment, and a layout-contained ancestor becomes
 * its descendants' offsetParent. So a `.pnode`'s bare `offsetTop` is
 * GROUP-relative, not layer-relative — confirmed by direct measurement in a
 * real engine (harness, 2026-07-09: pnodes in the section at 1628 reported
 * offsetTop 46/100/334/372). This module's older comments assumed "`.pgroup`
 * unpositioned ⇒ `.pnode.offsetTop` resolves against `.level-layer`" — that
 * stopped being true the moment containment was applied. Blink happens to
 * drop the containment synchronously while our force-visible trick holds,
 * masking the bug there (and in every headless-Chrome verification); WebKit
 * evidently does not, which is why ⌘↓/⌘↑ at k=0 computed tiny group-relative
 * scroll targets in the shipped app and looked like "no scrolling at all."
 * Summing the chain is correct under BOTH behaviors — each hop is measured
 * in its parent's frame, whatever the engine decides that frame is.
 */
function chainedOffsetTop(layer: HTMLElement, el: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== layer) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

export function mountedBoxes(layer: HTMLElement, level: ZoomLevel): MountedBox[] {
  const selector = level === 0 ? '.pnode' : '.pgroup';
  const attr = idAttr(level);

  const forced: { el: HTMLElement; saved: string }[] = [];
  if (level === 0) {
    for (const group of layer.querySelectorAll<HTMLElement>('.pgroup')) {
      forced.push({ el: group, saved: group.style.contentVisibility });
      group.style.contentVisibility = 'visible';
    }
  }

  const boxes: MountedBox[] = [];
  for (const el of layer.querySelectorAll<HTMLElement>(selector)) {
    const id = el.dataset[attr];
    if (!id) continue;
    boxes.push({ id, offsetTop: chainedOffsetTop(layer, el), offsetHeight: el.offsetHeight });
  }

  for (const { el, saved } of forced) el.style.contentVisibility = saved;

  return boxes;
}

/**
 * Find the element carrying `id` at `level` inside `layer` — the level here
 * means "the zoom-transition anchor's own level," where the TARGET NODE TYPE
 * is a paragraph at 0, a section at −1, a milestone at −2 (spec §2.5's
 * mapAcrossLevels output). Used ONLY by `measureTargetTop`; do NOT reuse this
 * for content-map ids — the content-map's bars are SECTIONS at BOTH k=0 and
 * k=−1 (see content-map.ts's buildMapModel), which is a different id-space
 * than "the zoom target at level 0," and passing the current level here for
 * a content-map id silently searches the wrong selector and finds nothing.
 * `findAnyNode` below is level-agnostic and correct for that case.
 */
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
 * Find whichever element carries `id` — a paragraph, section, or milestone —
 * without needing to know which kind it is or what level is mounted. Safe
 * because D6 ids never collide across these three: paragraphs are `P-*`,
 * sections `S-*`, milestones are positional (`M1`, `M2`, ...) — disjoint from
 * both. Used by `topAlignedScrollTop` (⌘↓/⌘↑ and the content-map's
 * click-to-navigate), where the id's "kind" already tells you everything
 * `findNode`'s level parameter would, without the risk of the two
 * disagreeing (see `findNode`'s doc comment for the bug that caused).
 */
function findAnyNode(layer: HTMLElement, id: string): HTMLElement | null {
  return layer.querySelector<HTMLElement>(
    `.pnode[data-pid="${id}"], .pgroup[data-sid="${id}"], .pgroup[data-mid="${id}"]`,
  );
}

/**
 * Read `el`'s box (`offsetTop` RELATIVE TO `layer`, plus `offsetHeight`),
 * forcing its `.pgroup` ancestor to render for the duration if it isn't
 * already its own group.
 *
 * Two content-visibility traps, both handled here (see `chainedOffsetTop`
 * for the second, offsetParent one):
 *
 * 1. A group whose contents the browser has SKIPPED gives its descendants no
 *    layout box at all — force the target's OWN group visible for the read,
 *    restore after. Exactly one group is un-skipped, so this stays the "one
 *    contained layout" §2.5 asks for.
 * 2. Even when the box EXISTS, a `.pnode`'s bare `offsetTop` may be
 *    GROUP-relative (containment ⇒ the group is its offsetParent) —
 *    engine-dependent, and the force in (1) only removes containment
 *    synchronously in some engines. `chainedOffsetTop` sums the chain, which
 *    is correct either way.
 *
 * If, after forcing, the box STILL doesn't exist (`offsetHeight` 0 — an
 * engine that doesn't materialize skipped boxes synchronously at all), fall
 * back to the GROUP's own box: a `.pgroup` is always laid out (skipping
 * hides its contents, not the element). That lands the scroll at the
 * section's top — coarse but real movement — and the caller's settle pass
 * refines to the exact paragraph once the group has genuinely rendered.
 *
 * Shared by `measureTargetTop` (centers the target — zoom transitions) and
 * `topAlignedScrollTop` (aligns it to the top — ⌘↓/⌘↑ item navigation and
 * the content-map's click-to-navigate).
 */
function measureBox(
  layer: HTMLElement,
  el: HTMLElement,
): { offsetTop: number; offsetHeight: number } {
  const group = el.closest<HTMLElement>('.pgroup');
  const forced = group && group !== el ? group : null;
  const saved = forced ? forced.style.contentVisibility : '';
  if (forced) forced.style.contentVisibility = 'visible';

  // --- reads (all of them, together) ---
  let offsetTop = chainedOffsetTop(layer, el);
  let offsetHeight = el.offsetHeight;
  if (forced && offsetHeight === 0) {
    offsetTop = chainedOffsetTop(layer, forced);
    offsetHeight = forced.offsetHeight;
  }

  if (forced) forced.style.contentVisibility = saved;

  return { offsetTop, offsetHeight };
}

/**
 * Measure where `layer` must scroll to top-align the target node just below
 * the viewport's top edge, or null if the node isn't in this layer. Used by
 * the zoom-transition settle (§2.5, amended 2026-07-18).
 */
export function measureTargetTop(
  layer: HTMLElement,
  level: ZoomLevel,
  targetId: string,
): number | null {
  const el = findNode(layer, level, targetId);
  if (!el) return null;
  const box = measureBox(layer, el);
  // --- reads (all of them, together) ---
  const clientHeight = layer.clientHeight;
  const scrollHeight = layer.scrollHeight;
  return topAlignScrollTop(box, { clientHeight, scrollHeight });
}

/**
 * Where `layer` must scroll so `targetId`'s element — a paragraph, section,
 * or milestone, whichever it is — sits just below the top edge — never
 * centered — or null if it isn't in this layer. Used by ⌘↓/⌘↑ item
 * navigation and the content-map's click-to-navigate. Deliberately NOT
 * level-parameterized like `measureTargetTop` — see `findAnyNode`.
 */
export function topAlignedScrollTop(layer: HTMLElement, targetId: string): number | null {
  const el = findAnyNode(layer, targetId);
  if (!el) return null;
  const box = measureBox(layer, el);
  // --- reads (all of them, together) ---
  const clientHeight = layer.clientHeight;
  const scrollHeight = layer.scrollHeight;
  return topAlignScrollTop(box, { clientHeight, scrollHeight });
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
    // Task 3.4 (docs/perf-baseline.md): dev-only level-swap timing, dispatch → settle.
    const swapStart = import.meta.env.DEV ? performance.now() : 0;
    const oldLayer = viewport.querySelector<HTMLElement>('.level-layer');

    // --- Anchor at the SOURCE level (cached offsets of the current layer). ---
    // The anchor is the topmost actually-visible node — scroll position is
    // the only signal (§2.5, amended 2026-07-18). The caret carries no
    // visible UI, so it must never steer navigation the user can't see.
    const viewportTop = oldLayer ? oldLayer.scrollTop : 0;
    const boxes = oldLayer ? mountedBoxes(oldLayer, source) : [];
    const anchorId = resolveAnchor(boxes, viewportTop);

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
        if (import.meta.env.DEV) {
          const ms = (performance.now() - swapStart).toFixed(1);
          console.info(`[perf] level-swap ${source}→${target}: ${ms}ms (budget ≤250ms)`);
        }
        // Transient landing highlight (design doc 2026-07-18): show what the
        // jump anchored to. Opacity-only fade (D1), self-clearing.
        if (targetId && !prefersReducedMotion()) {
          const landed = findNode(newLayer, target, targetId);
          if (landed) {
            landed.setAttribute('data-landed', '');
            const clearLanded = (): void => landed.removeAttribute('data-landed');
            landed.addEventListener('animationend', clearLanded, { once: true });
            setTimeout(clearLanded, 1600); // jsdom / tab-hidden safety net
          }
        }
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

