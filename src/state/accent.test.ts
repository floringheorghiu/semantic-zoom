import { beforeEach, describe, expect, it } from 'vitest';
import { getAccentPref, setAccentPref, initAccent } from './accent';

describe('accent', () => {
  beforeEach(() => { window.localStorage.clear(); document.documentElement.style.removeProperty('--sz-accent'); });

  it('defaults to #8080ff', () => { expect(getAccentPref()).toBe('#8080ff'); });

  it('persists and applies the property', () => {
    initAccent();
    setAccentPref('#ff6b35');
    expect(window.localStorage.getItem('sz-accent')).toBe('#ff6b35');
    expect(document.documentElement.style.getPropertyValue('--sz-accent')).toBe('#ff6b35');
  });

  it('rejects malformed stored values', () => {
    window.localStorage.setItem('sz-accent', 'javascript:alert(1)');
    expect(getAccentPref()).toBe('#8080ff');
  });
});
