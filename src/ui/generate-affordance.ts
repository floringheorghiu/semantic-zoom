// generate-affordance.ts — the real Engine B trigger (D10/§8.5), per the
// Figma mockups (nodes 199:494 idle, 199:861 loading animation, 199:890
// stop-on-hover). Deliberately NOT part of the zoom-scrubber: the mockups
// keep the −1/−2 scrubber segments in their normal disabled/dimmed state
// and place this as a separate small floating icon button occupying the
// SAME corner slot as `#content-map` (`src/styles/content-map.css`) — that
// slot is already empty exactly when this needs to appear (no LookupTable
// → no map), so the two are mutually exclusive by construction.
//
// Three visual states, all built from the exact Figma-exported assets (not
// hand-drawn — figma-design-to-code skill's icon-fidelity rule):
//   idle    — the binoculars/wand icon (node 199:494), click = onGenerate
//   loading — two binary-digit frames (199:861's only two variants,
//             "Property 1=1"/"Property 1=3") alternated on a timer
//   hover-to-stop — while loading, hovering swaps in a stop icon (199:1195
//             in the "stopping progress" mockup); click = onCancel

import generateIconSvg from '../assets/generate-affordance.svg?raw';
import loadingFrame1Svg from '../assets/generate-loading-1.svg?raw';
import loadingFrame2Svg from '../assets/generate-loading-2.svg?raw';
import stopIconSvg from '../assets/generate-stop.svg?raw';

/** How often the two loading frames swap (Figma has no motion/keyframe data
    attached to this component — just two static variants — so this picks a
    steady, unhurried rate that reads as "working" without being distracting). */
const FRAME_INTERVAL_MS = 500;

export type GenerateAffordanceState = 'idle' | 'loading';

export interface GenerateAffordanceOptions {
  onGenerate: () => void;
  onCancel: () => void;
}

export interface GenerateAffordanceHandle {
  teardown: () => void;
  /** Shown only for Untagged docs with a usable Engine B provider (§8.5's
      visibility matrix) — callers gate this, this module just renders. */
  setVisible: (visible: boolean) => void;
  /** Trust-boundary tooltip (§8.5): states plainly whether generating sends
      the document to a remote endpoint or runs locally. Refreshed whenever
      the provider config changes (e.g. after a Settings save). */
  setTooltip: (text: string) => void;
  /** idle = clickable Generate icon; loading = animated, hover reveals Stop. */
  setState: (state: GenerateAffordanceState) => void;
}

/**
 * Populates an existing `<button id="generate-affordance" hidden>` element
 * (index.html — a sibling of `#content-map` inside `.viewport-wrap`, same
 * convention as `mountContentMap`), rather than creating and appending one
 * itself.
 */
export function mountGenerateAffordance(
  btn: HTMLButtonElement,
  opts: GenerateAffordanceOptions,
): GenerateAffordanceHandle {
  btn.hidden = true;
  btn.dataset.state = 'idle';
  btn.dataset.frame = '1';

  const idleIcon = document.createElement('span');
  idleIcon.className = 'ga-icon ga-icon--idle';
  idleIcon.innerHTML = generateIconSvg;

  const loadingIcon = document.createElement('span');
  loadingIcon.className = 'ga-icon ga-icon--loading';
  const frame1 = document.createElement('span');
  frame1.className = 'ga-frame ga-frame--1';
  frame1.innerHTML = loadingFrame1Svg;
  const frame2 = document.createElement('span');
  frame2.className = 'ga-frame ga-frame--2';
  frame2.innerHTML = loadingFrame2Svg;
  loadingIcon.append(frame1, frame2);

  const stopIcon = document.createElement('span');
  stopIcon.className = 'ga-icon ga-icon--stop';
  stopIcon.innerHTML = stopIconSvg;

  btn.replaceChildren(idleIcon, loadingIcon, stopIcon);

  let frameTimer: ReturnType<typeof setInterval> | null = null;

  function startAnimation(): void {
    if (frameTimer !== null) return;
    frameTimer = setInterval(() => {
      btn.dataset.frame = btn.dataset.frame === '1' ? '2' : '1';
    }, FRAME_INTERVAL_MS);
  }

  function stopAnimation(): void {
    if (frameTimer === null) return;
    clearInterval(frameTimer);
    frameTimer = null;
    btn.dataset.frame = '1';
  }

  function setState(state: GenerateAffordanceState): void {
    btn.dataset.state = state;
    if (state === 'loading') startAnimation();
    else stopAnimation();
  }

  const handleClick = (): void => {
    if (btn.dataset.state === 'loading') opts.onCancel();
    else opts.onGenerate();
  };
  btn.addEventListener('click', handleClick);

  function setTooltip(text: string): void {
    btn.title = text;
    btn.setAttribute('aria-label', `Generate summary — ${text}`);
  }
  setTooltip('Generate summary');

  return {
    teardown: () => {
      stopAnimation();
      btn.removeEventListener('click', handleClick);
      btn.replaceChildren();
      btn.hidden = true;
    },
    setVisible: (visible: boolean) => {
      btn.hidden = !visible;
      // A hidden button must never have a live animation timer behind it —
      // regardless of whether the caller remembered to setState('idle')
      // first (handleGenerate's success path hides via a different code
      // path than its own explicit state resets).
      if (!visible) setState('idle');
    },
    setTooltip,
    setState,
  };
}
