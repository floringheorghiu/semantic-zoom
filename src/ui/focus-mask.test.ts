import { test, expect, beforeEach, afterEach, vi } from 'vitest';

import type { LookupTable } from '../engine/schema';
import { mountFocusMask } from './focus-mask';
import { actions$ } from '../state/store';
import { caretPlaced, docLoaded } from '../state/actions';
import type { LoadResultDTO } from '../engine/engine-a';

// Three sections, each with two paragraphs. index.parentOfParagraph maps every
// paragraph → its section; caretPlaced sets activeGroupHead = first P of the
// caret's sibling group, from which focus-mask derives the active section id.
const table: LookupTable = {
  version: 1,
  docHash: 'a'.repeat(64),
  meta: {
    M1: { id: 'M1', level: -2, children: ['S1', 'S2', 'S3'], title: 'm', body: 'b' },
  },
  sections: {
    S1: { id: 'S1', level: -1, parent: 'M1', children: ['P1a', 'P1b'], title: 's1', body: 'b' },
    S2: { id: 'S2', level: -1, parent: 'M1', children: ['P2a', 'P2b'], title: 's2', body: 'b' },
    S3: { id: 'S3', level: -1, parent: 'M1', children: ['P3a', 'P3b'], title: 's3', body: 'b' },
  },
  paragraphs: {
    P1a: { id: 'P1a', level: 0, parent: 'S1', kind: 'prose', span: { start: 0, end: 1 }, html: 'a' },
    P1b: { id: 'P1b', level: 0, parent: 'S1', kind: 'prose', span: { start: 1, end: 2 }, html: 'b' },
    P2a: { id: 'P2a', level: 0, parent: 'S2', kind: 'prose', span: { start: 2, end: 3 }, html: 'c' },
    P2b: { id: 'P2b', level: 0, parent: 'S2', kind: 'prose', span: { start: 3, end: 4 }, html: 'd' },
    P3a: { id: 'P3a', level: 0, parent: 'S3', kind: 'prose', span: { start: 4, end: 5 }, html: 'e' },
    P3b: { id: 'P3b', level: 0, parent: 'S3', kind: 'prose', span: { start: 5, end: 6 }, html: 'f' },
  },
  order: {
    meta: ['M1'],
    sections: ['S1', 'S2', 'S3'],
    paragraphs: ['P1a', 'P1b', 'P2a', 'P2b', 'P3a', 'P3b'],
  },
};

const nativeResult: LoadResultDTO = { kind: 'native', table, raw: 'raw' };

let viewport: HTMLElement;
let groups: Record<string, HTMLElement>;
let teardown: (() => void) | null = null;

function makeGroup(sid: string): HTMLElement {
  const g = document.createElement('section');
  g.className = 'pgroup';
  g.dataset.sid = sid;
  viewport.appendChild(g);
  return g;
}

function dimmedSet(): Set<string> {
  const set = new Set<string>();
  for (const [sid, g] of Object.entries(groups)) {
    if (g.hasAttribute('data-dimmed')) set.add(sid);
  }
  return set;
}

beforeEach(() => {
  viewport = document.createElement('div');
  viewport.id = 'viewport';
  document.body.appendChild(viewport);
  groups = { S1: makeGroup('S1'), S2: makeGroup('S2'), S3: makeGroup('S3') };

  // Feed the store so index.parentOfParagraph exists and activeGroupHead resets.
  actions$.next(docLoaded(nativeResult));
  teardown = mountFocusMask(viewport);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  viewport.remove();
});

test('initial spotlight: first active group is lit, every OTHER group is dimmed', () => {
  actions$.next(caretPlaced('P1a', 0)); // active section = S1

  expect(groups.S1.hasAttribute('data-dimmed')).toBe(false);
  expect(groups.S2.hasAttribute('data-dimmed')).toBe(true);
  expect(groups.S3.hasAttribute('data-dimmed')).toBe(true);
  expect(dimmedSet()).toEqual(new Set(['S2', 'S3']));
});

test('a subsequent active-group change flips EXACTLY the two groups whose state changed', () => {
  actions$.next(caretPlaced('P1a', 0)); // spotlight S1: dimmed = {S2, S3}
  const before = dimmedSet();
  expect(before).toEqual(new Set(['S2', 'S3']));

  // Spy AFTER the initial spotlight so we count only the second change's touches.
  const spies = Object.fromEntries(
    Object.entries(groups).map(([sid, g]) => [
      sid,
      { set: vi.spyOn(g, 'setAttribute'), remove: vi.spyOn(g, 'removeAttribute') },
    ]),
  );

  actions$.next(caretPlaced('P2b', 0)); // move active section S1 → S2

  // Exactly two groups' dimmed state flipped: S1 gains dimmed, S2 loses it.
  const after = dimmedSet();
  expect(after).toEqual(new Set(['S1', 'S3']));

  const dimmedChanges = (s: { set: ReturnType<typeof vi.spyOn>; remove: ReturnType<typeof vi.spyOn> }) =>
    s.set.mock.calls.filter((c: unknown[]) => c[0] === 'data-dimmed').length +
    s.remove.mock.calls.filter((c: unknown[]) => c[0] === 'data-dimmed').length;

  expect(dimmedChanges(spies.S1)).toBe(1); // dimmed on
  expect(dimmedChanges(spies.S2)).toBe(1); // dimmed off
  expect(dimmedChanges(spies.S3)).toBe(0); // untouched — never re-dims all groups
});
