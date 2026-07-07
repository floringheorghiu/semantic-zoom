import { test, expect, beforeEach, afterEach } from 'vitest';
import type { Subscription } from 'rxjs';

import { buildIndex, type LookupTable, type ZoomLevel } from '../engine/schema';
import {
  mountZoomTransitions,
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
const lastCaretIn = new Map<string, string>();
const lastAnchorIn = new Map<string, string>();

function getState(): ZoomTransitionState {
  return { table, index, level, caret, lastCaretIn, lastAnchorIn };
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

  expect(scrolls.length).toBe(0);
  flushFrame(); // frame n+1

  expect(scrolls.length).toBe(1);
  expect(scrolls[0].el).toBe(layer); // scroll routed onto the NEW layer
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
