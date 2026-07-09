# Semantic Zoom — Figma UI Refactor Plan

**Source design:** Figma `LBRJ4Nd6RFi2eNGx9YYTTG`, node `51:898` (three level mockups: `App - raw` 36:108, `App - section` 36:414, `App - story` 36:708). Each mockup is a 980px window — matching the app's window width.

**Goal:** Move the current (dark, top-toolbar) UI toward the Figma design (light, editorial, card-based, bottom zoom scrubber) **without touching the engine/state architecture** — this is a presentation-layer refactor (`src/ui/**` + `src/styles/**` + `index.html`). All Phase-1 invariants (D1–D8, three crossings, `engine/ui` Tauri-free, D7 keyed reconcile) stay intact.

---

## 1. What the design changes (gap analysis)

| Area | Current app | Figma target |
|---|---|---|
| **Theme** | Dark-first (`color-scheme: light dark`, dark screenshots) | **Light**: white rounded window, near-black ink `#0a0a0a`, muted `#717182` |
| **Type** | System font stack | **Inter** (Regular/Medium/Bold) + **Menlo** for IDs |
| **Window** | Overlay title bar, top toolbar strip | Rounded white window; **minimal top bar** — just traffic-light inset + an **"Updated" pill top-right** |
| **Zoom control** | Top 3-detent slider (`Raw/Sections/Story`) | **Bottom-center segmented pill** `[− -2 -1 0 +1 +2 +]` (a scrubber); active segment white+shadow |
| **Header** | Small `#status` word | Per-level **title + descriptive subtitle** ("Executive milestone view · 4 milestones · 25 sections") |
| **Milestone/section grouping** | Plain headings | **Cards** (`MetaCard`) with a tinted header (`M1` + title in blue), badge rows, and a **footer** ("N sections" + ID range) |
| **Story badges** | Filled pill badges (my Ask-3) | **Uppercase colored label + 4×14px rounded color "tick"** (no filled pill) |
| **Semantic colors** | Ad-hoc greens/blues | Accomplished `#008236`, Next Step `#2f58bc`, Blocker amber (~`#bb4d00`, confirm from 36:768) |
| **Focus spotlight** | Opacity dim on inactive `.pgroup` | Active card = **blue border** `rgba(32,32,254,0.5)` + full contrast; inactive cards **fade** |
| **Raw code/table** | Dark code block, zebra table | Same structure, **light** palette; keep table zebra/padding (Ask-4 already close) |
| **Footer counts** | none | Bottom-right context count ("4 milestones" / "N sections") beside the scrubber |

**Net:** the *structure* the app already produces (reading column, groups, summary cards, badges, focus, tables) maps 1:1 onto the design. This is mostly a **token + component-skin** change, plus **relocating the zoom control to a bottom scrubber** and adding **per-level headers + card chrome (footer/ID range)**.

---

## 2. Decisions (LOCKED — 2026-07-08)

- **D-A. Theme → light-first, keep dark.** Light values default (match Figma); retain a `@media (prefers-color-scheme: dark)` + `:root[data-theme="dark"]` mapping so dark users aren't regressed. The token layer (§3) carries both.
- **D-B. Scrubber `+1/+2` → shown DISABLED.** Build the bottom scrubber for `-2/-1/0` (the semantic levels). Render `+1/+2` greyed at 30% opacity exactly as the mockup does — they are **not wired**. **Content scale stays on the ⌘=/⌘-/⌘0 shortcuts only** (the existing `content-scale.ts`), independent of the scrubber. (Leaves the door open to wire them later without rework.)
- **D-C. Fonts → keep the system stack.** No Inter bundling. Use the current `-apple-system, BlinkMacSystemFont, 'Segoe UI', …` stack; Menlo/`ui-monospace` for IDs. Accept the minor feel difference from Inter. (`--sz-font` = system stack.)
- **D-D. Branch → continue on `worktree-phase1-plan`** alongside the Phase-1 work.

---

## 3. Design-token layer (new `src/styles/tokens.css`)

Extract everything to CSS custom properties so components stop hard-coding colors. Values are pulled verbatim from the Figma nodes.

```css
:root {
  /* surface / ink */
  --sz-bg:            #ffffff;   /* window content */
  --sz-ink:           #0a0a0a;   /* primary text */
  --sz-muted:         #717182;   /* secondary text, body copy in cards */
  --sz-muted-30:      rgba(113,113,130,0.30);
  --sz-muted-50:      rgba(113,113,130,0.50);
  --sz-border:        rgba(0,0,0,0.10);
  --sz-hairline:      rgba(0,0,0,0.04);
  --sz-card-head:     rgba(236,236,240,0.20);
  --sz-card-foot:     rgba(236,236,240,0.10);
  --sz-track:         #eceef2;   /* zoom scrubber track */

  /* accent + semantic */
  --sz-accent:        #2020fe;   /* milestone/active blue */
  --sz-accent-border: rgba(32,32,254,0.50);
  --sz-ok:            #008236;   /* Accomplished */
  --sz-info:          #2f58bc;   /* Next Step */
  --sz-warn:          #bb4d00;   /* Blocker (CONFIRM exact from node 36:768) */

  /* type (D-C: system stack, no Inter bundling) */
  --sz-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --sz-mono: 'Menlo', ui-monospace, SFMono-Regular, monospace;

  /* radii / shadow */
  --sz-radius-card: 14px;
  --sz-radius-pill: 999px;
  --sz-shadow-pill: 0 1px 1.5px rgba(0,0,0,0.1), 0 1px 1px rgba(0,0,0,0.1);
}
/* dark mapping (D-A): override the surface/ink/track vars under
   @media (prefers-color-scheme: dark) and :root[data-theme="dark"]. */
```

Then `base.css` / `reading.css` / `slider.css` are rewritten to consume `var(--sz-*)` instead of the current literal rgba values.

---

## 4. Component-by-component refactor

All changes are in `src/ui/**`, `src/styles/**`, `index.html`, and the two `main.ts` mount points — **no engine/state/anchor/reconcile changes**.

### 4.1 Window chrome + top bar — `index.html`, `base.css`
- White rounded content; the toolbar shrinks to a slim bar: **left inset** for traffic lights (already there), **remove the slider + Open button from the top**, keep only the **"Updated" pill** on the right (this replaces `status-badge`'s pill position — reuse `status-badge.ts`, restyle to the pill: light grey pill, green dot + "Updated").
- Open moves to **File → Open… (⌘O)** only (already exists) — the top Open button is removed (design has none). *(Keep it optionally behind a setting; the menu covers it.)*

### 4.2 Per-level header — new `src/ui/header.ts` (+ `header.css`)
- `mountHeader(root)` subscribes to `select(s => ({status, doc, zoom}))` and renders **title + subtitle** per level:
  - Title: the doc's story/plan title (from `meta`/first `M` node) — Inter Bold ~28px `--sz-ink`.
  - Subtitle: Inter ~14px `--sz-muted`, e.g. `Detail view · N paragraphs` / `Plain-English walkthrough · S sections across M milestones` / `Executive milestone view · M milestones · S sections`. Counts come from `table.order`.
- Tauri-free (reads store selectors only). Teardown returned; mounted in `main.ts`.

### 4.3 Bottom zoom scrubber — replace `slider.ts` → `src/ui/zoom-scrubber.ts` (+ rewrite `slider.css`)
- Structure from `ZoomSlider` (36:379): a fully-rounded track `--sz-track`, `--sz-border`, `--sz-shadow-pill`, `gap 4px`, `padding ~5px`; a `−` round button (32px), five segments `-2 -1 0 +1 +2`, a `+` round button.
- **Active segment**: white bg + `--sz-shadow-pill`, text `--sz-ink`. **Inactive**: text `--sz-muted`. **Disabled** (unavailable level / content-magnify off): `--sz-muted-30`.
- Position: `position: fixed`/absolute bottom-center over the viewport (a floating footer), with the **context count** ("N milestones/sections") bottom-right.
- **Behavior (per D-B):** segments `-2/-1/0` dispatch `zoomSet(level)` (existing); `−`/`+` step across the enabled `-2/-1/0` range. **`+1/+2` are rendered permanently disabled** (`--sz-muted-30`, non-interactive) — a visible affordance for future content-magnify, not wired. Content scale remains on ⌘=/⌘-/⌘0 only. Keep `disabledLevels` semantics for `-1/-2` on untagged/corrupt docs.
- **Migration note:** `mountSlider`'s API (`onChange`, `disabledLevels`, `active`) is reused as-is — only the markup/CSS change to the segmented pill and the two static disabled `+1/+2` cells are added. `main.ts` swaps `mountSliderForState()` internals only.

### 4.4 Story/Section cards — `viewport.ts` (`buildLevel` for −1/−2) + `reading.css`
- Wrap each `-2` meta group (and `-1` section group) in a **`MetaCard`**: `--sz-bg`, `1px --sz-border`, `--sz-radius-card`, `overflow: clip`.
  - **Header**: tinted `--sz-card-head`, bottom hairline; `M1` (Inter 14px, `--sz-accent`, uppercase, tracking .7px) + title (Inter Bold 14px, `--sz-accent`).
  - **Body**: the existing `renderSummaryBody` output, restyled (see 4.5).
  - **Footer**: `--sz-card-foot`, top hairline; left "N sections" (Inter 11px `--sz-muted`), a flexible hairline rule, right **ID range** `S-…… – S-……` (Menlo 10.5px `--sz-muted-50`). The ID range comes from the group's first/last child IDs — a small addition to `buildGroup`/the −1/−2 builders (data already in `table`).
- Keeps `data-sid`/`data-mid` for focus + reconcile — **D7 reconcile still works** (cards are the `.pgroup`).

### 4.5 Badges — `viewport.ts` `renderSummaryBody` + `reading.css`
- Replace the filled-pill badge with the design's **label+tick**: a row is `[tick] [LABEL] body`, where the tick is a `4px×14px` `--sz-radius(6px)` bar in the semantic color and the label is Inter Bold 12px uppercase tracking .62px in the same color; body is Inter 12px `--sz-muted`.
- Variant→color: `covers/overview`→accent, `done/accomplished`→`--sz-ok`, `blocker/risk`→`--sz-warn`, `next`→`--sz-info`, `prereq`→accent/muted. (Reuse the existing `badgeVariant()` mapping; only the CSS changes.) The current unit tests for `badgeVariant` still pass (logic unchanged).

### 4.6 Focus spotlight — `focus-mask.css` (+ `focus-mask.ts` unchanged)
- Active group: add **blue border** `--sz-accent-border` + full opacity. Inactive: keep the opacity fade (D1 — opacity-only transition preserved) and mute. This is a **CSS-only** change to the `[data-dimmed]` / active treatment; `focus-mask.ts` (§4.3 verbatim) stays as-is, so D1/opacity-only holds.

### 4.7 Raw code block + table — `reading.css`
- Re-skin to light: code block light-grey surface, syntax via the existing token custom props; table keeps the Ask-4 padding/zebra/borders but on light (`--sz-hairline` zebra, `--sz-border` grid). Mostly value swaps.

### 4.9 Content map sidebar (`location-in-document`) — NEW FEATURE
Figma node `63:2287` → component `58:2135`. A VS-Code-minimap-style document map.

**Spec (verbatim):** 32px-wide panel, `background:#fff`, `1px solid rgba(0,0,0,0.1)`, `border-radius:4px`, `box-shadow:0 1px 3px rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)`, `overflow:clip`, `display:flex; flex-direction:column; align-items:center; gap:6px; padding:5px`, positioned `left:12px` near the top of the content area.
- **Bars** = one per group: `height:2px; width:100%; border-radius:7px`. Inactive `#d5e0ff`, **active `#8080ff`**.
- **Separators (dots)** = `2×2px`, `#d5e0ff`, `border-radius:7px` — inserted at **milestone boundaries** (wherever `parentOfSection` changes). In the fixture this yields groups of 2/8/9/6 — matching the M1–M4 MetaCard section counts.
- **`position-indicator`** = a thin horizontal line across the panel, positioned by `scrollTop / (scrollHeight − clientHeight)`.
- Bars are clickable (cursor:pointer) → scroll the viewport to that group.
- A `Button - Minimize` exists in the design — **deferred** (follow-up).

**LOCKED semantics (2026-07-08):**
- **Active (purple `#8080ff`) = every group currently INTERSECTING the viewport** (visible-range highlight, like a minimap). Explains the two adjacent purple bars in the mockup.
- **Shown at all three levels.** Bars map to `order.sections` at k=0/−1 (with milestone separators) and to `order.meta` at k=−2 (no separators).
- **Minimize deferred.**

**Architecture constraints (must respect):**
- `renderLevel` does `container.replaceChildren()` on `#viewport`, so the map CANNOT be a child of `#viewport` (it'd be wiped every render). Wrap the viewport: `.viewport-wrap { position:relative }` containing `#viewport` and `<aside id="content-map">`.
- **Click-to-scroll writes must go through the single rAF `scrollCommands$` queue** (§3.2) — `main.ts` wires `onSelect(id)`; the map never writes scroll itself.
- The **indicator moves via `transform: translateY()`** (compositor-safe, no CSS transition) — never animate `top`/layout. D1 (opacity-only) stays intact.
- Scroll tracking: attach ONE listener on `#viewport` with `capture: true` (scroll doesn't bubble, but capture catches the `.level-layer`'s scroll), rAF-throttle, **read** metrics then **write** styles (read-then-write discipline).
- **Cache group boxes** (`offsetTop`/`offsetHeight`) after each render; the scroll handler then reads only `scrollTop`/`clientHeight`. Recompute the cache on doc/level change **and on content-scale change** (`zoom` alters offsets).
- Large docs: bars = groups (sections/milestones), not paragraphs, so counts stay modest. Shrink `gap` from 6px down to a 1px floor to fit the available height; if it still overflows, the panel scrolls internally.

**Pure, unit-testable core (`src/ui/content-map.ts`):**
- `buildMapModel(table, index, level): MapEntry[]` — `{kind:'bar', id}` | `{kind:'sep'}`.
- `visibleIds(boxes, scrollTop, clientHeight): Set<string>` — the visible-range highlight.
- `indicatorOffset(scrollTop, scrollHeight, clientHeight, trackH): number` — clamped.

### 4.8 Content-scale (already built) — keep
- `content-scale.ts` + ⌘=/⌘-/⌘0 stay. Under D-B they also back the scrubber's `+1/+2`. The `--content-scale` var continues to drive `zoom` on `.reading-column`.

---

## 5. Phased task breakdown (TDD where logic exists; visual where it doesn't)

1. **Tokens + theme skeleton** — add `tokens.css` (light defaults + dark `@media`/`data-theme` mapping, D-A); convert `base.css` to `var(--sz-*)`; keep the system `--sz-font` (D-C, no font assets). *Check:* build + existing tests green; app renders light. *(GUI eyeball.)*
2. **Window chrome + Updated pill** — trim toolbar; restyle `status-badge` pill top-right; drop top Open button (Open stays on ⌘O menu). *Check:* status-badge tests still pass (restyle only).
3. **Per-level header** — new `header.ts` + test (subtitle string from `table.order` counts is a pure function → unit-test it). *Check:* header test + build.
4. **Bottom zoom scrubber** — `zoom-scrubber.ts` replacing `slider.ts`; port slider tests (detents, disabled, active) to the new segmented-pill markup; add static disabled `+1/+2` cells (D-B); wire `main.ts`. *Check:* scrubber tests green; ⌘1/2/3 + scrubber agree.
5. **Story/Section cards + footer/ID range** — `buildLevel`/`buildGroup` card chrome; extend the summary tests; verify **reconcile still reuses card nodes** (existing reconcile test guards it). *Check:* viewport/summary/reconcile tests green.
6. **Badge label+tick restyle** — `renderSummaryBody` markup + CSS; keep `badgeVariant` logic/tests. *Check:* summary tests green.
7. **Focus blue-border + code/table light skin** — CSS only. *Check:* focus-mask test green (logic unchanged); Instruments spotlight still smooth (D1 opacity-only preserved).
8. **Polish pass** — spacing/rhythm vs Figma at each level; screenshot-compare (`get_screenshot` per node) to the three mockups. *(GUI.)*

Each step keeps `npm run ci` green; visual acceptance is a GUI eyeball against the matching Figma frame.

---

## 6. Invariants preserved (must not regress)

- **D1 opacity-only** transitions — focus/zoom crossfades unchanged; the new active-card *border* is an instant swap (not animated), consistent with the "instant class swap masked by crossfade" rule.
- **D7 keyed reconcile** — cards remain the `.pgroup[data-sid]` unit; the reconcile no-wipe test still guards it.
- **Three crossings** — no new Rust↔TS commands/events (menu/scale/scrubber are all frontend).
- **`engine/ui` Tauri-free** — header/scrubber/cards import only `state`/`engine` selectors; ESLint boundary holds.
- **Payload/fixture untouched** — pure presentation; the round-trip spine is unaffected.

---

## 7. Open items to confirm from Figma during build (cheap `get_design_context` fetches)

- Exact **Blocker amber** (node 36:768) and dimmed-card muted-blue.
- **Raw-level header/code/table** exact spacing (nodes under `App - raw` 36:108 / `Level0View` 36:109).
- The **`−`/`+` end-button icons** (asset URLs from `ZoomSlider`) — inline as SVG (no remote refs, per CSP).
- Whether `+1/+2` should be **enabled** (D-B) or rendered disabled as in the mockup.
