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
    providerConfigured: false,
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

test('SYNTHESIS_STARTED moves untagged -> synthesizing, and is a no-op from any other status', () => {
  const untagged = reduce(
    { ...initialForTest(), status: 'untagged' },
    { type: 'SYNTHESIS_STARTED' },
  );
  expect(untagged.status).toBe('synthesizing');

  const ready = reduce(
    { ...initialForTest(), status: 'ready' },
    { type: 'SYNTHESIS_STARTED' },
  );
  expect(ready.status).toBe('ready');
});

test('SYNTHESIS_SUCCEEDED merges the table and moves to ready', () => {
  const table: LookupTable = {
    version: 1,
    docHash: 'y'.repeat(64),
    meta: { M1: { id: 'M1', level: -2, title: 't', body: 'b', children: ['S-a-0'] } },
    sections: { 'S-a-0': { id: 'S-a-0', level: -1, parent: 'M1', children: ['P-a-0'], title: 't', body: 'b' } },
    paragraphs: { 'P-a-0': { id: 'P-a-0', level: 0, parent: 'S-a-0', kind: 'prose', span: { start: 0, end: 1 }, html: '<p>x</p>' } },
    order: { meta: ['M1'], sections: ['S-a-0'], paragraphs: ['P-a-0'] },
  };
  const next = reduce(
    { ...initialForTest(), status: 'synthesizing' },
    { type: 'SYNTHESIS_SUCCEEDED', table },
  );
  expect(next.status).toBe('ready');
  expect(next.doc).toBe(table);
  expect(next.index).not.toBeNull();
});

test('SYNTHESIS_FAILED reverts synthesizing -> untagged, and is a no-op from any other status', () => {
  const reverted = reduce(
    { ...initialForTest(), status: 'synthesizing' },
    { type: 'SYNTHESIS_FAILED', error: 'boom' },
  );
  expect(reverted.status).toBe('untagged');

  const unaffected = reduce(
    { ...initialForTest(), status: 'ready' },
    { type: 'SYNTHESIS_FAILED', error: 'boom' },
  );
  expect(unaffected.status).toBe('ready');
});

test('PROVIDER_STATUS_LOADED sets providerConfigured', () => {
  const next = reduce(initialForTest(), { type: 'PROVIDER_STATUS_LOADED', configured: true });
  expect(next.providerConfigured).toBe(true);
});

function initialForTest(): AppState {
  return {
    zoom: 0, doc: null, index: null, raw: '', status: 'empty',
    caret: { paragraphId: null, offset: 0 },
    activeGroupHead: null,
    lastCaretIn: new Map(), lastAnchorIn: new Map(),
    providerConfigured: false,
  };
}
