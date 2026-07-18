// Theme preference (light / dark / system) — view-truth, persisted in
// `localStorage` exactly like recent-files.ts. Applying a theme stamps
// `data-theme` on <html> (tokens.css owns both palettes and keys the dark
// mapping off `:root[data-theme="dark"]`) and mirrors `color-scheme` as an
// inline style so windows that do NOT load tokens.css (settings.html) follow
// the same choice through the UA's own light/dark form styling.
//
// Cross-window sync: both webviews share the app origin's localStorage, so a
// `storage` event fired in one window re-applies the theme in the other.

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'sz.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

type PrefListener = (pref: ThemePref) => void;
const listeners = new Set<PrefListener>();

/** The persisted preference; malformed/absent storage falls back to 'system'. */
export function getThemePref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // localStorage unavailable — treat as unset.
  }
  return 'system';
}

/** Pure resolution: 'system' follows the OS, anything else is itself. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/**
 * Stamp the resolved theme on `root`: `data-theme="dark"` opts into the dark
 * token mapping (absence = light, tokens.css's `:root` default), and the
 * inline `color-scheme` forces UA form/scrollbar rendering to match even in
 * documents that never import tokens.css.
 */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  const resolved = resolveTheme(pref, systemPrefersDark());
  if (resolved === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  root.style.colorScheme = resolved;
}

/** Persist + apply + notify subscribers (e.g. the switcher in another window). */
export function setThemePref(pref: ThemePref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Non-persistent session: the theme still applies for this window's life.
  }
  applyTheme(pref);
  for (const listener of listeners) listener(pref);
}

/**
 * Apply the saved theme now and keep it live: re-resolve when the OS scheme
 * flips (only matters for 'system') and when another window writes the
 * preference. `onPrefChange` lets a caller mirror external changes into UI
 * (the titlebar switcher). Returns a teardown.
 */
export function initTheme(onPrefChange?: PrefListener): () => void {
  applyTheme(getThemePref());

  if (onPrefChange) listeners.add(onPrefChange);

  const onSystemChange = (): void => {
    if (getThemePref() === 'system') applyTheme('system');
  };
  let media: MediaQueryList | null = null;
  if (typeof window.matchMedia === 'function') {
    media = window.matchMedia(DARK_QUERY);
    media.addEventListener('change', onSystemChange);
  }

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const pref = getThemePref();
    applyTheme(pref);
    for (const listener of listeners) listener(pref);
  };
  window.addEventListener('storage', onStorage);

  return () => {
    if (onPrefChange) listeners.delete(onPrefChange);
    media?.removeEventListener('change', onSystemChange);
    window.removeEventListener('storage', onStorage);
  };
}
