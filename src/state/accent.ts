// Accent-color preference — view-truth, persisted in `localStorage` exactly
// like theme.ts. Applying stamps the `--sz-accent` custom property on <html>
// (tokens.css routes --sz-map-bar-active / --sz-ui-accent through it), an
// instant `setProperty` call — never wrapped in a transition (opacity-only
// animation rule).
//
// Cross-window sync: both webviews share the app origin's localStorage, so a
// `storage` event fired in one window re-applies the accent in the other.

const STORAGE_KEY = 'sz-accent';
const DEFAULT_ACCENT = '#8080ff';
const HEX_RE = /^#[0-9a-f]{6}$/i;

type AccentListener = (hex: string) => void;
const listeners = new Set<AccentListener>();

/** The persisted preference; malformed/absent storage falls back to the default. */
export function getAccentPref(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null && HEX_RE.test(raw)) return raw;
  } catch {
    // localStorage unavailable — treat as unset.
  }
  return DEFAULT_ACCENT;
}

/** Stamp `--sz-accent` on `root` — the only DOM write this module makes. */
function apply(hex: string, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--sz-accent', hex);
}

/** Persist + apply + notify subscribers (e.g. the swatch picker in another window). */
export function setAccentPref(hex: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, hex);
  } catch {
    // Non-persistent session: the accent still applies for this window's life.
  }
  apply(hex);
  for (const listener of listeners) listener(hex);
}

/**
 * Apply the saved accent now and keep it live: re-apply when another window
 * writes the preference. `onPrefChange` lets a caller mirror external changes
 * into UI (the swatch picker's active state). Returns a teardown.
 */
export function initAccent(onPrefChange?: AccentListener): () => void {
  apply(getAccentPref());

  if (onPrefChange) listeners.add(onPrefChange);

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const hex = getAccentPref();
    apply(hex);
    for (const listener of listeners) listener(hex);
  };
  window.addEventListener('storage', onStorage);

  return () => {
    if (onPrefChange) listeners.delete(onPrefChange);
    window.removeEventListener('storage', onStorage);
  };
}
