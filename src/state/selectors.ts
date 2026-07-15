// src/state/selectors.ts
// Memoized distinctUntilChanged selectors (thin wrappers over select()).
// Components subscribe to these, never to the raw store.
import { select } from './store';

export const selectZoom = () => select((s) => s.zoom);
export const selectStatus = () => select((s) => s.status);
export const selectActiveGroupHead = () => select((s) => s.activeGroupHead);
export const selectDoc = () => select((s) => s.doc);
export const selectIndex = () => select((s) => s.index);
export const selectCaret = () => select((s) => s.caret);
export const selectProviderConfigured = () => select((s) => s.providerConfigured);

/**
 * Generate-affordance visibility matrix (§8.5, §2.7 stub UX), pure and
 * synchronous so both the reducer-adjacent tests and the real UI compute it
 * identically:
 *   - Untagged × provider configured  → 'generate' (clickable affordance)
 *   - Untagged × no provider          → 'stub'     (§2.7's disabled tooltip)
 *   - anything else (ready/corrupt/synthesizing/reloading/empty) → 'hidden'
 */
export type GenerateAffordanceState = 'generate' | 'stub' | 'hidden';

export function generateAffordanceVisibility(
  status: import('./store').DocStatus,
  providerConfigured: boolean,
): GenerateAffordanceState {
  if (status !== 'untagged') return 'hidden';
  return providerConfigured ? 'generate' : 'stub';
}

export const selectGenerateAffordance = () =>
  select((s) => generateAffordanceVisibility(s.status, s.providerConfigured));
