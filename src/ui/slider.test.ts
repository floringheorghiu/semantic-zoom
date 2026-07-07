import { test, expect, vi } from 'vitest';
import { mountSlider } from './slider';

test('slider emits ZoomLevel on detent change and disables levels', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountSlider(el, { onChange, disabledLevels: [-1, -2] });
  const detents = el.querySelectorAll('[data-detent]');
  expect(detents.length).toBe(3);
  expect(el.querySelector('[data-detent="-1"]')?.hasAttribute('data-disabled')).toBe(true);
  (el.querySelector('[data-detent="0"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledWith(0);
  (el.querySelector('[data-detent="-1"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledTimes(1);
  teardown();
});
