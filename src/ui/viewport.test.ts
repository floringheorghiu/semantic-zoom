import { test, expect } from 'vitest';
import { renderLevel } from './viewport';
import { buildIndex } from '../engine/schema';
import { sampleTable } from '../engine/schema.test';

test('renderLevel(0) wraps each section in a .pgroup with data-sid and .pnode children', () => {
  const root = document.createElement('main');
  renderLevel(root, sampleTable, buildIndex(sampleTable), 0);
  const groups = root.querySelectorAll('.pgroup');
  expect(groups.length).toBe(1);
  expect(groups[0].getAttribute('data-sid')).toBe('S-00000000-0');
  const nodes = groups[0].querySelectorAll('.pnode');
  expect(nodes.length).toBe(2);
  expect(nodes[0].getAttribute('data-pid')).toBe('P-11111111-0');
  expect(nodes[0].getAttribute('data-kind')).toBe('prose');
});

test('renderLevel(-1) renders section titles; (-2) renders meta titles', () => {
  const root = document.createElement('main');
  renderLevel(root, sampleTable, buildIndex(sampleTable), -1);
  expect(root.textContent).toContain('s');
  renderLevel(root, sampleTable, buildIndex(sampleTable), -2);
  expect(root.textContent).toContain('m');
});
