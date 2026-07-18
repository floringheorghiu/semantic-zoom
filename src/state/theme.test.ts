import { test, expect, vi, beforeEach } from 'vitest';
import {
  getThemePref,
  resolveTheme,
  applyTheme,
  setThemePref,
  initTheme,
} from './theme';

const STORAGE_KEY = 'sz.theme';
const root = document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  root.removeAttribute('data-theme');
  root.style.colorScheme = '';
});

test('resolveTheme: explicit prefs win, system follows the OS', () => {
  expect(resolveTheme('light', true)).toBe('light');
  expect(resolveTheme('dark', false)).toBe('dark');
  expect(resolveTheme('system', true)).toBe('dark');
  expect(resolveTheme('system', false)).toBe('light');
});

test('getThemePref defaults to system on absent or malformed storage', () => {
  expect(getThemePref()).toBe('system');
  window.localStorage.setItem(STORAGE_KEY, 'sepia');
  expect(getThemePref()).toBe('system');
});

test('setThemePref persists and stamps data-theme + color-scheme', () => {
  setThemePref('dark');
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
  expect(root.getAttribute('data-theme')).toBe('dark');
  expect(root.style.colorScheme).toBe('dark');

  setThemePref('light');
  expect(root.hasAttribute('data-theme')).toBe(false);
  expect(root.style.colorScheme).toBe('light');
});

test('applyTheme(system) without matchMedia support resolves light', () => {
  // jsdom has no matchMedia — the guard must fall back to light, not throw.
  applyTheme('system');
  expect(root.hasAttribute('data-theme')).toBe(false);
  expect(root.style.colorScheme).toBe('light');
});

test('initTheme applies the saved pref immediately', () => {
  window.localStorage.setItem(STORAGE_KEY, 'dark');
  const teardown = initTheme();
  expect(root.getAttribute('data-theme')).toBe('dark');
  teardown();
});

test('a storage event from another window re-applies and notifies', () => {
  const onPrefChange = vi.fn();
  const teardown = initTheme(onPrefChange);

  window.localStorage.setItem(STORAGE_KEY, 'dark');
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'dark' }));

  expect(root.getAttribute('data-theme')).toBe('dark');
  expect(onPrefChange).toHaveBeenCalledWith('dark');
  teardown();
});

test('storage events for other keys are ignored', () => {
  const onPrefChange = vi.fn();
  const teardown = initTheme(onPrefChange);
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'x' }));
  expect(onPrefChange).not.toHaveBeenCalled();
  teardown();
});

test('teardown detaches the listener registered by initTheme', () => {
  const onPrefChange = vi.fn();
  const teardown = initTheme(onPrefChange);
  teardown();
  setThemePref('dark');
  expect(onPrefChange).not.toHaveBeenCalled();
});
