import { test, expect, vi } from 'vitest';
import { select, actions$, type AppState } from './store';

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
