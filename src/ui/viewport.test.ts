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

// --- code blocks: fixed-height peek + expand toggle -------------------------

test('a code paragraph\'s <pre> is wrapped in .code-wrap with a collapsed expand toggle', () => {
  const root = document.createElement('main');
  renderLevel(root, sampleTable, buildIndex(sampleTable), 0);

  const codeNode = root.querySelector('.pnode[data-kind="code"]')!;
  const wrap = codeNode.querySelector('.code-wrap')!;
  expect(wrap).toBeTruthy();
  expect(wrap.querySelector('pre')).toBeTruthy();
  expect(wrap.hasAttribute('data-expanded')).toBe(false);

  const toggle = wrap.querySelector<HTMLButtonElement>('.code-expand-toggle')!;
  expect(toggle.type).toBe('button');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

test('clicking the toggle expands the code block, and again collapses it', () => {
  const root = document.createElement('main');
  renderLevel(root, sampleTable, buildIndex(sampleTable), 0);

  const wrap = root.querySelector('.code-wrap')!;
  const toggle = wrap.querySelector<HTMLButtonElement>('.code-expand-toggle')!;

  toggle.click();
  expect(wrap.hasAttribute('data-expanded')).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');

  toggle.click();
  expect(wrap.hasAttribute('data-expanded')).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

test('a prose paragraph (no <pre>) gets no .code-wrap', () => {
  const root = document.createElement('main');
  renderLevel(root, sampleTable, buildIndex(sampleTable), 0);
  const proseNode = root.querySelector('.pnode[data-kind="prose"]')!;
  expect(proseNode.querySelector('.code-wrap')).toBeNull();
});
