import { test, expect, beforeEach, afterEach } from 'vitest';
import type { Subscription } from 'rxjs';

import { buildIndex, type LookupTable, type ZoomLevel } from '../engine/schema';
import {
  mountZoomTransitions,
  measureTargetTop,
  topAlignedScrollTop,
  settleScroll,
  mountedBoxes,
  scrollCommands$,
  type ZoomTransitionState,
} from './viewport';
import { actions$ } from '../state/store';
import { zoomSet } from '../state/actions';

// Fixture: 2 meta / 2 sections / 4 paragraphs (mirrors anchor.test.ts). Lets a
// caret in P1a map cleanly to its parent section S1 across a 0 → −1 transition.
const table: LookupTable = {
  version: 1,
  docHash: 'a'.repeat(64),
  meta: {
    M1: { id: 'M1', level: -2, children: ['S1'], title: 'm1', body: 'b' },
    M2: { id: 'M2', level: -2, children: ['S2'], title: 'm2', body: 'b' },
  },
  sections: {
    S1: { id: 'S1', level: -1, parent: 'M1', children: ['P1a', 'P1b'], title: 's1', body: 'b' },
    S2: { id: 'S2', level: -1, parent: 'M2', children: ['P2a', 'P2b'], title: 's2', body: 'b' },
  },
  paragraphs: {
    P1a: { id: 'P1a', level: 0, parent: 'S1', kind: 'prose', span: { start: 0, end: 1 }, html: 'a' },
    P1b: { id: 'P1b', level: 0, parent: 'S1', kind: 'prose', span: { start: 1, end: 2 }, html: 'b' },
    P2a: { id: 'P2a', level: 0, parent: 'S2', kind: 'prose', span: { start: 2, end: 3 }, html: 'c' },
    P2b: { id: 'P2b', level: 0, parent: 'S2', kind: 'prose', span: { start: 3, end: 4 }, html: 'd' },
  },
  order: { meta: ['M1', 'M2'], sections: ['S1', 'S2'], paragraphs: ['P1a', 'P1b', 'P2a', 'P2b'] },
};
const index = buildIndex(table);

// --- Deterministic rAF: a manual queue we drain one "frame" at a time. -------
let rafQueue: FrameRequestCallback[] = [];
let realRaf: typeof requestAnimationFrame;
let realCancel: typeof cancelAnimationFrame;

function flushFrame(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}

// --- Session state the effect reads via getState (as main.ts supplies it). ---
let viewport: HTMLElement;
let level: ZoomLevel;
let caret: { paragraphId: string | null; offset: number };
let caretIsCurrent: boolean;
const lastCaretIn = new Map<string, string>();
const lastAnchorIn = new Map<string, string>();

function getState(): ZoomTransitionState {
  return { table, index, level, caret, caretIsCurrent, lastCaretIn, lastAnchorIn };
}

/** Mimic main.ts requestLevel: dispatch ZOOM_SET, then advance the source. */
function requestLevel(next: ZoomLevel): void {
  actions$.next(zoomSet(next));
  level = next;
}

let teardown: (() => void) | null = null;
let scrollSub: Subscription | null = null;
let scrolls: { el: HTMLElement; top: number }[] = [];

beforeEach(() => {
  realRaf = globalThis.requestAnimationFrame;
  realCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafQueue[id - 1] = () => {};
  }) as typeof cancelAnimationFrame;

  rafQueue = [];
  scrolls = [];
  scrollSub = scrollCommands$.subscribe((c) => scrolls.push(c));

  // Reset the shared store zoom to 0 so the mount emission is a no-op.
  actions$.next(zoomSet(0));
  level = 0;
  caret = { paragraphId: null, offset: 0 };
  caretIsCurrent = true; // default: no fixture scrolls the caret away
  lastCaretIn.clear();
  lastAnchorIn.clear();

  viewport = document.createElement('div');
  viewport.id = 'viewport';
  document.body.appendChild(viewport);

  // Initial mount is DIRECT (as main.ts does on open) — a level-0 layer.
  const initial = document.createElement('div');
  initial.className = 'level-layer';
  initial.dataset.level = '0';
  for (const pid of ['P1a', 'P1b', 'P2a', 'P2b']) {
    const p = document.createElement('div');
    p.className = 'pnode';
    p.dataset.pid = pid;
    initial.appendChild(p);
  }
  viewport.appendChild(initial);

  teardown = mountZoomTransitions(viewport, getState);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  scrollSub?.unsubscribe();
  scrollSub = null;
  viewport.remove();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
});

// jsdom has no layout: offsetTop/clientHeight/scrollTop are all hardcoded 0.
// Shadow them per-instance so the centering math has something real to chew on.
function stubBox(el: HTMLElement, offsetTop: number, offsetHeight: number): void {
  Object.defineProperty(el, 'offsetTop', { value: offsetTop, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: offsetHeight, configurable: true });
}
function stubMetrics(el: HTMLElement, clientHeight: number, scrollHeight: number): void {
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
}

/** A level-0 layer: one `.pgroup` wrapping one `.pnode` (the skipped-box case). */
function makeLayer(): { layer: HTMLElement; group: HTMLElement; node: HTMLElement } {
  const layer = document.createElement('div');
  layer.className = 'level-layer';
  const group = document.createElement('section');
  group.className = 'pgroup';
  group.dataset.sid = 'S1';
  const node = document.createElement('div');
  node.className = 'pnode';
  node.dataset.pid = 'P1a';
  group.appendChild(node);
  layer.appendChild(group);
  return { layer, group, node };
}

function fireOpacityEnd(layer: HTMLElement): void {
  const ev = new Event('transitionend');
  Object.defineProperty(ev, 'propertyName', { value: 'opacity' });
  layer.dispatchEvent(ev);
}

test('frame n: entering layer is appended with NO scroll write', () => {
  caret = { paragraphId: 'P1a', offset: 0 };
  requestLevel(-1); // synchronously runs frame n

  const entering = viewport.querySelectorAll('.level-layer[data-entering]');
  expect(entering.length).toBe(1);
  const layer = entering[0] as HTMLElement;
  expect(layer.dataset.level).toBe('-1');
  expect(layer.style.visibility).toBe('hidden');
  expect(viewport.getAttribute('data-transitioning')).toBe('');
  // Both layers coexist; frame n is measurement-free.
  expect(viewport.querySelectorAll('.level-layer').length).toBe(2);
  expect(scrolls.length).toBe(0); // no scrollTop write in frame n (D8)
});

test('frame n+1: scroll write occurs and the fade starts (data-entering removed)', () => {
  caret = { paragraphId: 'P1a', offset: 0 };
  requestLevel(-1);
  const layer = viewport.querySelector('.level-layer[data-entering]') as HTMLElement;
  // Give the entering layer real geometry: target S1 centered → 500+50-200 = 350.
  stubMetrics(layer, 400, 2000);
  stubBox(layer.querySelector('.pgroup[data-sid="S1"]') as HTMLElement, 500, 100);

  expect(scrolls.length).toBe(0);
  flushFrame(); // frame n+1

  expect(scrolls.length).toBe(1);
  expect(scrolls[0].el).toBe(layer); // scroll routed onto the NEW layer
  expect(scrolls[0].top).toBe(350); // centered, not slammed to the top
  expect(layer.hasAttribute('data-entering')).toBe(false); // fade started
  expect(layer.style.visibility).toBe('visible');
});

test('opacity-only: the effect never sets an inline filter or transition', () => {
  caret = { paragraphId: 'P1a', offset: 0 };
  requestLevel(-1);
  const layer = viewport.querySelector('.level-layer[data-entering]') as HTMLElement;
  flushFrame();

  // The crossfade is driven entirely by the .level-layer opacity rule (§4.2);
  // the effect touches only visibility, never a filter/layout transition (D1).
  expect(layer.style.filter).toBe('');
  expect(layer.style.transition).toBe('');
});

test('transitionend unmounts the old layer and clears [data-transitioning]', () => {
  caret = { paragraphId: 'P1a', offset: 0 };
  requestLevel(-1);
  const layer = viewport.querySelector('.level-layer[data-entering]') as HTMLElement;
  flushFrame();
  fireOpacityEnd(layer);

  const layers = viewport.querySelectorAll('.level-layer');
  expect(layers.length).toBe(1);
  expect((layers[0] as HTMLElement).dataset.level).toBe('-1');
  expect(viewport.hasAttribute('data-transitioning')).toBe(false);
  expect(viewport.dataset.zoom).toBe('-1');
});

test('a caret you have scrolled away from (caretIsCurrent=false) is ignored — falls back to nearest-center', () => {
  const layer = viewport.querySelector('.level-layer') as HTMLElement;
  const [p1a, p1b, p2a, p2b] = Array.from(layer.querySelectorAll<HTMLElement>('.pnode'));
  stubBox(p1a, 0, 10);
  stubBox(p1b, 10, 10);
  stubBox(p2a, 1000, 10);
  stubBox(p2b, 1010, 10);
  stubMetrics(layer, 2000, 3000); // center = scrollTop(0) + 2000/2 = 1000 → nearest is P2a

  caret = { paragraphId: 'P1a', offset: 0 }; // an old click, in S1
  caretIsCurrent = false; // ...but the user has since scrolled away from it
  requestLevel(-1);

  // recordPlace (§2.5) records the ancestor of whichever anchor was actually
  // used — S2 (P2a's parent, nearest-center), NOT S1 (the stale caret's
  // section). Proves the stale caret was ignored, not just "also considered."
  expect(lastCaretIn.get('S2')).toBe('P2a');
  expect(lastCaretIn.has('S1')).toBe(false);
});

test('by contrast, a caret that IS still current wins over nearest-center', () => {
  const layer = viewport.querySelector('.level-layer') as HTMLElement;
  const [p1a, p1b, p2a, p2b] = Array.from(layer.querySelectorAll<HTMLElement>('.pnode'));
  stubBox(p1a, 0, 10);
  stubBox(p1b, 10, 10);
  stubBox(p2a, 1000, 10);
  stubBox(p2b, 1010, 10);
  stubMetrics(layer, 2000, 3000); // same geometry — nearest-center would pick P2a

  caret = { paragraphId: 'P1a', offset: 0 };
  caretIsCurrent = true; // no scroll since placing it — still authoritative
  requestLevel(-1);

  expect(lastCaretIn.get('S1')).toBe('P1a');
  expect(lastCaretIn.has('S2')).toBe(false);
});

test('regression: a stale level-0 caret does not crash a transition FROM sections', () => {
  // Reproduces the reported hang, following the real flow: click raw content
  // (sets caret paragraphId), zoom to Sections, then zoom back. Before the fix,
  // at source −1 the stale P-id was used as the anchor and `mapAcrossLevels`
  // did `table.sections[<pid>].children[0]` → threw → the switchMap subscription
  // errored and ALL further zoom switches stopped responding.
  caret = { paragraphId: 'P1a', offset: 0 }; // clicked a raw paragraph

  // 0 → −1 and settle (store zoom tracks via requestLevel's zoomSet).
  requestLevel(-1);
  let entering = viewport.querySelector('.level-layer[data-entering]') as HTMLElement;
  flushFrame();
  fireOpacityEnd(entering);
  expect(viewport.querySelector('.level-layer')?.getAttribute('data-level')).toBe('-1');

  // The caret pid is still stale at −1. Zooming back to raw must NOT throw
  // (a throw would error the switchMap subscription forever)...
  expect(() => requestLevel(0)).not.toThrow();
  // ...and the transition still runs: an entering level-0 layer is appended.
  expect(
    viewport.querySelectorAll('.level-layer[data-level="0"][data-entering]').length,
  ).toBe(1);

  // Crucially, zoom STILL responds afterward — settle, then zoom again.
  entering = viewport.querySelector('.level-layer[data-entering]') as HTMLElement;
  flushFrame();
  fireOpacityEnd(entering);
  requestLevel(-2);
  expect(viewport.querySelectorAll('.level-layer[data-entering]').length).toBe(1);
});

// --- measureTargetTop: reading through `content-visibility: auto` -----------

test('measureTargetTop force-renders the target\'s group for the read, then restores it', () => {
  const { layer, group, node } = makeLayer();
  group.style.contentVisibility = 'auto'; // as focus-mask.css sets it (D8)
  stubMetrics(layer, 400, 2000);
  stubBox(node, 500, 100);

  // Capture what content-visibility was AT THE MOMENT the descendant was read:
  // that is the whole point — a skipped group yields offsetTop 0.
  let seenDuringRead: string | null = null;
  Object.defineProperty(node, 'offsetTop', {
    configurable: true,
    get() {
      seenDuringRead = group.style.contentVisibility;
      return 500;
    },
  });

  const top = measureTargetTop(layer, 0, 'P1a');

  expect(seenDuringRead).toBe('visible');            // forced to render
  expect(group.style.contentVisibility).toBe('auto'); // ...and restored
  expect(top).toBe(350);                              // 500 + 100/2 - 400/2
});

test('measureTargetTop leaves the group untouched when the group IS the target (−1/−2)', () => {
  const { layer, group } = makeLayer();
  group.style.contentVisibility = 'auto';
  stubMetrics(layer, 400, 2000);
  stubBox(group, 500, 100);

  let touched = false;
  Object.defineProperty(group, 'offsetTop', {
    configurable: true,
    get() {
      touched = group.style.contentVisibility !== 'auto';
      return 500;
    },
  });

  expect(measureTargetTop(layer, -1, 'S1')).toBe(350);
  expect(touched).toBe(false); // a .pgroup always has its own box
  expect(group.style.contentVisibility).toBe('auto');
});

test('measureTargetTop returns null when the target is absent from the layer', () => {
  const { layer } = makeLayer();
  expect(measureTargetTop(layer, 0, 'P-nope')).toBe(null);
});

// --- topAlignedScrollTop: ⌘↓/⌘↑ and content-map click-to-navigate -----------
// Two distinct regressions guarded here, in order:
//  1. An earlier version of main.ts's scrollItemToTop read `el.offsetTop`
//     directly with no content-visibility guard — the active-group highlight
//     moved (a plain attribute write, no layout dependency) but the viewport
//     never actually scrolled once the target paragraph's section was
//     off-screen, since the computed target was always (wrongly) 0.
//  2. Fixing #1 by threading a `level` parameter through to a level-keyed
//     selector broke content-map clicks AT k=0 specifically: content-map
//     bars are SECTION ids at BOTH k=0 and k=−1 (buildMapModel), but a
//     level-keyed lookup assumed "k=0 id" always means "paragraph id" (true
//     for the zoom-transition anchor, false for the content-map). A section
//     id at k=0 silently matched nothing and no-op'd. `topAlignedScrollTop`
//     takes NO level parameter at all now — id "kind" (P-/S-/M- prefix) is
//     unambiguous on its own, so there is nothing left to disagree with.

test('topAlignedScrollTop force-renders the target\'s group for the read, then restores it (paragraph id)', () => {
  const { layer, group, node } = makeLayer();
  group.style.contentVisibility = 'auto';
  stubMetrics(layer, 400, 2000);
  stubBox(node, 500, 100);

  let seenDuringRead: string | null = null;
  Object.defineProperty(node, 'offsetTop', {
    configurable: true,
    get() {
      seenDuringRead = group.style.contentVisibility;
      return 500;
    },
  });

  const top = topAlignedScrollTop(layer, 'P1a');

  expect(seenDuringRead).toBe('visible');             // forced to render
  expect(group.style.contentVisibility).toBe('auto');  // ...and restored
  expect(top).toBe(476);                                // 500 - 24
});

test('topAlignedScrollTop leaves the group untouched when the group IS the target (section id)', () => {
  const { layer, group } = makeLayer();
  group.style.contentVisibility = 'auto';
  stubMetrics(layer, 400, 2000);
  stubBox(group, 500, 100);

  let touched = false;
  Object.defineProperty(group, 'offsetTop', {
    configurable: true,
    get() {
      touched = group.style.contentVisibility !== 'auto';
      return 500;
    },
  });

  // The section id resolves correctly with NO level argument — this is
  // regression #2's exact repro: a section id used to only work when the
  // caller also happened to pass level=-1.
  expect(topAlignedScrollTop(layer, 'S1')).toBe(476);
  expect(touched).toBe(false); // a .pgroup always has its own box
  expect(group.style.contentVisibility).toBe('auto');
});

test('topAlignedScrollTop clamps to [0, scrollHeight - clientHeight]', () => {
  const { layer, node } = makeLayer();
  stubMetrics(layer, 400, 2000);

  stubBox(node, 10, 20); // near the very top: 10 - 24 would go negative
  expect(topAlignedScrollTop(layer, 'P1a')).toBe(0);

  stubBox(node, 1990, 20); // near the very end: past the max scroll
  expect(topAlignedScrollTop(layer, 'P1a')).toBe(1600); // 2000 - 400
});

test('topAlignedScrollTop returns null when the target is absent from the layer', () => {
  const { layer } = makeLayer();
  expect(topAlignedScrollTop(layer, 'P-nope')).toBe(null);
});

// --- mountedBoxes: the SOURCE-side anchor read, same content-visibility bug ---
// Reported: on a fresh document, scrolled to the very top, with no caret ever
// placed, clicking zoom-out landed on an unrelated (often much later) section.
// Root cause: `mountedBoxes(layer, 0)` read every `.pnode`'s offsetTop
// UNGUARDED — any node inside a still-skipped `.pgroup` (i.e. everything not
// yet scrolled to) reported exactly 0, corrupting "nearest to center" for
// every off-screen candidate. Fixed the same way `measureTargetTop` already
// fixes it for one target: force every `.pgroup` visible for the read.

test('mountedBoxes(level=0) force-renders EVERY group for the read, then restores each', () => {
  const layer = document.createElement('div');
  layer.className = 'level-layer';
  const groups = ['S1', 'S2', 'S3'].map((sid, i) => {
    const group = document.createElement('section');
    group.className = 'pgroup';
    group.dataset.sid = sid;
    group.style.contentVisibility = 'auto';
    const node = document.createElement('div');
    node.className = 'pnode';
    node.dataset.pid = `P${i}`;
    stubBox(node, i * 500, 50);
    group.appendChild(node);
    layer.appendChild(group);
    return group;
  });

  // Every group must be 'visible' AT THE MOMENT its descendant is read —
  // exactly the skipped-group failure mode (offsetTop reads 0 while skipped).
  const seenDuringRead: string[] = [];
  groups.forEach((group, i) => {
    const node = group.querySelector('.pnode') as HTMLElement;
    Object.defineProperty(node, 'offsetTop', {
      configurable: true,
      get() {
        seenDuringRead.push(group.style.contentVisibility);
        return i * 500;
      },
    });
  });

  const boxes = mountedBoxes(layer, 0);

  expect(seenDuringRead).toEqual(['visible', 'visible', 'visible']);
  expect(groups.map((g) => g.style.contentVisibility)).toEqual(['auto', 'auto', 'auto']);
  expect(boxes).toHaveLength(3);
});

test('mountedBoxes(level=-1/-2) never touches content-visibility — a .pgroup always has its own box', () => {
  const { layer, group } = makeLayer();
  group.style.contentVisibility = 'auto';
  stubBox(group, 500, 100);

  let touched = false;
  Object.defineProperty(group, 'offsetTop', {
    configurable: true,
    get() {
      touched = group.style.contentVisibility !== 'auto';
      return 500;
    },
  });

  mountedBoxes(layer, -1);

  expect(touched).toBe(false);
  expect(group.style.contentVisibility).toBe('auto');
});

// --- settleScroll: converge onto the true offset over a few frames ----------

test('settleScroll stops immediately when already converged (no scroll command)', () => {
  const { layer, node } = makeLayer();
  stubMetrics(layer, 400, 2000);
  stubBox(node, 500, 100); // target top = 350
  Object.defineProperty(layer, 'scrollTop', { value: 350, configurable: true });

  const scheduled: (() => void)[] = [];
  settleScroll(layer, 0, 'P1a', 5, (cb) => void scheduled.push(cb));

  expect(scrolls.length).toBe(0); // nothing to write
  expect(scheduled.length).toBe(0); // and nothing to re-check
});

test('settleScroll re-enqueues while not converged, capped at the frame budget', () => {
  const { layer, node } = makeLayer();
  stubMetrics(layer, 400, 2000);
  stubBox(node, 500, 100); // target top = 350, layer.scrollTop stays 0 in jsdom

  // Drive the chain by hand: each scheduled callback is one animation frame.
  const scheduled: (() => void)[] = [];
  const schedule = (cb: () => void): void => void scheduled.push(cb);
  settleScroll(layer, 0, 'P1a', 5, schedule);

  let frames = 0;
  while (scheduled.length) {
    frames++;
    (scheduled.shift() as () => void)();
    expect(frames).toBeLessThanOrEqual(5); // hard cap, never a runaway loop
  }

  // Never converges (jsdom never applies the scroll), so it burns the whole
  // budget: the initial measure + 5 settle frames = 6 commands, then stops.
  expect(frames).toBe(5);
  expect(scrolls.length).toBe(6);
  for (const c of scrolls) {
    expect(c.el).toBe(layer);
    expect(c.top).toBe(350);
  }
});

test('settleScroll writes scroll ONLY through the scrollCommands$ queue', () => {
  const { layer, node } = makeLayer();
  stubMetrics(layer, 400, 2000);
  stubBox(node, 500, 100);

  let directWrites = 0;
  Object.defineProperty(layer, 'scrollTop', {
    configurable: true,
    get: () => 0,
    set: () => {
      directWrites++;
    },
  });

  settleScroll(layer, 0, 'P1a', 0, () => {});

  expect(scrolls.length).toBe(1); // enqueued
  expect(directWrites).toBe(0);   // never assigned synchronously
});

test('a superseded zoom aborts the previous transition (switchMap) — one final layer', () => {
  caret = { paragraphId: 'P1a', offset: 0 };
  requestLevel(-1); // frame n for −1
  requestLevel(-2); // aborts −1, frame n for −2

  // Exactly one entering layer survives the abort (the −2 one).
  const entering = viewport.querySelectorAll('.level-layer[data-entering]');
  expect(entering.length).toBe(1);
  const layer = entering[0] as HTMLElement;
  expect(layer.dataset.level).toBe('-2');

  flushFrame();
  fireOpacityEnd(layer);

  const layers = viewport.querySelectorAll('.level-layer');
  expect(layers.length).toBe(1);
  expect((layers[0] as HTMLElement).dataset.level).toBe('-2');
});
