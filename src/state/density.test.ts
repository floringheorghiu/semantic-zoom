import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDensityPref, setDensityPref, initDensity } from './density';

describe('density', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-density');
  });

  it('defaults to "default"', () => {
    expect(getDensityPref()).toBe('default');
  });

  it('persists and applies the attribute', () => {
    initDensity();
    setDensityPref('comfortable');
    expect(window.localStorage.getItem('sz-density')).toBe('comfortable');
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable');
  });

  it('clears the attribute when set back to default', () => {
    initDensity();
    setDensityPref('compact');
    expect(document.documentElement.hasAttribute('data-density')).toBe(true);
    setDensityPref('default');
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });

  it('rejects malformed stored values', () => {
    window.localStorage.setItem('sz-density', 'huge');
    expect(getDensityPref()).toBe('default');
  });

  it('notifies subscribers and reapplies on a cross-window storage event', () => {
    const listener = vi.fn();
    initDensity(listener);
    window.localStorage.setItem('sz-density', 'compact');
    window.dispatchEvent(new StorageEvent('storage', { key: 'sz-density', newValue: 'compact' }));
    expect(listener).toHaveBeenCalledWith('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });
});
