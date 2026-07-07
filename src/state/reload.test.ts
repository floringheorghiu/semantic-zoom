import { test, expect } from 'vitest';
import { restoreCaret } from './reload';
import type { LookupTable, ParagraphNode, SectionNode } from '../engine/schema';

// --- Tiny table builder -----------------------------------------------------
// Each section is [sid, [pid...]]; order.paragraphs is the flat concatenation
// in the order given (which the (b) sibling-context / ratio logic reads).
function makeTable(sections: Array<[string, string[]]>): LookupTable {
  const paragraphs: Record<string, ParagraphNode> = {};
  const sectionRec: Record<string, SectionNode> = {};
  const orderSections: string[] = [];
  const orderParagraphs: string[] = [];
  for (const [sid, children] of sections) {
    orderSections.push(sid);
    sectionRec[sid] = { id: sid, level: -1, parent: 'M1', children: [...children], title: sid, body: '' };
    for (const pid of children) {
      orderParagraphs.push(pid);
      paragraphs[pid] = {
        id: pid, level: 0, parent: sid, kind: 'prose', span: { start: 0, end: 0 }, html: '',
      };
    }
  }
  return {
    version: 1,
    docHash: 'x'.repeat(64),
    meta: { M1: { id: 'M1', level: -2, children: orderSections, title: 'm', body: '' } },
    sections: sectionRec,
    paragraphs,
    order: { meta: ['M1'], sections: orderSections, paragraphs: orderParagraphs },
  };
}

test('null old caret → null', () => {
  const t = makeTable([['S-s1-0', ['P-aa-0']]]);
  expect(restoreCaret({ paragraphId: null, offset: 0 }, t, t)).toBeNull();
});

test('(a) exact old id present → kept with its offset', () => {
  const oldT = makeTable([['S-s1-0', ['P-aa-0', 'P-bb-0']]]);
  const newT = makeTable([['S-s1-0', ['P-zz-0', 'P-aa-0', 'P-bb-0']]]);
  expect(restoreCaret({ paragraphId: 'P-aa-0', offset: 5 }, oldT, newT)).toEqual({
    paragraphId: 'P-aa-0',
    offset: 5,
  });
});

test('(b) duplicate-hash: sibling-context winner', () => {
  // Old: three "dd" occurrences; caret on P-dd-2 whose neighbors are x2 / x3.
  const oldT = makeTable([
    ['S-s1-0', ['P-y0-0', 'P-dd-0', 'P-y1-0', 'P-dd-1', 'P-x2-0', 'P-dd-2', 'P-x3-0']],
  ]);
  // New: only two "dd" occurrences remain (P-dd-2 removed → exact id gone).
  // P-dd-1's neighbors are x2 / x3 → it matches the old neighbors' hashes.
  const newT = makeTable([
    ['S-s1-0', ['P-y0-0', 'P-dd-0', 'P-y1-0', 'P-x2-0', 'P-dd-1', 'P-x3-0']],
  ]);
  expect(restoreCaret({ paragraphId: 'P-dd-2', offset: 7 }, oldT, newT)).toEqual({
    paragraphId: 'P-dd-1',
    offset: 7,
  });
});

test('(b) duplicate-hash: ratio fallback when context ambiguous', () => {
  // Old: caret on P-dd-2 (index 4 of 5 → ratio 0.8). Neighbors bb / (none).
  const oldT = makeTable([
    ['S-s1-0', ['P-dd-0', 'P-aa-0', 'P-dd-1', 'P-bb-0', 'P-dd-2']],
  ]);
  // New: two "dd" candidates, NEITHER shares the old neighbor hashes → context
  // ties at 0; ratio decides. P-dd-1 (idx 2/6 = 0.333) is nearer 0.8 than
  // P-dd-0 (idx 0/6 = 0).
  const newT = makeTable([
    ['S-s1-0', ['P-dd-0', 'P-cc-0', 'P-dd-1', 'P-ee-0', 'P-ff-0', 'P-gg-0']],
  ]);
  expect(restoreCaret({ paragraphId: 'P-dd-2', offset: 2 }, oldT, newT)).toEqual({
    paragraphId: 'P-dd-1',
    offset: 2,
  });
});

test('(c) hash gone → parent section first surviving child', () => {
  const oldT = makeTable([['S-s1-0', ['P-aa-0', 'P-bb-0', 'P-cc-0']]]);
  // "bb" is gone entirely; first surviving child in section order is P-aa-0.
  const newT = makeTable([['S-s1-0', ['P-aa-0', 'P-cc-0']]]);
  const r = restoreCaret({ paragraphId: 'P-bb-0', offset: 3 }, oldT, newT);
  expect(r?.paragraphId).toBe('P-aa-0');
});

test('(c) hash gone AND section gone → null', () => {
  const oldT = makeTable([['S-s1-0', ['P-bb-0', 'P-cc-0']]]);
  // None of the section's children survive.
  const newT = makeTable([['S-s2-0', ['P-zz-0']]]);
  expect(restoreCaret({ paragraphId: 'P-bb-0', offset: 1 }, oldT, newT)).toBeNull();
});
