import { beforeEach, describe, expect, it } from 'vitest';
import { getShowAnchors, setShowAnchors, initAnchorVisibility } from './anchor-visibility';

describe('anchor-visibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-hide-anchors');
  });

  it('defaults to true', () => {
    expect(getShowAnchors()).toBe(true);
  });

  it('persists and stamps data-hide-anchors when set to false', () => {
    initAnchorVisibility();
    setShowAnchors(false);
    expect(window.localStorage.getItem('sz-show-anchors')).toBe('false');
    expect(document.documentElement.hasAttribute('data-hide-anchors')).toBe(true);
  });

  it('falls back to true on malformed stored values', () => {
    window.localStorage.setItem('sz-show-anchors', 'nonsense');
    expect(getShowAnchors()).toBe(true);
  });
});
