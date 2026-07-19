// Anchor-ID visibility preference — view-truth, persisted in `localStorage`
// exactly like theme.ts / accent.ts. Applying stamps (or clears)
// `data-hide-anchors` on <html> (reading.css hides `.sid-label` while the
// attribute is present) — an instant `setAttribute`/`removeAttribute` call,
// never wrapped in a transition (opacity-only animation rule).
//
// Cross-window sync: both webviews share the app origin's localStorage, so a
// `storage` event fired in one window re-applies the preference in the other.

const STORAGE_KEY = 'sz-show-anchors';

type ShowAnchorsListener = (show: boolean) => void;
const listeners = new Set<ShowAnchorsListener>();

/** The persisted preference; malformed/absent storage falls back to `true`
    (matches today's always-visible behavior). */
export function getShowAnchors(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'true' || raw === 'false') return raw === 'true';
  } catch {
    // localStorage unavailable — treat as unset.
  }
  return true;
}

/** Stamp/clear `data-hide-anchors` on `root` — the only DOM write this module makes. */
function apply(show: boolean, root: HTMLElement = document.documentElement): void {
  if (show) root.removeAttribute('data-hide-anchors');
  else root.setAttribute('data-hide-anchors', '');
}

/** Persist + apply + notify subscribers (e.g. the checkbox in another window). */
export function setShowAnchors(show: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(show));
  } catch {
    // Non-persistent session: the preference still applies for this window's life.
  }
  apply(show);
  for (const listener of listeners) listener(show);
}

/**
 * Apply the saved preference now and keep it live: re-apply when another
 * window writes the preference. `onPrefChange` lets a caller mirror external
 * changes into UI (the checkbox's checked state). Returns a teardown.
 */
export function initAnchorVisibility(onPrefChange?: ShowAnchorsListener): () => void {
  apply(getShowAnchors());

  if (onPrefChange) listeners.add(onPrefChange);

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const show = getShowAnchors();
    apply(show);
    for (const listener of listeners) listener(show);
  };
  window.addEventListener('storage', onStorage);

  return () => {
    if (onPrefChange) listeners.delete(onPrefChange);
    window.removeEventListener('storage', onStorage);
  };
}
