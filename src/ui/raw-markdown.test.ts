import { test, expect } from 'vitest';
import { buildRawLevel } from './raw-markdown';

test('buildRawLevel wraps a .level-layer[data-level="0"] > .reading-column of .pnode blocks', () => {
  const layer = buildRawLevel('# Title\n\nSome **prose** here.\n');
  expect(layer.className).toBe('level-layer');
  expect(layer.dataset.level).toBe('0');
  const column = layer.querySelector('.reading-column');
  expect(column).toBeTruthy();
  const nodes = column!.querySelectorAll('.pnode');
  expect(nodes.length).toBe(2);
  expect(nodes[0].innerHTML).toContain('<h1>Title</h1>');
  expect(nodes[1].innerHTML).toContain('<strong>prose</strong>');
});

test('a code block is wrapped in .code-wrap like native k=0 paragraphs', () => {
  const layer = buildRawLevel('```js\nconst x = 1;\n```\n');
  const node = layer.querySelector('.pnode')!;
  expect(node.querySelector('.code-wrap')).toBeTruthy();
  expect(node.querySelector('pre code')?.textContent).toContain('const x = 1;');
});

test('a GFM table is wrapped in .table-scroll like native k=0 tables', () => {
  const raw = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const layer = buildRawLevel(raw);
  const node = layer.querySelector('.pnode')!;
  expect(node.querySelector('.table-scroll > table')).toBeTruthy();
  expect(node.querySelectorAll('td').length).toBe(2);
});

test('no data-pid is ever set — untagged docs have no LookupTable to key ids on (D6)', () => {
  const layer = buildRawLevel('# A\n\nB\n');
  for (const node of layer.querySelectorAll('.pnode')) {
    expect(node.getAttribute('data-pid')).toBeNull();
  }
});
