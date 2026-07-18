import { describe, test, expect } from 'vitest';
import { buildIndex, type LookupTable } from './schema';
import {
  TOP_GAP,
  topAlignScrollTop,
  resolveAnchor,
  recordPlace,
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

// --- recordPlace: the ancestor chain of "where we left off" -----------------

test('recordPlace leaving level 0 records BOTH the caret AND its section', () => {
  const index = buildIndex(table);
  const lastCaretIn = new Map<string, string>();
  const lastAnchorIn = new Map<string, string>();

  recordPlace(0, 'P1b', index, lastCaretIn, lastAnchorIn);

  expect(lastCaretIn.get('S1')).toBe('P1b');  // P within its S
  expect(lastAnchorIn.get('M1')).toBe('S1');  // ...and that S within its M
});

test('recordPlace leaving level −1 records only lastAnchorIn, preserving a deeper caret', () => {
  const index = buildIndex(table);
  const lastCaretIn = new Map<string, string>([['S1', 'P1b']]);
  const lastAnchorIn = new Map<string, string>();

  recordPlace(-1, 'S1', index, lastCaretIn, lastAnchorIn);

  expect(lastAnchorIn.get('M1')).toBe('S1');
  // The deeper memory must SURVIVE — it is what makes −2 → 0 land on P1b.
  expect(lastCaretIn.get('S1')).toBe('P1b');
});

test('recordPlace leaving level −2 is a no-op (nothing above meta)', () => {
  const index = buildIndex(table);
  const lastCaretIn = new Map<string, string>();
  const lastAnchorIn = new Map<string, string>();

  recordPlace(-2, 'M1', index, lastCaretIn, lastAnchorIn);

  expect(lastCaretIn.size).toBe(0);
  expect(lastAnchorIn.size).toBe(0);
});

test('round-trip 0 → −2 → 0 returns to the exact paragraph (two-hop memory)', () => {
  // The user-reported scenario: reading P7 in S4 / M3, zoom out to the story
  // level, zoom back to raw — and land on P7, not on the first paragraph.
  const t: LookupTable = {
    version: 1,
    docHash: 'b'.repeat(64),
    meta: { M3: { id: 'M3', level: -2, children: ['S3', 'S4', 'S5'], title: 'm3', body: 'b' } },
    sections: {
      S3: { id: 'S3', level: -1, parent: 'M3', children: ['P3'], title: 's3', body: 'b' },
      S4: { id: 'S4', level: -1, parent: 'M3', children: ['P6', 'P7', 'P8'], title: 's4', body: 'b' },
      S5: { id: 'S5', level: -1, parent: 'M3', children: ['P9'], title: 's5', body: 'b' },
    },
    paragraphs: Object.fromEntries(
      (['P3', 'P6', 'P7', 'P8', 'P9'] as const).map((id, i) => [
        id,
        { id, level: 0 as const, parent: id === 'P3' ? 'S3' : id === 'P9' ? 'S5' : 'S4',
          kind: 'prose' as const, span: { start: i, end: i + 1 }, html: '' },
      ]),
    ),
    order: {
      meta: ['M3'],
      sections: ['S3', 'S4', 'S5'],
      paragraphs: ['P3', 'P6', 'P7', 'P8', 'P9'],
    },
  };

  const ctx: MapCtx = {
    index: buildIndex(t),
    table: t,
    lastCaretIn: new Map(),
    lastAnchorIn: new Map(),
  };

  // Leaving raw text with the caret in P7 (0 → −2).
  recordPlace(0, 'P7', ctx.index, ctx.lastCaretIn, ctx.lastAnchorIn);
  expect(mapAcrossLevels(0, -2, 'P7', ctx)).toBe('M3');

  // ...and back in. Two hops: M3 → S4 (remembered) → P7 (remembered).
  // Without the lastAnchorIn link this would fall back to S3 → P3.
  expect(mapAcrossLevels(-2, 0, 'M3', ctx)).toBe('P7');
});

describe('resolveAnchor — topmost actually-visible node', () => {
  const boxes = [
    { id: 'P-a', offsetTop: 0, offsetHeight: 100 },
    { id: 'P-b', offsetTop: 100, offsetHeight: 200 },
    { id: 'P-c', offsetTop: 340, offsetHeight: 60 }, // 40px gap above
  ];
  test('node containing the top edge wins', () => {
    expect(resolveAnchor(boxes, 150)).toBe('P-b');
  });
  test('top edge exactly at a node boundary picks the node starting there', () => {
    expect(resolveAnchor(boxes, 100)).toBe('P-b');
  });
  test('top edge in a gap → first node starting below it', () => {
    expect(resolveAnchor(boxes, 310)).toBe('P-c'); // between b (ends 300) and c (starts 340)
  });
  test('node scrolled just past the top edge does NOT win by proximity', () => {
    // top edge at 301: P-b's bottom (300) is 1px above — closest, but gone.
    expect(resolveAnchor(boxes, 301)).toBe('P-c');
  });
  test('top edge below every node → bottommost node (over-scroll fallback)', () => {
    expect(resolveAnchor(boxes, 900)).toBe('P-c');
  });
  test('empty mounted list → null', () => {
    expect(resolveAnchor([], 0)).toBe(null);
  });
  test('zero-height boxes cannot contain the edge and are skipped as containers', () => {
    const withGhost = [{ id: 'ghost', offsetTop: 150, offsetHeight: 0 }, ...boxes];
    expect(resolveAnchor(withGhost, 150)).toBe('P-b');
  });
});

describe('topAlignScrollTop', () => {
  const vp = { clientHeight: 500, scrollHeight: 2000 };
  test('lands the node TOP_GAP below the top edge', () => {
    expect(topAlignScrollTop({ offsetTop: 800 }, vp)).toBe(800 - TOP_GAP);
  });
  test('clamps at 0 near the document start', () => {
    expect(topAlignScrollTop({ offsetTop: 10 }, vp)).toBe(0);
  });
  test('clamps at max scroll near the document end', () => {
    expect(topAlignScrollTop({ offsetTop: 1990 }, vp)).toBe(1500);
  });
  test('unscrollable document → 0', () => {
    expect(
      topAlignScrollTop({ offsetTop: 100 }, { clientHeight: 500, scrollHeight: 400 }),
    ).toBe(0);
  });
});
