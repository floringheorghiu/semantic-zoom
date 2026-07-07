import { test, expect } from 'vitest';
import { buildIndex, type LookupTable } from './schema';
import {
  centerScrollTop,
  resolveAnchor,
  mapAcrossLevels,
  type MapCtx,
} from './anchor';

// Fixture: 2 meta, each with a section, each section with ≥2 paragraphs.
// This makes "first child" (children[0]) differ from a "remembered" place.
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
    P1a: { id: 'P1a', level: 0, parent: 'S1', kind: 'prose', span: { start: 0, end: 1 }, html: '' },
    P1b: { id: 'P1b', level: 0, parent: 'S1', kind: 'prose', span: { start: 1, end: 2 }, html: '' },
    P2a: { id: 'P2a', level: 0, parent: 'S2', kind: 'prose', span: { start: 2, end: 3 }, html: '' },
    P2b: { id: 'P2b', level: 0, parent: 'S2', kind: 'prose', span: { start: 3, end: 4 }, html: '' },
  },
  order: { meta: ['M1', 'M2'], sections: ['S1', 'S2'], paragraphs: ['P1a', 'P1b', 'P2a', 'P2b'] },
};

function makeCtx(overrides?: Partial<Pick<MapCtx, 'lastCaretIn' | 'lastAnchorIn'>>): MapCtx {
  return {
    index: buildIndex(table),
    table,
    lastCaretIn: overrides?.lastCaretIn ?? new Map(),
    lastAnchorIn: overrides?.lastAnchorIn ?? new Map(),
  };
}

test('from === to returns the anchor unchanged', () => {
  const ctx = makeCtx();
  expect(mapAcrossLevels(0, 0, 'P1b', ctx)).toBe('P1b');
  expect(mapAcrossLevels(-1, -1, 'S1', ctx)).toBe('S1');
  expect(mapAcrossLevels(-2, -2, 'M1', ctx)).toBe('M1');
});

test('0 → −1 = parentOfParagraph', () => {
  expect(mapAcrossLevels(0, -1, 'P1b', makeCtx())).toBe('S1');
  expect(mapAcrossLevels(0, -1, 'P2a', makeCtx())).toBe('S2');
});

test('0 → −2 = parentOfSection(parentOfParagraph)', () => {
  expect(mapAcrossLevels(0, -2, 'P1b', makeCtx())).toBe('M1');
  expect(mapAcrossLevels(0, -2, 'P2b', makeCtx())).toBe('M2');
});

test('−1 → 0 uses remembered caret when present', () => {
  const ctx = makeCtx({ lastCaretIn: new Map([['S1', 'P1b']]) });
  expect(mapAcrossLevels(-1, 0, 'S1', ctx)).toBe('P1b');
});

test('−1 → 0 falls back to first child when absent', () => {
  const ctx = makeCtx();
  expect(mapAcrossLevels(-1, 0, 'S1', ctx)).toBe('P1a');
});

test('−1 → −2 = parentOfSection', () => {
  expect(mapAcrossLevels(-1, -2, 'S1', makeCtx())).toBe('M1');
  expect(mapAcrossLevels(-1, -2, 'S2', makeCtx())).toBe('M2');
});

test('−2 → −1 uses remembered anchor when present', () => {
  const ctx = makeCtx({ lastAnchorIn: new Map([['M1', 'S1']]) });
  expect(mapAcrossLevels(-2, -1, 'M1', ctx)).toBe('S1');
});

test('−2 → −1 falls back to first child when absent', () => {
  const ctx = makeCtx();
  expect(mapAcrossLevels(-2, -1, 'M1', ctx)).toBe('S1');
  expect(mapAcrossLevels(-2, -1, 'M2', ctx)).toBe('S2');
});

test('−2 → 0 is the two-hop composition (still O(1))', () => {
  // No memory: M1 → S1 (first child) → P1a (first child)
  expect(mapAcrossLevels(-2, 0, 'M1', makeCtx())).toBe('P1a');
  // With memory at both hops: M1 → S1 (remembered) → P1b (remembered)
  const ctx = makeCtx({
    lastAnchorIn: new Map([['M1', 'S1']]),
    lastCaretIn: new Map([['S1', 'P1b']]),
  });
  expect(mapAcrossLevels(-2, 0, 'M1', ctx)).toBe('P1b');
});

test('centerScrollTop clamps at 0', () => {
  const top = centerScrollTop(
    { offsetTop: 0, offsetHeight: 10 },
    { clientHeight: 100, scrollHeight: 1000 }
  );
  expect(top).toBe(0);
});

test('centerScrollTop clamps at scrollHeight - clientHeight', () => {
  const top = centerScrollTop(
    { offsetTop: 990, offsetHeight: 10 },
    { clientHeight: 100, scrollHeight: 1000 }
  );
  expect(top).toBe(900);
});

test('centerScrollTop centers an element in between', () => {
  // ideal = 500 + 100/2 - 400/2 = 350, unclamped
  const top = centerScrollTop(
    { offsetTop: 500, offsetHeight: 100 },
    { clientHeight: 400, scrollHeight: 2000 }
  );
  expect(top).toBe(350);
});

test('resolveAnchor returns the caret paragraph when set', () => {
  const mounted = [
    { id: 'P1a', offsetTop: 0, offsetHeight: 100 },
    { id: 'P1b', offsetTop: 100, offsetHeight: 100 },
  ];
  expect(resolveAnchor('P1b', mounted, 20)).toBe('P1b');
});

test('resolveAnchor picks the node nearest the viewport center', () => {
  const mounted = [
    { id: 'P1a', offsetTop: 0, offsetHeight: 100 },   // center 50
    { id: 'P1b', offsetTop: 100, offsetHeight: 100 }, // center 150
    { id: 'P2a', offsetTop: 200, offsetHeight: 100 }, // center 250
  ];
  expect(resolveAnchor(null, mounted, 160)).toBe('P1b');
  expect(resolveAnchor(null, mounted, 40)).toBe('P1a');
  expect(resolveAnchor(null, mounted, 300)).toBe('P2a');
});

test('resolveAnchor returns null for an empty mounted set with no caret', () => {
  expect(resolveAnchor(null, [], 100)).toBe(null);
});
