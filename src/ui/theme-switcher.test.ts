import { test, expect, vi } from 'vitest';
import { mountThemeSwitcher } from './theme-switcher';

test('renders three radio segments — light, dark, system — in order', () => {
  const root = document.createElement('div');
  mountThemeSwitcher(root, { value: 'system', onChange: () => {} });

  const radios = root.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  expect(radios).toHaveLength(3);
  expect(radios[0].getAttribute('aria-label')).toBe('Light theme');
  expect(radios[1].getAttribute('aria-label')).toBe('Dark theme');
  expect(radios[2].getAttribute('aria-label')).toBe('Follow system theme');
});

test('the mounted value is the checked segment', () => {
  const root = document.createElement('div');
  mountThemeSwitcher(root, { value: 'dark', onChange: () => {} });

  const radios = root.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  expect(radios[1].getAttribute('aria-checked')).toBe('true');
  expect(radios[0].getAttribute('aria-checked')).toBe('false');
  expect(radios[2].getAttribute('aria-checked')).toBe('false');
});

test('clicking a segment fires onChange and moves the check', () => {
  const root = document.createElement('div');
  const onChange = vi.fn();
  mountThemeSwitcher(root, { value: 'system', onChange });

  const radios = root.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios[0].click();
  expect(onChange).toHaveBeenCalledExactlyOnceWith('light');
  expect(radios[0].getAttribute('aria-checked')).toBe('true');
  expect(radios[2].getAttribute('aria-checked')).toBe('false');
});

test('re-clicking the active segment is a no-op', () => {
  const root = document.createElement('div');
  const onChange = vi.fn();
  mountThemeSwitcher(root, { value: 'dark', onChange });

  root.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click();
  expect(onChange).not.toHaveBeenCalled();
});

test('setValue reflects an external change without firing onChange', () => {
  const root = document.createElement('div');
  const onChange = vi.fn();
  const handle = mountThemeSwitcher(root, { value: 'system', onChange });

  handle.setValue('light');
  const radios = root.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  expect(radios[0].getAttribute('aria-checked')).toBe('true');
  expect(onChange).not.toHaveBeenCalled();
});

test('teardown removes the control from the DOM', () => {
  const root = document.createElement('div');
  const handle = mountThemeSwitcher(root, { value: 'system', onChange: () => {} });
  handle.teardown();
  expect(root.querySelector('.theme-switcher')).toBeNull();
});
