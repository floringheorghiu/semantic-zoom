import type { ZoomLevel } from '../engine/schema';

export interface ZoomScrubberOptions {
  onChange: (level: ZoomLevel) => void;
  /** Levels whose summaries are unavailable (Engine B not yet run). */
  disabledLevels?: ZoomLevel[];
  /** The currently-active level, marked `data-active` so menu/keyboard
      zoom changes stay reflected in the scrubber. */
  active?: ZoomLevel;
}

/** The three SEMANTIC levels the scrubber dispatches, story→raw (−2 … 0). */
const SEMANTIC_LEVELS: ZoomLevel[] = [-2, -1, 0];

/**
 * The five displayed segments. `-2/-1/0` are the semantic levels; `+1/+2` are
 * a permanently-disabled visible affordance for future content-magnify (plan
 * §2 D-B) — they are NEVER wired and carry no ZoomLevel value.
 */
const SEGMENTS: Array<{ label: string; level: ZoomLevel | null }> = [
  { label: '-2', level: -2 },
  { label: '-1', level: -1 },
  { label: '0', level: 0 },
  { label: '+1', level: null },
  { label: '+2', level: null },
];

const MINUS_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const PLUS_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/**
 * Mount the bottom-center zoom scrubber (plan §4.3): a segmented pill with a
 * round `−`/`+` end button either side of five segments `-2 -1 0 +1 +2`. The
 * `−`/`+` buttons step across the ENABLED semantic range only (they never cross
 * into the disabled `+1/+2` cells). Returns a teardown removing all listeners.
 */
export function mountZoomScrubber(el: HTMLElement, opts: ZoomScrubberOptions): () => void {
  const disabled = new Set(opts.disabledLevels ?? []);
  el.classList.add('zoom-scrubber');
  el.replaceChildren();

  const cleanups: Array<() => void> = [];

  const isEnabled = (level: ZoomLevel): boolean => !disabled.has(level);
  const enabled = SEMANTIC_LEVELS.filter(isEnabled); // ascending: −2 … 0

  const bind = (btn: HTMLElement, handler: () => void): void => {
    btn.addEventListener('click', handler);
    cleanups.push(() => btn.removeEventListener('click', handler));
  };

  // Round `−` end button: step toward −2 (next lower enabled level).
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'scrubber-end scrubber-minus';
  minus.dataset.step = 'minus';
  minus.setAttribute('aria-label', 'Zoom out');
  minus.innerHTML = MINUS_SVG;
  const activeIdx = (): number =>
    opts.active === undefined ? -1 : enabled.indexOf(opts.active);
  const minusTarget = (): ZoomLevel | null => {
    const i = activeIdx();
    if (i <= 0) return null; // already at −2 (or active not in enabled range)
    return enabled[i - 1];
  };
  if (minusTarget() === null) minus.setAttribute('data-disabled', '');
  minus.disabled = minusTarget() === null;
  bind(minus, () => {
    const t = minusTarget();
    if (t !== null) opts.onChange(t);
  });
  el.appendChild(minus);

  // Segments.
  for (const seg of SEGMENTS) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'scrubber-segment';
    cell.dataset.detent = seg.label;
    cell.textContent = seg.label;

    const semanticDisabled = seg.level !== null && disabled.has(seg.level);
    const affordanceOnly = seg.level === null; // +1 / +2 — never wired
    const cellDisabled = affordanceOnly || semanticDisabled;

    if (seg.level !== null && opts.active === seg.level) {
      cell.setAttribute('data-active', '');
      cell.setAttribute('aria-pressed', 'true');
    }

    if (cellDisabled) {
      cell.setAttribute('data-disabled', '');
      cell.disabled = true;
      cell.title = affordanceOnly ? 'Content magnify (coming soon)' : 'No summary available';
    } else {
      const level = seg.level as ZoomLevel;
      bind(cell, () => opts.onChange(level));
    }

    el.appendChild(cell);
  }

  // Round `+` end button: step toward 0 (next higher enabled level). It stops
  // at 0 and NEVER moves into the disabled +1/+2 cells (plan §2 D-B).
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'scrubber-end scrubber-plus';
  plus.dataset.step = 'plus';
  plus.setAttribute('aria-label', 'Zoom in');
  plus.innerHTML = PLUS_SVG;
  const plusTarget = (): ZoomLevel | null => {
    const i = activeIdx();
    if (i < 0 || i >= enabled.length - 1) return null; // already at 0
    return enabled[i + 1];
  };
  if (plusTarget() === null) plus.setAttribute('data-disabled', '');
  plus.disabled = plusTarget() === null;
  bind(plus, () => {
    const t = plusTarget();
    if (t !== null) opts.onChange(t);
  });
  el.appendChild(plus);

  return () => {
    for (const c of cleanups) c();
    el.replaceChildren();
  };
}
