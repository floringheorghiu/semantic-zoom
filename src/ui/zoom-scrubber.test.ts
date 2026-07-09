import { test, expect, vi } from 'vitest';
import { mountZoomScrubber } from './zoom-scrubber';

test('renders five segments; +1/+2 are always disabled', () => {
  const el = document.createElement('div');
  const teardown = mountZoomScrubber(el, { onChange: vi.fn() });
  const segs = el.querySelectorAll('[data-detent]');
  expect([...segs].map((s) => s.getAttribute('data-detent'))).toEqual([
    '-2',
    '-1',
    '0',
    '+1',
    '+2',
  ]);
  expect(el.querySelector('[data-detent="+1"]')?.hasAttribute('data-disabled')).toBe(true);
  expect(el.querySelector('[data-detent="+2"]')?.hasAttribute('data-disabled')).toBe(true);
  teardown();
});

test('disabledLevels also disables the given semantic levels', () => {
  const el = document.createElement('div');
  const teardown = mountZoomScrubber(el, { onChange: vi.fn(), disabledLevels: [-1, -2] });
  expect(el.querySelector('[data-detent="-1"]')?.hasAttribute('data-disabled')).toBe(true);
  expect(el.querySelector('[data-detent="-2"]')?.hasAttribute('data-disabled')).toBe(true);
  expect(el.querySelector('[data-detent="0"]')?.hasAttribute('data-disabled')).toBe(false);
  teardown();
});

test('clicking an enabled segment fires onChange(level); disabled fires nothing', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, { onChange, active: 0 });
  (el.querySelector('[data-detent="-2"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledWith(-2);
  (el.querySelector('[data-detent="+1"]') as HTMLElement).click();
  (el.querySelector('[data-detent="+2"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledTimes(1);
  teardown();
});

test('active marks data-active on the current segment', () => {
  const el = document.createElement('div');
  const teardown = mountZoomScrubber(el, { onChange: vi.fn(), active: -1 });
  expect(el.querySelector('[data-detent="-1"]')?.hasAttribute('data-active')).toBe(true);
  expect(el.querySelector('[data-detent="0"]')?.hasAttribute('data-active')).toBe(false);
  teardown();
});

test('− / + end buttons step within the enabled range and fire onChange', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountZoomScrubber(el, { onChange, active: -1 });
  (el.querySelector('[data-step="minus"]') as HTMLElement).click(); // toward −2
  expect(onChange).toHaveBeenLastCalledWith(-2);
  (el.querySelector('[data-step="plus"]') as HTMLElement).click(); // toward 0
  expect(onChange).toHaveBeenLastCalledWith(0);
  teardown();
});

test('+ stops at 0 (never into +1/+2) and − stops at −2', () => {
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

test('on untagged docs only level 0 is enabled; −/+ are disabled', () => {
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
  const seg = el.querySelector('[data-detent="-2"]') as HTMLElement;
  teardown();
  seg.click();
  expect(onChange).not.toHaveBeenCalled();
  expect(el.children.length).toBe(0);
});
