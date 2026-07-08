import { test, expect, vi } from 'vitest';
import { select, actions$, reduce, type AppState } from './store';
import type { LookupTable } from '../engine/schema';

test('ZOOM_SET changes zoom; unrelated CARET_PLACED does not re-emit zoom selector', () => {
  const zoomSpy = vi.fn();
  const sub = select((s: AppState) => s.zoom).subscribe(zoomSpy);
  actions$.next({ type: 'ZOOM_SET', level: -1 });
  actions$.next({ type: 'CARET_PLACED', paragraphId: 'P-x-0', offset: 3 });
  actions$.next({ type: 'CARET_PLACED', paragraphId: 'P-x-0', offset: 4 });
  // zoom selector emits: initial(0) + set(-1) = 2, NOT 4
  expect(zoomSpy).toHaveBeenCalledTimes(2);
  sub.unsubscribe();
});

test('DOC_CLOSED (File > Close, ⌘W) resets doc/index/raw/status/caret/activeGroupHead', () => {
  const table: LookupTable = {
    version: 1,
    docHash: 'x'.repeat(64),
    meta: {},
    sections: {},
    paragraphs: {},
    order: { meta: [], sections: [], paragraphs: [] },
  };
  const loaded: AppState = {
    zoom: -1,
    doc: table,
    index: { parentOfParagraph: new Map(), parentOfSection: new Map(), siblingGroup: new Map() },
    raw: 'raw text',
    status: 'ready',
    caret: { paragraphId: 'P-a-0', offset: 3 },
    activeGroupHead: 'P-a-0',
    lastCaretIn: new Map([['S-a-0', 'P-a-0']]),
    lastAnchorIn: new Map([['M1', 'S-a-0']]),
  };

  const next = reduce(loaded, { type: 'DOC_CLOSED' });

  expect(next.doc).toBeNull();
  expect(next.index).toBeNull();
  expect(next.raw).toBe('');
  expect(next.status).toBe('empty');
  expect(next.caret).toEqual({ paragraphId: null, offset: 0 });
  expect(next.activeGroupHead).toBeNull();
  // zoom (reset separately by main.ts's own ZOOM_SET dispatch) and the
  // content-addressed place-memory maps (harmless to keep, same as
  // DOC_LOADED) are untouched by DOC_CLOSED itself.
  expect(next.zoom).toBe(-1);
  expect(next.lastCaretIn).toBe(loaded.lastCaretIn);
  expect(next.lastAnchorIn).toBe(loaded.lastAnchorIn);
});
