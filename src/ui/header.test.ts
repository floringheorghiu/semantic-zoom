import { test, expect } from 'vitest';
import { docTitle, titlePid, levelSubtitle, buildHeader } from './header';
import type { LookupTable, ParagraphNode, ZoomLevel } from '../engine/schema';

/**
 * Build a minimal table with known counts. `paragraphs` is a list of
 * `[pid, kind, html]` tuples; `sectionCount`/`metaCount` seed the order arrays
 * used only for counting (the nodes themselves aren't exercised here).
 */
function makeTable(
  paragraphs: Array<[string, ParagraphNode['kind'], string]>,
  sectionCount: number,
  metaCount: number,
): LookupTable {
  const paraRec: Record<string, ParagraphNode> = {};
  const orderParagraphs: string[] = [];
  for (const [pid, kind, html] of paragraphs) {
    orderParagraphs.push(pid);
    paraRec[pid] = { id: pid, level: 0, parent: 'S-0', kind, span: { start: 0, end: 0 }, html };
  }
  const orderSections = Array.from({ length: sectionCount }, (_, i) => `S-${i}`);
  const orderMeta = Array.from({ length: metaCount }, (_, i) => `M${i + 1}`);
  return {
    version: 1,
    docHash: 'x'.repeat(64),
    meta: {},
    sections: {},
    paragraphs: paraRec,
    order: { meta: orderMeta, sections: orderSections, paragraphs: orderParagraphs },
  };
}

test('docTitle extracts plain text from the first heading paragraph html', () => {
  const table = makeTable(
    [
      ['P-a-0', 'prose', '<p>intro</p>'],
      ['P-b-0', 'heading', '<h1>Semantic Zoom — Phase 1</h1>'],
      ['P-c-0', 'heading', '<h2>Later heading</h2>'],
    ],
    0,
    0,
  );
  expect(docTitle(table)).toBe('Semantic Zoom — Phase 1');
});

test('docTitle falls back to "Semantic Zoom" when there is no heading', () => {
  const table = makeTable([['P-a-0', 'prose', '<p>no heading here</p>']], 0, 0);
  expect(docTitle(table)).toBe('Semantic Zoom');
});

test('titlePid returns the first heading pid, or null', () => {
  const withHeading = makeTable(
    [
      ['P-a-0', 'prose', '<p>intro</p>'],
      ['P-b-0', 'heading', '<h1>Title</h1>'],
    ],
    0,
    0,
  );
  expect(titlePid(withHeading)).toBe('P-b-0');

  const withoutHeading = makeTable([['P-a-0', 'prose', '<p>intro</p>']], 0, 0);
  expect(titlePid(withoutHeading)).toBeNull();
});

test('levelSubtitle formats counts per level (plural)', () => {
  const table = makeTable(
    [
      ['P-a-0', 'heading', '<h1>T</h1>'],
      ['P-b-0', 'prose', '<p>x</p>'],
      ['P-c-0', 'prose', '<p>y</p>'],
    ],
    5,
    2,
  );
  expect(levelSubtitle(0 as ZoomLevel, table)).toBe('Detail view · 3 paragraphs');
  expect(levelSubtitle(-1 as ZoomLevel, table)).toBe(
    'Plain-English walkthrough · 5 sections across 2 milestones',
  );
  expect(levelSubtitle(-2 as ZoomLevel, table)).toBe(
    'Executive milestone view · 2 milestones · 5 sections',
  );
});

test('levelSubtitle uses singular for a count of one', () => {
  const table = makeTable([['P-a-0', 'prose', '<p>x</p>']], 1, 1);
  expect(levelSubtitle(0 as ZoomLevel, table)).toBe('Detail view · 1 paragraph');
  expect(levelSubtitle(-1 as ZoomLevel, table)).toBe(
    'Plain-English walkthrough · 1 section across 1 milestone',
  );
  expect(levelSubtitle(-2 as ZoomLevel, table)).toBe(
    'Executive milestone view · 1 milestone · 1 section',
  );
});

test('buildHeader renders .doc-header > .doc-title + .doc-subtitle', () => {
  const table = makeTable(
    [['P-a-0', 'heading', '<h1>My Doc</h1>']],
    3,
    1,
  );
  const header = buildHeader(table, -2 as ZoomLevel);
  expect(header.tagName).toBe('HEADER');
  expect(header.classList.contains('doc-header')).toBe(true);
  const title = header.querySelector('.doc-title');
  const subtitle = header.querySelector('.doc-subtitle');
  expect(title?.tagName).toBe('H1');
  expect(title?.textContent).toBe('My Doc');
  expect(subtitle?.tagName).toBe('P');
  expect(subtitle?.textContent).toBe('Executive milestone view · 1 milestone · 3 sections');
});
