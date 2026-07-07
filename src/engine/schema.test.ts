import { test, expect } from 'vitest';
import { buildIndex, type LookupTable } from './schema';

export const sampleTable: LookupTable = {
  version: 1,
  docHash: 'a'.repeat(64),
  meta: { M1: { id: 'M1', level: -2, children: ['S-00000000-0'], title: 'm', body: 'b' } },
  sections: {
    'S-00000000-0': { id: 'S-00000000-0', level: -1, parent: 'M1',
      children: ['P-11111111-0', 'P-22222222-0'], title: 's', body: 'b' },
  },
  paragraphs: {
    'P-11111111-0': { id: 'P-11111111-0', level: 0, parent: 'S-00000000-0',
      kind: 'prose', span: { start: 0, end: 3 }, html: '<p>a</p>' },
    'P-22222222-0': { id: 'P-22222222-0', level: 0, parent: 'S-00000000-0',
      kind: 'code', span: { start: 3, end: 6 }, html: '<pre></pre>', lang: 'rs' },
  },
  order: { meta: ['M1'], sections: ['S-00000000-0'], paragraphs: ['P-11111111-0', 'P-22222222-0'] },
};

test('buildIndex resolves both directions and sibling groups', () => {
  const idx = buildIndex(sampleTable);
  expect(idx.parentOfParagraph.get('P-11111111-0')).toBe('S-00000000-0');
  expect(idx.parentOfSection.get('S-00000000-0')).toBe('M1');
  expect(idx.siblingGroup.get('P-11111111-0')).toEqual(['P-11111111-0', 'P-22222222-0']);
  expect(idx.siblingGroup.get('P-22222222-0')).toEqual(['P-11111111-0', 'P-22222222-0']);
});
