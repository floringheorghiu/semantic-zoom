// general-tab.ts — General tab controls for the settings window.
//
// Bundles alone into settings.html, same discipline as inference-tab.ts:
// never imports the viewport, store, or engine modules. Task 2 adds the
// accent-color swatch picker; later tasks (3, 4) extend this file with the
// theme radios and the anchor-visibility checkbox as their own sections —
// each kept in its own init function so they stay cleanly separable.

import { getAccentPref, setAccentPref } from '../../state/accent';

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

/** Wire every General tab control. Extended by later tasks (theme, anchor). */
export function initGeneralTab(): void {
  initAccentSwatches();
}
