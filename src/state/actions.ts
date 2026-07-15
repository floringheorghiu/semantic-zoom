// src/state/actions.ts
// Typed action creators. UI modules dispatch these via actions$.next(...).
import type { ZoomLevel, LookupTable } from '../engine/schema';
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

export const providerStatusLoaded = (configured: boolean): Action => ({
  type: 'PROVIDER_STATUS_LOADED',
  configured,
});

export const synthesisStarted = (): Action => ({ type: 'SYNTHESIS_STARTED' });

export const synthesisSucceeded = (table: LookupTable): Action => ({
  type: 'SYNTHESIS_SUCCEEDED',
  table,
});

export const synthesisFailed = (error: string): Action => ({ type: 'SYNTHESIS_FAILED', error });
