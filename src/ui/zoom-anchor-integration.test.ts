// End-to-end regression using the REAL zoom_test.md payload and the REAL
// renderLevel/mountZoomTransitions pipeline (not synthetic fixtures like
// transition.test.ts's 4-paragraph table). Guards the exact reported
// scenario: a fresh document, scrolled to the very top, no caret ever
// placed, zoom-out via the level buttons only.
import { test, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildIndex, type LookupTable } from '../engine/schema';
import { renderLevel, mountZoomTransitions, scrollCommands$, type ZoomTransitionState } from './viewport';
import { actions$ } from '../state/store';
import { zoomSet } from '../state/actions';
import type { Subscription } from 'rxjs';

// No TS-side payload parser exists (Rust owns disk truth — the frontend only
// ever receives an already-parsed LookupTable over IPC). Slice the JSON block
// out directly, same as `load_document` locates it.
function loadRealTable(): LookupTable {
  const raw = readFileSync('fixtures/zoom_test.md', 'utf8');
  const head = '<!-- semantic-zoom:payload:v1';
  const start = raw.lastIndexOf(head) + head.length;
  const end = raw.indexOf('-->', start);
  return JSON.parse(raw.slice(start, end).trim()) as LookupTable;
}

const table = loadRealTable();
const index = buildIndex(table);

let rafQueue: FrameRequestCallback[] = [];
function flushFrame(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}

let viewport: HTMLElement;
let teardown: (() => void) | null = null;
let scrollSub: Subscription | null = null;
let scrolls: { el: HTMLElement; top: number }[] = [];

beforeEach(() => {
  rafQueue = [];
  scrolls = [];
  scrollSub = scrollCommands$.subscribe((c) => scrolls.push(c));
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  actions$.next(zoomSet(0));

  viewport = document.createElement('div');
  document.body.appendChild(viewport);
  renderLevel(viewport, table, index, 0);

  // jsdom has no layout engine and does not model `content-visibility`, so it
  // can't reproduce the real browser bug this guards against (see
  // mountedBoxes in viewport.ts + its dedicated tests in transition.test.ts
  // for that). This test instead pins the CORRECT end state with clean,
  // accurate, monotonically-increasing offsets — i.e. what a real browser
  // reports once `mountedBoxes`'s force-visible fix is applied.
  const layer = viewport.querySelector('.level-layer') as HTMLElement;
  let cursor = 0;
  for (const el of layer.querySelectorAll<HTMLElement>('.pnode, .pgroup')) {
    Object.defineProperty(el, 'offsetTop', { value: cursor, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: 40, configurable: true });
    cursor += 40;
  }
  Object.defineProperty(layer, 'clientHeight', { value: 700, configurable: true });
  Object.defineProperty(layer, 'scrollHeight', { value: cursor, configurable: true });
  Object.defineProperty(layer, 'scrollTop', { value: 0, configurable: true, writable: true });

  const state: ZoomTransitionState = {
    table,
    index,
    level: 0,
    lastCaretIn: new Map(),
    lastAnchorIn: new Map(),
  };
  teardown = mountZoomTransitions(viewport, () => state);
});

afterEach(() => {
  teardown?.();
  scrollSub?.unsubscribe();
  scrollSub = null;
  viewport.remove();
});

test('fresh top-of-doc, no caret, zoom L0->L-1 scrolls to the FIRST section (not an unrelated later one)', () => {
  actions$.next(zoomSet(-1)); // frame n: entering layer appended, not yet measured

  const entering = viewport.querySelector('.level-layer[data-level="-1"]') as HTMLElement;
  expect(entering).toBeTruthy();

  // Stub the ENTERING layer's own boxes too (clean, accurate, same scheme),
  // and start its scrollTop somewhere else entirely so a real convergent
  // write is observable — if the anchor were wrong (the reported bug: an
  // unrelated later section), this would settle on a scrollTop of thousands
  // instead of 0.
  let cursor = 0;
  for (const el of entering.querySelectorAll<HTMLElement>('.pgroup')) {
    Object.defineProperty(el, 'offsetTop', { value: cursor, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: 40, configurable: true });
    cursor += 40;
  }
  Object.defineProperty(entering, 'clientHeight', { value: 700, configurable: true });
  Object.defineProperty(entering, 'scrollHeight', { value: cursor, configurable: true });
  Object.defineProperty(entering, 'scrollTop', { value: 5000, configurable: true, writable: true });

  flushFrame(); // frame n+1: measure + scroll write

  const firstSid = table.order.sections[0];
  expect(firstSid).toBe('S-ab80d77b-0'); // the fixture's actual first section
  expect(scrolls).toHaveLength(1);
  expect(scrolls[0].top).toBe(0); // top-aligns on the FIRST section, not a later one
});
