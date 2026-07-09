// src/ui/caret.ts
// Read-only caret: click-to-place + arrow traversal across `.pnode`s.
//
// Boundary: this module is Tauri-free (spec §6 / ESLint). It does NOT import
// the store — the `dispatch` callback is injected by main.ts so the store stays
// the only thing wiring `actions$` (spec §3.3: components dispatch + subscribe
// to selectors; only main.ts touches the reducer bus).
import { Subject } from 'rxjs';
import { auditTime } from 'rxjs/operators';

/**
 * Pure helper: the next/prev pid in document order, CLAMPED at the ends.
 *
 * - `current === null` (or not present in `pids`): returns the first pid for
 *   `dir === 1`, the last for `dir === -1` (entering the document from an end).
 * - clamps: advancing past the last pid or before the first returns the same
 *   end pid.
 * - empty `pids`: nothing to move to → returns `current ?? ''`.
 *
 * Kept pure and synchronous so it is unit-testable without DOM or timers.
 */
export function nextParagraph(pids: string[], current: string | null, dir: 1 | -1): string {
  if (pids.length === 0) return current ?? '';
  const i = current === null ? -1 : pids.indexOf(current);
  if (i === -1) return dir === 1 ? pids[0] : pids[pids.length - 1];
  const next = i + dir;
  if (next < 0 || next >= pids.length) return pids[i]; // clamp at the ends
  return pids[next];
}

/**
 * Mount the read-only caret on a viewport.
 *
 * - Click on (or within) a `.pnode` → resolve the nearest ancestor `.pnode`,
 *   mark it `data-caret` (moving the mark off the previous one) and dispatch.
 * - ArrowDown / ArrowUp move the caret across `.pnode`s in document order.
 * - Offset is coarse/0 in Phase 1: the anchor engine keys on paragraphId only,
 *   so a per-character offset buys nothing yet.
 * - Outgoing dispatches are throttled with `auditTime(16)` (spec §3.2) so rapid
 *   arrow-repeat / click spam can't flood the store faster than a frame.
 *
 * Returns a teardown that removes every listener and subscription.
 */
export function mountCaret(
  viewport: HTMLElement,
  dispatch: (paragraphId: string, offset: number) => void,
): () => void {
  // All outgoing caret placements funnel through one auditTime(16) gate.
  const out$ = new Subject<{ pid: string; offset: number }>();
  const sub = out$.pipe(auditTime(16)).subscribe(({ pid, offset }) => dispatch(pid, offset));

  const currentPids = (): string[] =>
    Array.from(viewport.querySelectorAll<HTMLElement>('.pnode'))
      .map((el) => el.dataset.pid)
      .filter((pid): pid is string => !!pid);

  /** Move the `data-caret` marker to `pid` and queue a throttled dispatch. */
  function placeCaret(pid: string): void {
    for (const el of viewport.querySelectorAll('.pnode[data-caret]')) {
      el.removeAttribute('data-caret');
    }
    const target = Array.from(viewport.querySelectorAll<HTMLElement>('.pnode'))
      .find((el) => el.dataset.pid === pid);
    target?.setAttribute('data-caret', '');
    out$.next({ pid, offset: 0 });
  }

  /** The pid currently carrying the caret marker, if any. */
  function caretPid(): string | null {
    return viewport.querySelector<HTMLElement>('.pnode[data-caret]')?.dataset.pid ?? null;
  }

  const onClick = (e: MouseEvent): void => {
    const node = (e.target as HTMLElement | null)?.closest<HTMLElement>('.pnode');
    const pid = node?.dataset.pid;
    if (!pid) return;
    placeCaret(pid);
  };

  const onKeydown = (e: KeyboardEvent): void => {
    const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (dir === 0) return;
    const pids = currentPids();
    if (pids.length === 0) return;
    e.preventDefault();
    placeCaret(nextParagraph(pids, caretPid(), dir as 1 | -1));
  };

  viewport.addEventListener('click', onClick);
  window.addEventListener('keydown', onKeydown);

  return () => {
    viewport.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKeydown);
    sub.unsubscribe();
    out$.complete();
  };
}
