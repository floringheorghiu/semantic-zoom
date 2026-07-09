import type { ZoomLevel } from '../engine/schema';

export interface ZoomScrubberOptions {
  onChange: (level: ZoomLevel) => void;
  /** Levels whose summaries are unavailable (Engine B not yet run). */
  disabledLevels?: ZoomLevel[];
  /** The currently-active level, marked `data-active` so menu/keyboard
      zoom changes stay reflected in the scrubber. */
  active?: ZoomLevel;
}

/**
 * The three segments, keyed by their ⌘-shortcut and ordered exactly as the
 * View-menu accelerators progress: ⌘1 = full text (0), ⌘2 = sections (−1),
 * ⌘3 = story (−2). Left→right is a progression to higher zoom-OUT levels
 * (Figma node 104-3409) — the segment labels ARE the keyboard commands, so
 * the toolbar teaches the shortcuts by being read.
 */
const SEGMENTS: Array<{ key: string; level: ZoomLevel; title: string }> = [
  { key: '1', level: 0, title: 'Detail view' },
  { key: '2', level: -1, title: 'Section view' },
  { key: '3', level: -2, title: 'Story view' },
];

const MINUS_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const PLUS_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/**
 * Mount the bottom-center zoom scrubber (Figma 104-3409): a white pill of
 * three ⌘-labelled segments `⌘1 ⌘2 ⌘3`, flanked by a round `+` on the LEFT
 * (step toward ⌘1 / full text) and a round `−` on the RIGHT (step toward
 * ⌘3 / story). The active segment fills with the content-map purple. The
 * `+`/`−` buttons step across the ENABLED semantic range only. Returns a
 * teardown removing all listeners.
 */
export function mountZoomScrubber(el: HTMLElement, opts: ZoomScrubberOptions): () => void {
  const disabled = new Set(opts.disabledLevels ?? []);
  el.classList.add('zoom-scrubber');
  el.replaceChildren();

  const cleanups: Array<() => void> = [];

  // Displayed order: 0, −1, −2 (zoom-out progression, left→right).
  const shown = SEGMENTS.map((s) => s.level);
  const enabled = shown.filter((level) => !disabled.has(level));

  const bind = (btn: HTMLElement, handler: () => void): void => {
    btn.addEventListener('click', handler);
    cleanups.push(() => btn.removeEventListener('click', handler));
  };

  const activeIdx = (): number =>
    opts.active === undefined ? -1 : enabled.indexOf(opts.active);

  const makeEnd = (
    cls: string,
    step: string,
    label: string,
    svg: string,
    target: () => ZoomLevel | null,
  ): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `scrubber-end ${cls}`;
    btn.dataset.step = step;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svg;
    if (target() === null) btn.setAttribute('data-disabled', '');
    btn.disabled = target() === null;
    bind(btn, () => {
      const t = target();
      if (t !== null) opts.onChange(t);
    });
    return btn;
  };

  // Round `+` on the LEFT: step toward ⌘1 / level 0 (previous enabled index).
  el.appendChild(
    makeEnd('scrubber-plus', 'plus', 'Zoom in', PLUS_SVG, () => {
      const i = activeIdx();
      if (i <= 0) return null; // already at 0 (or active not in enabled range)
      return enabled[i - 1];
    }),
  );

  // Segments ⌘1 / ⌘2 / ⌘3.
  for (const seg of SEGMENTS) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'scrubber-segment';
    cell.dataset.detent = seg.key;
    cell.title = seg.title;

    const cmd = document.createElement('span');
    cmd.className = 'seg-cmd';
    cmd.textContent = '⌘';
    const num = document.createElement('span');
    num.textContent = seg.key;
    cell.append(cmd, num);
    cell.setAttribute('aria-label', `${seg.title} (Cmd+${seg.key})`);

    if (opts.active === seg.level) {
      cell.setAttribute('data-active', '');
      cell.setAttribute('aria-pressed', 'true');
    }

    if (disabled.has(seg.level)) {
      cell.setAttribute('data-disabled', '');
      cell.disabled = true;
      cell.title = 'No summary available';
    } else {
      bind(cell, () => opts.onChange(seg.level));
    }

    el.appendChild(cell);
  }

  // Round `−` on the RIGHT: step toward ⌘3 / level −2 (next enabled index).
  el.appendChild(
    makeEnd('scrubber-minus', 'minus', 'Zoom out', MINUS_SVG, () => {
      const i = activeIdx();
      if (i < 0 || i >= enabled.length - 1) return null; // already at −2
      return enabled[i + 1];
    }),
  );

  return () => {
    for (const c of cleanups) c();
    el.replaceChildren();
  };
}
