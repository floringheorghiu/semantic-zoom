import { test, expect, vi } from 'vitest';
import { mountZoomScrubber } from './zoom-scrubber';

test('renders three ⌘-labelled segments in zoom-out order ⌘1 ⌘2 ⌘3', () => {
  const el = document.createElement('div');
  const teardown = mountZoomScrubber(el, { onChange: vi.fn() });
  const segs = el.querySelectorAll('[data-detent]');
  expect([...segs].map((s) => s.getAttribute('data-detent'))).toEqual(['1', '2', '3']);
  expect([...segs].map((s) => s.textContent)).toEqual(['⌘1', '⌘2', '⌘3']);
  teardown();
});

test('+ is the FIRST control (toward ⌘1) and − the LAST (toward ⌘3)', () => {
  const el = document.createElement('div');
  const teardown = mountZoomScrubber(el, { onChange: vi.fn(), active: -1 });
  expect((el.firstElementChild as HTMLElement).dataset.step).toBe('plus');
  expect((el.lastElementChild as HTMLElement).dataset.step).toBe('minus');
  teardown();
});

test('disabledLevels disables the matching segments', () => {
  const el = document.createElement('div');
  const teardown = mountZoomScrubber(el, { onChange: vi.fn(), disabledLevels: [-1, -2] });
  expect(el.querySelector('[data-detent="2"]')?.hasAttribute('data-disabled')).toBe(true);
  expect(el.querySelector('[data-detent="3"]')?.hasAttribute('data-disabled')).toBe(true);
  expect(el.querySelector('[data-detent="1"]')?.hasAttribute('data-disabled')).toBe(false);
  teardown();
});

test('clicking an enabled segment fires onChange with its semantic level', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, { onChange, active: 0 });
  (el.querySelector('[data-detent="3"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledWith(-2);
  (el.querySelector('[data-detent="2"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledWith(-1);
  teardown();
});

test('a disabled segment fires nothing when clicked', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, { onChange, disabledLevels: [-2], active: 0 });
  (el.querySelector('[data-detent="3"]') as HTMLElement).click();
  expect(onChange).not.toHaveBeenCalled();
  teardown();
});

test('active marks data-active on the current segment', () => {
  const el = document.createElement('div');
  const teardown = mountZoomScrubber(el, { onChange: vi.fn(), active: -1 });
  expect(el.querySelector('[data-detent="2"]')?.hasAttribute('data-active')).toBe(true);
  expect(el.querySelector('[data-detent="1"]')?.hasAttribute('data-active')).toBe(false);
  teardown();
});

test('+ steps toward full text (0), − steps toward story (−2)', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, { onChange, active: -1 });
  (el.querySelector('[data-step="plus"]') as HTMLElement).click();
  expect(onChange).toHaveBeenLastCalledWith(0);
  (el.querySelector('[data-step="minus"]') as HTMLElement).click();
  expect(onChange).toHaveBeenLastCalledWith(-2);
  teardown();
});

test('+ is disabled at 0 and − is disabled at −2', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, { onChange, active: 0 });
  const plus = el.querySelector('[data-step="plus"]') as HTMLButtonElement;
  expect(plus.hasAttribute('data-disabled')).toBe(true);
  plus.click();
  expect(onChange).not.toHaveBeenCalled();
  teardown();

  const el2 = document.createElement('div');
  const onChange2 = vi.fn();
  const teardown2 = mountZoomScrubber(el2, { onChange: onChange2, active: -2 });
  const minus = el2.querySelector('[data-step="minus"]') as HTMLButtonElement;
  expect(minus.hasAttribute('data-disabled')).toBe(true);
  minus.click();
  expect(onChange2).not.toHaveBeenCalled();
  teardown2();
});

test('on untagged docs only ⌘1 is enabled; −/+ are disabled', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, {
    onChange,
    disabledLevels: [-1, -2],
    active: 0,
  });
  expect((el.querySelector('[data-step="minus"]') as HTMLButtonElement).disabled).toBe(true);
  expect((el.querySelector('[data-step="plus"]') as HTMLButtonElement).disabled).toBe(true);
  teardown();
});

test('teardown removes listeners', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, { onChange, active: 0 });
  const seg = el.querySelector('[data-detent="3"]') as HTMLElement;
  teardown();
  seg.click();
  expect(onChange).not.toHaveBeenCalled();
  expect(el.children.length).toBe(0);
});
