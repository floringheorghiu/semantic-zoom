// general-tab.ts — General tab controls for the settings window.
//
// Bundles alone into settings.html, same discipline as inference-tab.ts:
// never imports the viewport, store, or engine modules. The accent-color
// swatch picker, theme radios, and anchor-visibility checkbox each own their
// own init function, kept cleanly separable.

import { getAccentPref, setAccentPref } from '../../state/accent';
import { getThemePref, setThemePref, type ThemePref } from '../../state/theme';
import { getShowAnchors, setShowAnchors } from '../../state/anchor-visibility';

/** Presets shown as swatch buttons (user-ratified set), custom via <input type="color">. */
const ACCENT_PRESETS = ['#8080ff', '#ff6b35', '#2fa26e', '#e0529c', '#d9a514', '#4aa8d8'];

/**
 * Render the swatch picker into `#accent-swatches`: one button per preset
 * plus a native color input for custom values. Clicking a swatch or picking
 * a custom color both call `setAccentPref`, which applies + persists +
 * cross-window syncs (state/accent.ts). The active swatch/input reflects
 * `getAccentPref()` and re-syncs on `storage` events fired by the OTHER
 * window (e.g. the main window's titlebar, if it ever grows a picker).
 */
function initAccentSwatches(): void {
  const container = document.getElementById('accent-swatches');
  if (!container) return;

  const swatchButtons = new Map<string, HTMLButtonElement>();

  for (const hex of ACCENT_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.style.background = hex;
    button.setAttribute('aria-label', hex);
    button.addEventListener('click', () => {
      setAccentPref(hex);
      refreshActive();
    });
    container.appendChild(button);
    swatchButtons.set(hex, button);
  }

  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.id = 'accent-custom';
  customInput.setAttribute('aria-label', 'Custom accent color');
  customInput.addEventListener('input', () => {
    setAccentPref(customInput.value);
    refreshActive();
  });
  container.appendChild(customInput);

  function refreshActive(): void {
    const current = getAccentPref();
    for (const [hex, button] of swatchButtons) {
      const active = hex.toLowerCase() === current.toLowerCase();
      if (active) button.setAttribute('data-active', 'true');
      else button.removeAttribute('data-active');
    }
    customInput.value = current;
  }

  refreshActive();
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== 'sz-accent') return;
    refreshActive();
  });
}

/**
 * Wire `#theme-group`'s radios: reflect `getThemePref()` on load, write
 * `setThemePref(value)` on `change`. Returns a `reflectRadios` callback so
 * the caller can pass it into the entry's `initTheme()` — that keeps these
 * radios in sync when the pref changes externally (the main-window titlebar
 * switcher, or another window's `storage` event).
 */
function initThemeRadios(): (pref: ThemePref) => void {
  const group = document.getElementById('theme-group');
  const radios = group
    ? Array.from(group.querySelectorAll<HTMLInputElement>('input[name="theme"]'))
    : [];

  function reflectRadios(pref: ThemePref): void {
    for (const radio of radios) radio.checked = radio.value === pref;
  }

  for (const radio of radios) {
    radio.addEventListener('change', () => {
      if (radio.checked) setThemePref(radio.value as ThemePref);
    });
  }

  reflectRadios(getThemePref());
  return reflectRadios;
}

/**
 * Wire `#show-anchors`: reflect `getShowAnchors()` on load, write
 * `setShowAnchors(checked)` on `change`. No returned sync callback (unlike
 * theme) — nothing else in this window needs to observe the preference
 * changing live; `state/anchor-visibility.ts`'s own `storage` listener keeps
 * the DOM attribute correct across windows regardless.
 */
function initAnchorVisibilityCheckbox(): void {
  const checkbox = document.getElementById('show-anchors') as HTMLInputElement | null;
  if (!checkbox) return;

  checkbox.checked = getShowAnchors();
  checkbox.addEventListener('change', () => {
    setShowAnchors(checkbox.checked);
  });
}

/**
 * Wire every General tab control. Returns the theme-radio sync callback so
 * the settings entry can feed it into `initTheme()`, keeping radios
 * live-synced with external theme changes.
 */
export function initGeneralTab(): (pref: ThemePref) => void {
  initAccentSwatches();
  const reflectRadios = initThemeRadios();
  initAnchorVisibilityCheckbox();
  return reflectRadios;
}
