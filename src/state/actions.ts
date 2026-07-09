// src/state/actions.ts
// Typed action creators. UI modules dispatch these via actions$.next(...).
import type { ZoomLevel } from '../engine/schema';
import type { LoadResultDTO } from '../engine/engine-a';
import type { Action } from './store';

export const zoomSet = (level: ZoomLevel): Action => ({ type: 'ZOOM_SET', level });

export const caretPlaced = (paragraphId: string, offset: number): Action => ({
  type: 'CARET_PLACED',
  paragraphId,
  offset,
});

export const docLoaded = (result: LoadResultDTO): Action => ({ type: 'DOC_LOADED', result });

export const docChangedOnDisk = (): Action => ({ type: 'DOC_CHANGED_ON_DISK' });

/** File > Close (⌘W): return the store to its pre-open empty state. */
export const docClosed = (): Action => ({ type: 'DOC_CLOSED' });
