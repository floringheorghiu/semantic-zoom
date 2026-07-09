// Content scaling (browser-style zoom of the reading content, distinct from the
// semantic zoom LEVELS). A scale factor is applied as a CSS `zoom` on the
// reading content via the `--content-scale` custom property; this module owns
// only the pure clamped-step math so it's trivially testable.

export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2.5;
export const SCALE_STEP = 0.1;
export const SCALE_DEFAULT = 1;

/** Round to 2 decimals so repeated ±0.1 steps don't drift (0.30000000004). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Next scale factor when stepping in `dir` (+1 larger, −1 smaller), clamped to
 * [SCALE_MIN, SCALE_MAX]. Pure — the caller applies the result to the DOM.
 */
export function nextScale(current: number, dir: 1 | -1): number {
  const stepped = current + dir * SCALE_STEP;
  return round2(Math.min(SCALE_MAX, Math.max(SCALE_MIN, stepped)));
}
