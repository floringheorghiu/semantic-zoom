import { Subject, animationFrameScheduler, Observable } from 'rxjs';
import { observeOn, switchMap } from 'rxjs/operators';

import type { LookupTable, ResolvedIndex, ZoomLevel } from '../engine/schema';
import {
  resolveAnchor,
  mapAcrossLevels,
  centerScrollTop,
  type MountedBox,
  type MapCtx,
} from '../engine/anchor';
import { selectZoom } from '../state/selectors';

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
 */
export function buildLevel(
  table: LookupTable,
  _index: ResolvedIndex,
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

  return layer;
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
    const anchorId = resolveAnchor(st.caret.paragraphId, boxes, center);

    // Remember the place we're leaving so zooming back in feels "remembered".
    if (anchorId) {
      if (source === 0) {
        const s = st.index.parentOfParagraph.get(anchorId);
        if (s) st.lastCaretIn.set(s, anchorId);
      } else if (source === -1) {
        const m = st.index.parentOfSection.get(anchorId);
        if (m) st.lastAnchorIn.set(m, anchorId);
      }
    }

    const ctx: MapCtx = {
      index: st.index,
      table: st.table,
      lastCaretIn: st.lastCaretIn,
      lastAnchorIn: st.lastAnchorIn,
    };
    const targetId = anchorId ? mapAcrossLevels(source, target, anchorId, ctx) : null;

    // --- Frame n: append target layer hidden. NO layout read here (D8). ---
    const newLayer = buildLevel(st.table, st.index, target);
    newLayer.setAttribute('data-entering', ''); // opacity:0 via CSS
    newLayer.style.visibility = 'hidden';
    viewport.appendChild(newLayer);
    viewport.setAttribute('data-transitioning', ''); // gates will-change (§4.2)

    let done = false;
    let timeoutId: ReturnType<typeof setTimeout> | 0 = 0;
    let onEnd: ((e: TransitionEvent) => void) | null = null;

    // --- Frame n+1: one contained measure → scroll → start fade. ---
    const rafId = requestAnimationFrame(() => {
      if (targetId) {
        const el = findNode(newLayer, target, targetId);
        if (el) {
          const top = centerScrollTop(
            { offsetTop: el.offsetTop, offsetHeight: el.offsetHeight },
            { clientHeight: newLayer.clientHeight, scrollHeight: newLayer.scrollHeight },
          );
          scrollCommands$.next({ el: newLayer, top }); // single rAF queue
        }
      }
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
        subscriber.complete();
      };

      if (prefersReducedMotion()) {
        // CSS sets `transition:none` → no transitionend fires; swap next frame.
        requestAnimationFrame(finish);
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
      cancelAnimationFrame(rafId);
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
): () => void {
  const sub = selectZoom()
    .pipe(switchMap((target) => runTransition(viewport, getState, target)))
    .subscribe();
  return () => sub.unsubscribe();
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
