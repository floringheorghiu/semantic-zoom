// src/state/store.ts
import { BehaviorSubject, Subject } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import { buildIndex } from '../engine/schema';
import type { LookupTable, ZoomLevel, ResolvedIndex } from '../engine/schema';

export type DocStatus = 'empty' | 'ready' | 'untagged' | 'corrupt' | 'reloading';

export interface AppState {
  zoom: ZoomLevel;
  doc: LookupTable | null;
  index: ResolvedIndex | null;
  raw: string;
  status: DocStatus;
  caret: { paragraphId: string | null; offset: number };
  /** P-id whose sibling group is spotlit. Derived from caret, cached here
      so focus-mask doesn't recompute the group on every caret offset tick. */
  activeGroupHead: string | null;
  /** Per-container "remembered place" maps (§2.5). */
  lastCaretIn: Map<string, string>;   // S-id → P-id
  lastAnchorIn: Map<string, string>;  // M-id → S-id
}

export type Action =
  | { type: 'DOC_LOADED'; result: import('../engine/engine-a').LoadResultDTO }
  | { type: 'DOC_CHANGED_ON_DISK' }          // from watcher event
  | { type: 'DOC_CLOSED' }                   // File > Close (⌘W)
  | { type: 'ZOOM_SET'; level: ZoomLevel }
  | { type: 'CARET_PLACED'; paragraphId: string; offset: number };

const initial: AppState = {
  zoom: 0, doc: null, index: null, raw: '', status: 'empty',
  caret: { paragraphId: null, offset: 0 },
  activeGroupHead: null,
  lastCaretIn: new Map(), lastAnchorIn: new Map(),
};

const state$ = new BehaviorSubject<AppState>(initial);
export const actions$ = new Subject<Action>();

actions$.subscribe((a) => state$.next(reduce(state$.getValue(), a)));

export const select = <T>(fn: (s: AppState) => T) =>
  state$.pipe(map(fn), distinctUntilChanged());

/** Synchronous read of the current state (for effects that need a snapshot,
    e.g. the zoom transition reading caret + place-memory at ZOOM_SET time). */
export const snapshot = (): AppState => state$.getValue();

/**
 * Pure reducer (§3.2). No side effects; effects live in main.ts / UI modules.
 */
export function reduce(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'ZOOM_SET':
      return { ...s, zoom: a.level };

    case 'CARET_PLACED': {
      const caret = { paragraphId: a.paragraphId, offset: a.offset };
      // If no index yet, we can't recompute the group — leave head unchanged.
      if (!s.index) return { ...s, caret };
      const nextHead = s.index.siblingGroup.get(a.paragraphId)?.[0] ?? null;
      // Same group ⇒ keep the SAME value so distinctUntilChanged suppresses
      // caret-driven re-emission of the activeGroupHead selector (§3.2).
      const activeGroupHead = nextHead === s.activeGroupHead ? s.activeGroupHead : nextHead;
      return { ...s, caret, activeGroupHead };
    }

    case 'DOC_LOADED': {
      const base: AppState = {
        ...s,
        raw: a.result.raw,
        caret: { paragraphId: null, offset: 0 },
        activeGroupHead: null,
      };
      switch (a.result.kind) {
        case 'native':
          return {
            ...base,
            doc: a.result.table,
            index: buildIndex(a.result.table),
            status: 'ready',
          };
        case 'untagged':
          return { ...base, doc: null, index: null, status: 'untagged' };
        case 'corrupt':
          return { ...base, doc: null, index: null, status: 'corrupt' };
      }
      return base;
    }

    case 'DOC_CHANGED_ON_DISK':
      return { ...s, status: 'reloading' };

    case 'DOC_CLOSED':
      return {
        ...s,
        doc: null,
        index: null,
        raw: '',
        status: 'empty',
        caret: { paragraphId: null, offset: 0 },
        activeGroupHead: null,
      };
  }
}
