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
