import { beforeEach, describe, expect, it } from 'vitest';
import { getThemePref } from '../../state/theme';
import { getShowAnchors } from '../../state/anchor-visibility';
import { initGeneralTab } from './general-tab';

function mountGeneral(): void {
  document.body.innerHTML = `
    <div class="row" id="accent-swatches"></div>
    <fieldset id="theme-group">
      <label><input type="radio" name="theme" value="light" /> Light</label>
      <label><input type="radio" name="theme" value="dark" /> Dark</label>
      <label><input type="radio" name="theme" value="system" /> System</label>
    </fieldset>
    <label><input type="checkbox" id="show-anchors" /> Show anchor IDs</label>`;
}

describe('general tab theme radios', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-hide-anchors');
    mountGeneral();
  });
  it('reflects and writes the theme pref', () => {
    initGeneralTab();
    const system = document.querySelector<HTMLInputElement>('input[name="theme"][value="system"]')!;
    expect(system.checked).toBe(true); // default pref
    const dark = document.querySelector<HTMLInputElement>('input[name="theme"][value="dark"]')!;
    dark.click();
    expect(getThemePref()).toBe('dark');
  });

  it('reflects an external pref change via the returned callback', () => {
    const { reflectTheme } = initGeneralTab();
    const light = document.querySelector<HTMLInputElement>('input[name="theme"][value="light"]')!;
    const dark = document.querySelector<HTMLInputElement>('input[name="theme"][value="dark"]')!;
    const system = document.querySelector<HTMLInputElement>('input[name="theme"][value="system"]')!;

    reflectTheme('dark');

    expect(dark.checked).toBe(true);
    expect(light.checked).toBe(false);
    expect(system.checked).toBe(false);
  });

  it('reflects an external accent change via the returned callback', () => {
    const { reflectAccent } = initGeneralTab();
    const swatch = document.querySelector<HTMLButtonElement>('#accent-swatches button[aria-label="#ff6b35"]')!;
    expect(swatch.hasAttribute('data-active')).toBe(false);

    reflectAccent('#ff6b35');

    expect(swatch.hasAttribute('data-active')).toBe(true);
  });

  it('reflects and writes the show-anchors pref', () => {
    initGeneralTab();
    const checkbox = document.getElementById('show-anchors') as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // default pref

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(getShowAnchors()).toBe(false);
  });
});
