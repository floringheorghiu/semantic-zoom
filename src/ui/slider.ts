import type { ZoomLevel } from '../engine/schema';

export interface SliderOptions {
  onChange: (level: ZoomLevel) => void;
  /** Levels whose summaries are unavailable (Engine B not yet run). */
  disabledLevels?: ZoomLevel[];
  /** The currently-active level, marked `data-active` so menu/keyboard
      zoom changes stay reflected in the slider. */
  active?: ZoomLevel;
}

/** Detents, top-to-bottom: raw (0), section (−1), meta (−2). */
const DETENT_LEVELS: ZoomLevel[] = [0, -1, -2];

const DETENT_LABEL: Record<ZoomLevel, string> = {
  0: 'Raw',
  [-1]: 'Sections',
  [-2]: 'Story',
};

/**
 * Mount a 3-detent zoom slider (spec §2.7 seam). Disabled detents get
 * `data-disabled` + a tooltip so plugging in the real synthesizer later
 * touches zero UI code. Returns a teardown that removes all listeners.
 */
export function mountSlider(el: HTMLElement, opts: SliderOptions): () => void {
  const disabled = new Set(opts.disabledLevels ?? []);
  el.classList.add('zoom-slider');
  el.replaceChildren();

  const cleanups: Array<() => void> = [];

  for (const level of DETENT_LEVELS) {
    const detent = document.createElement('button');
    detent.type = 'button';
    detent.className = 'detent';
    detent.dataset.detent = String(level);
    detent.textContent = DETENT_LABEL[level];

    if (opts.active === level) {
      detent.setAttribute('data-active', '');
      detent.setAttribute('aria-pressed', 'true');
    }

    if (disabled.has(level)) {
      detent.setAttribute('data-disabled', '');
      detent.disabled = true;
      // "Generating summary…" is reserved for a future generating state;
      // an unavailable summary is "No summary available".
      detent.title = 'No summary available';
    } else {
      const onClick = () => opts.onChange(level);
      detent.addEventListener('click', onClick);
      cleanups.push(() => detent.removeEventListener('click', onClick));
    }

    el.appendChild(detent);
  }

  return () => {
    for (const c of cleanups) c();
    el.replaceChildren();
  };
}
