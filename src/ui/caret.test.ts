import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextParagraph, mountCaret } from './caret';

// --- nextParagraph (pure, synchronous) --------------------------------------

test('nextParagraph moves forward and back in document order', () => {
  expect(nextParagraph(['a', 'b', 'c'], 'a', 1)).toBe('b');
  expect(nextParagraph(['a', 'b', 'c'], 'b', 1)).toBe('c');
  expect(nextParagraph(['a', 'b', 'c'], 'b', -1)).toBe('a');
});

test('nextParagraph clamps at both ends', () => {
  expect(nextParagraph(['a', 'b', 'c'], 'c', 1)).toBe('c'); // clamp at last
  expect(nextParagraph(['a', 'b', 'c'], 'a', -1)).toBe('a'); // clamp at first
});

test('nextParagraph handles null current', () => {
  expect(nextParagraph(['a', 'b', 'c'], null, 1)).toBe('a'); // first
  expect(nextParagraph(['a', 'b', 'c'], null, -1)).toBe('c'); // last
});

test('nextParagraph handles current not in list (treats as null)', () => {
  expect(nextParagraph(['a', 'b', 'c'], 'zzz', 1)).toBe('a');
  expect(nextParagraph(['a', 'b', 'c'], 'zzz', -1)).toBe('c');
});

test('nextParagraph handles empty pids', () => {
  expect(nextParagraph([], 'a', 1)).toBe('a');
  expect(nextParagraph([], null, 1)).toBe('');
});

// --- mountCaret (DOM + throttled dispatch) ----------------------------------

function makeViewport(): HTMLElement {
  const vp = document.createElement('main');
  for (const pid of ['P-11111111-0', 'P-22222222-0']) {
    const node = document.createElement('div');
    node.className = 'pnode';
    node.dataset.pid = pid;
    node.textContent = pid;
    vp.appendChild(node);
  }
  document.body.appendChild(vp);
  return vp;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('click on a .pnode dispatches CARET_PLACED with its pid and marks data-caret', () => {
  const vp = makeViewport();
  const dispatch = vi.fn();
  const teardown = mountCaret(vp, dispatch);

  const first = vp.querySelector<HTMLElement>('[data-pid="P-11111111-0"]')!;
  first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  vi.advanceTimersByTime(20); // flush auditTime(16)

  expect(dispatch).toHaveBeenCalledWith('P-11111111-0', 0);
  expect(first.hasAttribute('data-caret')).toBe(true);

  teardown();
});

test('click within a child of a .pnode resolves the nearest ancestor .pnode', () => {
  const vp = makeViewport();
  const dispatch = vi.fn();
  const teardown = mountCaret(vp, dispatch);

  const node = vp.querySelector<HTMLElement>('[data-pid="P-22222222-0"]')!;
  const child = document.createElement('span');
  node.appendChild(child);
  child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  vi.advanceTimersByTime(20);

  expect(dispatch).toHaveBeenCalledWith('P-22222222-0', 0);

  teardown();
});

test('ArrowDown advances the caret to the next .pnode', () => {
  const vp = makeViewport();
  const dispatch = vi.fn();
  const teardown = mountCaret(vp, dispatch);

  // place caret on first
  vp.querySelector<HTMLElement>('[data-pid="P-11111111-0"]')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  vi.advanceTimersByTime(20);
  dispatch.mockClear();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  vi.advanceTimersByTime(20);

  expect(dispatch).toHaveBeenLastCalledWith('P-22222222-0', 0);
  expect(vp.querySelector('[data-pid="P-22222222-0"]')!.hasAttribute('data-caret')).toBe(true);
  expect(vp.querySelector('[data-pid="P-11111111-0"]')!.hasAttribute('data-caret')).toBe(false);

  teardown();
});

test('ArrowUp moves the caret to the previous .pnode', () => {
  const vp = makeViewport();
  const dispatch = vi.fn();
  const teardown = mountCaret(vp, dispatch);

  vp.querySelector<HTMLElement>('[data-pid="P-22222222-0"]')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  vi.advanceTimersByTime(20);
  dispatch.mockClear();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
  vi.advanceTimersByTime(20);

  expect(dispatch).toHaveBeenLastCalledWith('P-11111111-0', 0);

  teardown();
});

test('teardown removes listeners so later events do not dispatch', () => {
  const vp = makeViewport();
  const dispatch = vi.fn();
  const teardown = mountCaret(vp, dispatch);
  teardown();

  vp.querySelector<HTMLElement>('[data-pid="P-11111111-0"]')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  vi.advanceTimersByTime(50);

  expect(dispatch).not.toHaveBeenCalled();
});
