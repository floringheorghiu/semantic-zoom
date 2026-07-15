import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountGenerateAffordance } from './generate-affordance';

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'generate-affordance';
  btn.hidden = true;
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('starts hidden, idle, and renders the idle icon markup', () => {
  const btn = makeButton();
  const handle = mountGenerateAffordance(btn, { onGenerate: vi.fn(), onCancel: vi.fn() });
  expect(btn.hidden).toBe(true);
  expect(btn.dataset.state).toBe('idle');
  expect(btn.querySelector('.ga-icon--idle svg')).not.toBeNull();
  handle.teardown();
});

test('setVisible toggles the hidden attribute', () => {
  const btn = makeButton();
  const handle = mountGenerateAffordance(btn, { onGenerate: vi.fn(), onCancel: vi.fn() });
  handle.setVisible(true);
  expect(btn.hidden).toBe(false);
  handle.setVisible(false);
  expect(btn.hidden).toBe(true);
  handle.teardown();
});

test('clicking while idle fires onGenerate, not onCancel', () => {
  const btn = makeButton();
  const onGenerate = vi.fn();
  const onCancel = vi.fn();
  const handle = mountGenerateAffordance(btn, { onGenerate, onCancel });
  btn.click();
  expect(onGenerate).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
  handle.teardown();
});

test('setState("loading") switches to the animated icon and starts frame alternation', () => {
  const btn = makeButton();
  const handle = mountGenerateAffordance(btn, { onGenerate: vi.fn(), onCancel: vi.fn() });
  handle.setState('loading');
  expect(btn.dataset.state).toBe('loading');
  expect(btn.dataset.frame).toBe('1');

  vi.advanceTimersByTime(500);
  expect(btn.dataset.frame).toBe('2');
  vi.advanceTimersByTime(500);
  expect(btn.dataset.frame).toBe('1');

  handle.teardown();
});

test('clicking while loading fires onCancel, not onGenerate', () => {
  const btn = makeButton();
  const onGenerate = vi.fn();
  const onCancel = vi.fn();
  const handle = mountGenerateAffordance(btn, { onGenerate, onCancel });
  handle.setState('loading');
  btn.click();
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onGenerate).not.toHaveBeenCalled();
  handle.teardown();
});

test('setState("idle") stops the frame timer and resets to frame 1', () => {
  const btn = makeButton();
  const handle = mountGenerateAffordance(btn, { onGenerate: vi.fn(), onCancel: vi.fn() });
  handle.setState('loading');
  vi.advanceTimersByTime(500);
  expect(btn.dataset.frame).toBe('2');

  handle.setState('idle');
  expect(btn.dataset.state).toBe('idle');
  expect(btn.dataset.frame).toBe('1');

  // No further frame flips once idle — the timer must actually be cleared.
  vi.advanceTimersByTime(2000);
  expect(btn.dataset.frame).toBe('1');

  handle.teardown();
});

test('setVisible(false) stops a live animation even without an explicit setState("idle")', () => {
  const btn = makeButton();
  const handle = mountGenerateAffordance(btn, { onGenerate: vi.fn(), onCancel: vi.fn() });
  handle.setVisible(true);
  handle.setState('loading');
  handle.setVisible(false);
  expect(btn.dataset.state).toBe('idle');

  vi.advanceTimersByTime(2000);
  expect(btn.dataset.frame).toBe('1'); // never advanced — timer was cleared

  handle.teardown();
});

test('setTooltip updates title and aria-label with the trust-boundary text', () => {
  const btn = makeButton();
  const handle = mountGenerateAffordance(btn, { onGenerate: vi.fn(), onCancel: vi.fn() });
  handle.setTooltip('Runs locally — nothing leaves your Mac.');
  expect(btn.title).toBe('Runs locally — nothing leaves your Mac.');
  expect(btn.getAttribute('aria-label')).toContain('nothing leaves your Mac');
  handle.teardown();
});

test('teardown removes the listener, clears content, and stops any running timer', () => {
  const btn = makeButton();
  const onGenerate = vi.fn();
  const handle = mountGenerateAffordance(btn, { onGenerate, onCancel: vi.fn() });
  handle.setState('loading');
  handle.teardown();
  btn.click();
  expect(onGenerate).not.toHaveBeenCalled();
  expect(btn.innerHTML).toBe('');
});
