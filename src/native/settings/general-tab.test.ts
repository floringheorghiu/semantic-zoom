import { beforeEach, describe, expect, it } from 'vitest';
import { getThemePref } from '../../state/theme';
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
  beforeEach(() => { window.localStorage.clear(); mountGeneral(); });
  it('reflects and writes the theme pref', () => {
    initGeneralTab();
    const system = document.querySelector<HTMLInputElement>('input[name="theme"][value="system"]')!;
    expect(system.checked).toBe(true); // default pref
    const dark = document.querySelector<HTMLInputElement>('input[name="theme"][value="dark"]')!;
    dark.click();
    expect(getThemePref()).toBe('dark');
  });
});
