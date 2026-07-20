// Reading density preference (Default / Comfortable / Compact — the Gmail
// density-picker pattern) — view-truth, persisted in `localStorage` exactly
// like theme.ts / accent.ts. Applying stamps (or clears) `data-density` on
// <html>; reading.css/base.css key their density multipliers off it. An
// instant `setAttribute`/`removeAttribute` call, never wrapped in a
// transition (opacity-only animation rule, D1) — the reading column simply
// re-measures at its new size, the same way a window resize or an accent
// swap already requires no special-casing from the anchor engine.
//
// Cross-window sync: both webviews share the app origin's localStorage, so a
// `storage` event fired in one window re-applies the preference in the other.

export type DensityPref = 'default' | 'comfortable' | 'compact';

const STORAGE_KEY = 'sz-density';
const DEFAULT_DENSITY: DensityPref = 'default';

type DensityListener = (pref: DensityPref) => void;
const listeners = new Set<DensityListener>();

function isDensityPref(value: string | null): value is DensityPref {
  return value === 'default' || value === 'comfortable' || value === 'compact';
}

/** The persisted preference; malformed/absent storage falls back to 'default'. */
export function getDensityPref(): DensityPref {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isDensityPref(raw)) return raw;
  } catch {
    // localStorage unavailable — treat as unset.
  }
  return DEFAULT_DENSITY;
}

/** Stamp/clear `data-density` on `root` — the only DOM write this module makes.
    'default' clears the attribute so today's unscaled values are the no-op case. */
function apply(pref: DensityPref, root: HTMLElement = document.documentElement): void {
  if (pref === 'default') root.removeAttribute('data-density');
  else root.setAttribute('data-density', pref);
}

/** Persist + apply + notify subscribers (e.g. the radio group in another window). */
export function setDensityPref(pref: DensityPref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Non-persistent session: the preference still applies for this window's life.
  }
  apply(pref);
  for (const listener of listeners) listener(pref);
}

/**
 * Apply the saved preference now and keep it live: re-apply when another
 * window writes the preference. `onPrefChange` lets a caller mirror external
 * changes into UI (the settings radio group). Returns a teardown.
 */
export function initDensity(onPrefChange?: DensityListener): () => void {
  apply(getDensityPref());

  if (onPrefChange) listeners.add(onPrefChange);

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const pref = getDensityPref();
    apply(pref);
    for (const listener of listeners) listener(pref);
  };
  window.addEventListener('storage', onStorage);

  return () => {
    if (onPrefChange) listeners.delete(onPrefChange);
    window.removeEventListener('storage', onStorage);
  };
}
