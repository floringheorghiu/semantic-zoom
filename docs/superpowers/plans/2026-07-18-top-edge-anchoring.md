# Top-Edge Anchoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zoom jumps anchor to the topmost visible node and land it just below the viewport's top edge, the invisible caret stops steering navigation, and a transient highlight shows what the jump anchored to.

**Architecture:** Two pure functions in `src/engine/anchor.ts` change (`resolveAnchor` → topmost-visible rule without a caret parameter; `centerScrollTop` → `topAlignScrollTop`); `src/ui/viewport.ts` adopts them, drops the caret plumbing, and toggles a `data-landed` attribute on settle; `src/main.ts` loses the `caretIsCurrent` machinery; the plan doc §2.5 is amended and its embedded zoom payload refreshed.

**Tech Stack:** Vanilla TypeScript, RxJS, Vitest (jsdom), CSS animations (opacity only, D1).

## Global Constraints

- Animate `opacity` only (D1) — the highlight fade must not transition filter/layout properties.
- Read-then-write DOM discipline; all scroll writes via `scrollCommands$` (§3.2); two-frame mount (D8) unchanged.
- No `@tauri-apps/*` imports under `src/engine/**` or `src/ui/**`.
- Fixtures are read-only oracles.
- Single shared gap constant `TOP_GAP = 24` (matches shipped ⌘↓/⌘↑ behavior; spec's "initially 16px" is superseded for consistency — flagged as a ratified deviation, tunable in the WebKit pass).
- `docs/Implementation_Plan.md` has an embedded zoom payload — after editing its prose, the payload MUST be refreshed via the embed-zoom-payload pipeline, never hand-patched.

---

### Task 1: Pure anchor functions (`anchor.ts`)

**Files:**
- Modify: `src/engine/anchor.ts` (replace `resolveAnchor`, replace `centerScrollTop` with `topAlignScrollTop`, export `TOP_GAP`)
- Test: `src/engine/anchor.test.ts`

**Interfaces:**
- Produces: `resolveAnchor(mounted: readonly MountedBox[], viewportTop: number): string | null`
- Produces: `topAlignScrollTop(el: {offsetTop: number}, viewport: {clientHeight: number; scrollHeight: number}, gap?: number): number`
- Produces: `export const TOP_GAP = 24`
- `recordPlace`, `mapAcrossLevels`, `MapCtx`, `MountedBox` unchanged.

- [ ] **Step 1: Write failing tests** in `anchor.test.ts` replacing the `resolveAnchor`/`centerScrollTop` suites:

```ts
describe('resolveAnchor — topmost actually-visible node', () => {
  const boxes = [
    { id: 'P-a', offsetTop: 0,   offsetHeight: 100 },
    { id: 'P-b', offsetTop: 100, offsetHeight: 200 },
    { id: 'P-c', offsetTop: 340, offsetHeight: 60 }, // 40px gap above
  ];
  test('node containing the top edge wins', () => {
    expect(resolveAnchor(boxes, 150)).toBe('P-b');
  });
  test('top edge exactly at a node boundary picks the node starting there', () => {
    expect(resolveAnchor(boxes, 100)).toBe('P-b');
  });
  test('top edge in a gap → first node starting below it', () => {
    expect(resolveAnchor(boxes, 310)).toBe('P-c'); // between b(ends 300) and c(starts 340)
  });
  test('node scrolled just past the top edge does NOT win by proximity', () => {
    // top edge at 301: P-b's bottom (300) is 1px above — closest, but gone.
    expect(resolveAnchor(boxes, 301)).toBe('P-c');
  });
  test('top edge below every node → bottommost node (over-scroll fallback)', () => {
    expect(resolveAnchor(boxes, 900)).toBe('P-c');
  });
  test('empty mounted list → null', () => {
    expect(resolveAnchor([], 0)).toBe(null);
  });
  test('zero-height boxes cannot contain the edge and are skipped as containers', () => {
    const withGhost = [{ id: 'ghost', offsetTop: 150, offsetHeight: 0 }, ...boxes];
    expect(resolveAnchor(withGhost, 150)).toBe('P-b');
  });
});

describe('topAlignScrollTop', () => {
  const vp = { clientHeight: 500, scrollHeight: 2000 };
  test('lands the node TOP_GAP below the top edge', () => {
    expect(topAlignScrollTop({ offsetTop: 800 }, vp)).toBe(800 - TOP_GAP);
  });
  test('clamps at 0 near the document start', () => {
    expect(topAlignScrollTop({ offsetTop: 10 }, vp)).toBe(0);
  });
  test('clamps at max scroll near the document end', () => {
    expect(topAlignScrollTop({ offsetTop: 1990 }, vp)).toBe(1500);
  });
  test('unscrollable document → 0', () => {
    expect(topAlignScrollTop({ offsetTop: 100 }, { clientHeight: 500, scrollHeight: 400 })).toBe(0);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/engine/anchor.test.ts` — expect FAIL (new signatures don't exist).
- [ ] **Step 3: Implement** in `anchor.ts` — delete `centerScrollTop`, replace `resolveAnchor`:

```ts
/** Shared "just below the top edge" breathing gap (px). Also used by ⌘↓/⌘↑
    and the content-map via viewport.ts — one convention everywhere. */
export const TOP_GAP = 24;

/** Top-alignment math (§2.5, amended): land `el` TOP_GAP below the top edge. */
export function topAlignScrollTop(
  el: { offsetTop: number },
  viewport: { clientHeight: number; scrollHeight: number },
  gap: number = TOP_GAP,
): number {
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return Math.min(Math.max(el.offsetTop - gap, 0), max);
}

/**
 * Anchor resolution (§2.5, amended): the topmost ACTUALLY-VISIBLE node — the
 * node whose box contains the viewport's top edge, else the first node
 * starting below it, else (over-scrolled past everything) the bottommost.
 * Deliberately NOT "closest to the top edge": a node whose bottom scrolled
 * 2px above the edge is close but no longer being read. No caret parameter —
 * scroll position is the only signal (invisible state must not steer jumps).
 */
export function resolveAnchor(
  mounted: readonly MountedBox[],
  viewportTop: number,
): string | null {
  let firstBelow: MountedBox | null = null;
  let bottommost: MountedBox | null = null;
  for (const el of mounted) {
    if (el.offsetTop <= viewportTop && viewportTop < el.offsetTop + el.offsetHeight) {
      return el.id;
    }
    if (el.offsetTop > viewportTop && (!firstBelow || el.offsetTop < firstBelow.offsetTop)) {
      firstBelow = el;
    }
    if (!bottommost || el.offsetTop > bottommost.offsetTop) bottommost = el;
  }
  return (firstBelow ?? bottommost)?.id ?? null;
}
```

- [ ] **Step 4:** `npx vitest run src/engine/anchor.test.ts` — expect PASS (recordPlace/mapAcrossLevels suites untouched and still green).
- [ ] **Step 5:** Commit: `feat(anchor): topmost-visible resolution + top-align math, caret param removed`

### Task 2: Viewport adoption (`viewport.ts` + transition tests)

**Files:**
- Modify: `src/ui/viewport.ts`
- Test: `src/ui/transition.test.ts`, `src/ui/zoom-anchor-integration.test.ts`

**Interfaces:**
- Consumes: Task 1's `resolveAnchor(boxes, viewportTop)`, `topAlignScrollTop(box, vp)`, `TOP_GAP`.
- Produces: `ZoomTransitionState` WITHOUT `caret`/`caretIsCurrent` fields (main.ts adapts in Task 3).

- [ ] **Step 1: Update tests.** In `transition.test.ts`: delete the two caret-anchor tests (`caretIsCurrent=false is ignored…`, its `=true` twin) and the `caret`/`caretIsCurrent` fixture state; change every landing assertion from center math to `topAlignScrollTop(box, vp)` expectations. In `zoom-anchor-integration.test.ts`: drop `caretIsCurrent` from state, assert top-aligned landings; keep the round-trip case (0→−1→0 restores the exact paragraph, now top-aligned).
- [ ] **Step 2:** Run both files — expect FAIL (viewport still centers / still requires caret state).
- [ ] **Step 3: Implement.**
  - `ZoomTransitionState`: remove `caret` and `caretIsCurrent` fields (and their doc comments).
  - `runTransition`: replace the anchor block with

```ts
    const viewportTop = oldLayer ? oldLayer.scrollTop : 0;
    const boxes = oldLayer ? mountedBoxes(oldLayer, source) : [];
    const anchorId = resolveAnchor(boxes, viewportTop);
```

  - `measureTargetTop`: return `topAlignScrollTop(box, { clientHeight, scrollHeight })` instead of `centerScrollTop(...)`; update its doc comment (it now top-aligns, used by the settle loop).
  - `topAlignedScrollTop` (⌘↓/⌘↑ / content-map helper): replace its inline `Math.min(Math.max(box.offsetTop - 24, 0), max)` with `topAlignScrollTop(box, { clientHeight, scrollHeight })` — one convention, one constant.
  - Imports: drop `centerScrollTop`, add `topAlignScrollTop`.
- [ ] **Step 4:** `npx vitest run src/ui/transition.test.ts src/ui/zoom-anchor-integration.test.ts` — PASS. (`src/ui` suite will still fail to typecheck until Task 3 fixes main.ts's `getZoomState` — main.ts is outside these test files; if vitest typechecking trips anyway, fold Task 3's `getZoomState` edit into this commit.)
- [ ] **Step 5:** Commit: `feat(viewport): top-edge anchoring + top-aligned landing for zoom transitions`

### Task 3: Remove `caretIsCurrent` from `main.ts`

**Files:**
- Modify: `src/main.ts` (lines ~118–126 variable, ~574 getZoomState, and write sites ~689, ~838–841, ~943, ~1123, ~1407–1418, ~1657)

**Interfaces:**
- Consumes: Task 2's slimmer `ZoomTransitionState`.

- [ ] **Step 1:** Delete the `caretIsCurrent` module variable + doc comment; drop `caret`/`caretIsCurrent` from `getZoomState()`'s returned object; delete every `caretIsCurrent = …` write. If the wheel listener (~line 838) does nothing else, remove the listener and its registration; same for any other write site that becomes an empty handler. Caret placement, focus mask, and arrow traversal stay untouched.
- [ ] **Step 2:** `npx tsc --noEmit` (or `npm run check` if that's the repo script) — expect clean; `npx vitest run` — full suite PASS.
- [ ] **Step 3:** Commit: `refactor(main): caret no longer steers zoom anchoring — caretIsCurrent removed`

### Task 4: Transient landing highlight

**Files:**
- Modify: `src/ui/viewport.ts` (settle path), `src/styles/reading.css` or new `src/styles/landing-highlight.css` (+ its import next to the other style imports)
- Test: `src/ui/transition.test.ts`

**Interfaces:**
- Consumes: `findNode(layer, level, id)` (already in viewport.ts), `prefersReducedMotion()`.

- [ ] **Step 1: Failing test** in `transition.test.ts`:

```ts
test('the landed node gets a transient data-landed mark, removed by the fallback timer', async () => {
  // fixture: transition 0 → -1 with a resolvable anchor (reuse existing fixture setup)
  await runToSettled(); // whatever helper the file already uses to drive rAF + transitionend
  const landed = viewport.querySelector('[data-landed]');
  expect(landed).not.toBeNull();
  expect(landed!.dataset.sid).toBe(expectedTargetSid);
  vi.advanceTimersByTime(1600); // jsdom fires no animationend — fallback path
  expect(viewport.querySelector('[data-landed]')).toBeNull();
});
```

- [ ] **Step 2:** Run — FAIL (no `data-landed` ever set).
- [ ] **Step 3: Implement.** In `runTransition`'s `finish()` (where `onSettled` fires), after the scroll settle kick-off:

```ts
        if (targetId && !prefersReducedMotion()) {
          const el = findNode(newLayer, target, targetId);
          if (el) {
            el.setAttribute('data-landed', '');
            const clear = () => el.removeAttribute('data-landed');
            el.addEventListener('animationend', clear, { once: true });
            setTimeout(clear, 1600); // jsdom / tab-hidden safety net
          }
        }
```

CSS (opacity only, D1):

```css
/* Transient landing highlight: shows what a zoom jump anchored to (spec
   2026-07-18). Fades via opacity ONLY (D1). position:relative carries no
   layout shift and is not animated. */
[data-landed] { position: relative; }
[data-landed]::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: 2px;
  background: var(--sz-accent);
  animation: sz-landing-fade 1s ease-out forwards;
  pointer-events: none;
}
@keyframes sz-landing-fade {
  from { opacity: 1; }
  to   { opacity: 0; }
}
```

- [ ] **Step 4:** `npx vitest run src/ui/transition.test.ts` — PASS.
- [ ] **Step 5:** Commit: `feat(viewport): transient landing highlight on zoom settle`

### Task 5: Amend `docs/Implementation_Plan.md` §2.5 + refresh its payload

**Files:**
- Modify: `docs/Implementation_Plan.md` (§2.5 anchor rule, centering math, D8 cross-references to "centering")

- [ ] **Step 1:** Rewrite §2.5's anchor-resolution rules (caret rule deleted; topmost-visible rule in), replace `centerScrollTop` code block with `topAlignScrollTop` (the Task 1 code, verbatim), adjust surrounding prose ("arrives already centered" → "arrives already top-aligned", etc.). Grep the whole doc for `centerScrollTop`, `caret always wins`, `nearest to center` and reconcile each hit. Reference the spec: `docs/superpowers/specs/2026-07-18-top-edge-anchoring-design.md`.
- [ ] **Step 2:** Refresh the embedded payload — the doc's prose changed, so its content-addressed IDs are stale: re-run the embed-zoom-payload pipeline (segment → update layers for changed blocks → assemble → `validate.mjs` → cargo `verify_payload`). Never hand-patch the JSON.
- [ ] **Step 3:** Commit: `docs: Implementation_Plan §2.5 — top-edge anchoring replaces centering (payload refreshed)`

### Task 6: Full verification + ship

- [ ] **Step 1:** `npx vitest run` (full suite) + `npx eslint src` + `npx tsc --noEmit` — all clean; `cargo test --manifest-path src-tauri/Cargo.toml` still green (payload round-trip tests).
- [ ] **Step 2:** Push branch, open draft PR titled `feat: top-edge zoom anchoring, caret demoted, landing highlight`, body links spec + notes the two flagged deviations (TOP_GAP 24 not 16; anything discovered en route) and the pending manual WebKit pass.
