# Mermaid Diagram Support — Design

**Status:** Approved for planning
**Scope:** First-class rendering of Mermaid-fenced code blocks (`` ```mermaid ``) in both the Native (payload-driven) and Untagged (raw-markdown fallback) rendering paths, built as one instance of a modular diagram-format subsystem.

## 1. Problem

Mermaid code fences currently render as inert `<pre><code class="language-mermaid">` blocks (no highlighting, no diagram). The app should render them as live SVG diagrams with pan/zoom/node-selection, while treating the SVG purely as a presentation artifact — not as the thing other code (interaction, future AI actions) reasons about.

## 2. Architecture

```
src/ui/diagrams/
  provider.ts            # DiagramProvider interface + registry
  mermaid-provider.ts     # Mermaid implementation of DiagramProvider
  flowchart-graph.ts       # Minimal source-text parser → DiagramGraph (flowchart subset)
  sanitize-svg.ts          # DOMPurify wrapper, SVG profile
  diagram-cache.ts         # In-memory render cache, fnv1a-keyed
  diagram-component.ts     # Mounts provider output, owns svg-pan-zoom + click wiring + teardown
```

Everything lives under `src/ui/**`, so it already inherits the existing `no-restricted-imports` ESLint rule banning `@tauri-apps/*` — correct, since Mermaid rendering is entirely client-side and needs no Tauri crossing.

`viewport.ts`'s `decoratePnode()` and `raw-markdown.ts`'s equivalent decoration path both gain one check: when a fenced code block's `lang` is registered in the diagram registry, mount a `DiagramComponent` instead of (well, in addition to — see §5) the plain code chrome. Both native and raw-markdown paths already converge on `<pre><code class="language-X">`, so this one check point covers both, per your confirmed scope decision.

Adding a future format (D2, PlantUML, Graphviz) means writing one new `DiagramProvider` + one registry line. No changes to the two call sites.

## 3. The `DiagramProvider` interface

```ts
interface RenderOptions {
  theme: 'light' | 'dark';
}

interface DiagramGraph {
  nodes: { id: string; label: string; kind?: string; metadata?: Record<string, unknown> }[];
  edges: { id: string; from: string; to: string; label?: string; metadata?: Record<string, unknown> }[];
}

interface DiagramProvider {
  language: string;                              // e.g. 'mermaid'
  validate(source: string): { ok: true } | { ok: false; message: string };
  render(source: string, options: RenderOptions): Promise<string>;   // → sanitized SVG string
  extractGraph(source: string): DiagramGraph;      // synchronous, parses SOURCE TEXT, never SVG
}
```

Three deliberately separate operations, not one bundled `render()`:

- `validate` maps to Mermaid's own `mermaid.parse(source, { suppressErrors: true })`.
- `render` is async (Mermaid's `mermaid.render()` already is; future providers like a PlantUML server or a WASM Graphviz build may be too).
- `extractGraph` never touches the rendered SVG or Mermaid's internal render pipeline. It runs a small dedicated parser (`flowchart-graph.ts`) directly over the Mermaid *source text*, covering a defined v1 subset: `graph`/`flowchart` direction declarations, node definitions (`id[label]`, `id(label)`, `id{label}`), and edges (`A --> B`, `A -- label --> B`, `A --- B`). This is the architectural fix from the review: SVG stays pure presentation; the graph is derived independently from the same source of truth the diagram itself renders from, so it can never disagree with a Mermaid version bump or a renderer swap. Diagram types outside this subset (sequence, class, state, etc.) return `{ nodes: [], edges: [] }` in v1 — the diagram still renders and still pans/zooms, it just has no node-click graph to select against.

`registry.ts` is a plain `Map<string, DiagramProvider>`, registered once in `main.ts`. No speculative metadata fields (`supportsEditing`, `mime`, etc.) — nothing consumes them yet, and adding a field to a registry entry later is non-breaking, so there's no cost to deferring it.

## 4. Rendering pipeline & caching

```
source ──validate()──> ok/error
   │
   ├──render(source, {theme})──> mermaid.render() ──> sanitize-svg.ts ──> cached SVG
   │
   └──extractGraph(source)──> DiagramGraph (cheap, not cached — parse is trivial)
```

Cache: `Map<cacheKey, {svg, graph}>` in `diagram-cache.ts`, where `cacheKey = fnv1a(source + theme + mermaidVersion)`. A fast non-crypto hash, not SHA-256 — this is a same-process in-memory cache, not a content-addressing scheme. Including `theme` fixes a real gap: the app already has a light/dark theme switcher, and two renders of identical source under different themes must not collide in the cache. `mermaidVersion` is included so a future Mermaid upgrade can't serve a stale cached SVG rendered by the old version.

Re-render on source change is automatic, not something this subsystem manages directly: D7's keyed reconciliation already rebuilds a section's whole DOM subtree whenever any paragraph's content hash changes (content-hash IDs mean "ID unchanged" ⇒ "bytes unchanged"). The diagram's container is torn down and remounted as part of that; the cache is what keeps that cheap for diagrams whose source didn't actually change but whose section sibling did.

## 5. Source retention & view toggle

Source text is read from the code block's `textContent` — identical mechanism on both the Native and Untagged paths, since both ultimately produce a `<pre><code class="language-mermaid">` with the original text as its text node (neither `marked` nor `remark-rehype` lose bytes, only HTML-escape them, and `textContent` reverses that).

The existing expand/collapse chevron affordance already built for code blocks (`wrapCodeBlock()` in `viewport.ts`) is reused as a "view source" toggle: default view is the rendered diagram, toggling reveals the raw Mermaid text in a `<pre>`. This is UI reuse, not new chrome.

## 6. Sanitization

Two layers, because the app's CSP is disabled (`csp: null` in `tauri.conf.json`) and rendered SVG is live interactive DOM — materially higher risk than the existing static, escaped `<pre><code>` text path:

1. `mermaid.initialize({ securityLevel: 'strict', ... })` — disables Mermaid's own `click`-directive JS execution.
2. `sanitize-svg.ts` runs the rendered SVG string through DOMPurify (new dependency) with an SVG profile before any `innerHTML` insertion, stripping `<script>`, `on*` handlers, `foreignObject`, and `javascript:`/`data:` URLs in `href`/`xlink:href`.

## 7. Error state

`validate()` failing (or `render()` throwing) means: no SVG is inserted. The block falls back to the same plain-source `<pre><code>` rendering a normal code block would show, plus a small inline error badge carrying Mermaid's error message (visually consistent with the existing `status-badge.ts` pattern already in the codebase).

## 8. Interaction hooks

**Pan/zoom:** `svg-pan-zoom` (new dependency), one instance per mounted diagram, created and `.destroy()`'d entirely within `diagram-component.ts`'s mount/teardown — this is ephemeral, DOM-local view interaction, not app state, so it doesn't round-trip through the store (same pattern as `content-scale.ts`). No bespoke viewport wrapper API is built on top of it; `svg-pan-zoom`'s own `zoom`/`pan`/`reset`/`fit` methods are called directly. A cross-diagram-sync viewport API is explicitly out of scope until a feature actually needs it.

**Node click:** for diagrams with a non-empty `DiagramGraph`, each node's SVG group gets a click listener wired by `diagram-component.ts` (the provider itself knows nothing about viewport or DOM wiring — `extractGraph` only returns data). On click, dispatches a new store action:

```ts
diagramNodeSelected({ diagramId, nodeId, label })
```

added to the `Action` union in `store.ts` + a creator in `actions.ts`, following the existing `actions$.next(...)` dispatch pattern. This is intentionally inert in Phase 1 — same precedent as the Engine B stub (D3): the hook and event exist, nothing consumes it yet. Selection highlighting, if added later, is a CSS class toggled on the matching SVG node group driven by a selector reading `state.selectedDiagramNode` — no new overlay-layer system is built until a feature (tooltip, AI annotation) actually needs one.

## 9. Testing

Real `mermaid.render()` depends on `getBBox()`/layout behavior jsdom doesn't fully implement, so unit tests mock at the `DiagramProvider` boundary rather than exercising real Mermaid rendering:

- Registry dispatches to the correct provider by `lang`.
- `diagram-cache.ts` hit/miss behavior, including that a theme change produces a cache miss.
- `sanitize-svg.ts` strips `<script>`, `on*` handlers, and `foreignObject` from a crafted malicious SVG string.
- Error-state fallback: a provider whose `validate()` fails renders plain source + error badge, never calls `render()`.
- `flowchart-graph.ts` parses a handful of representative flowchart sources into the expected `DiagramGraph` shape (nodes/edges), and returns an empty graph for out-of-subset syntax without throwing.

Actual visual/interaction verification (real Mermaid rendering, pan/zoom feel, node click in a live WebView) needs a manual WebKit pass, per this project's existing verification pattern — flagged for the user to run, not claimed as done by this job.

## 10. New dependencies

`mermaid`, `dompurify` (+ `@types/dompurify`), `svg-pan-zoom` (+ `@types/svg-pan-zoom`).

## 11. Decisions log (from design review)

| # | Decision | Reasoning |
|---|---|---|
| 1 | Graph extraction parses Mermaid *source text* via a dedicated flowchart parser, never the rendered SVG DOM | SVG structure (class names like `.node`/`.edgePath`) is not Mermaid's stable public API and can change across releases; parsing source keeps the graph independent of both the renderer and its output format |
| 2 | Cache key is `fnv1a(source + theme + mermaidVersion)`, not raw source | Theme changes must invalidate the cache; a version bump must not serve a stale SVG |
| 3 | `DiagramProvider` splits `validate`/`render`/`extractGraph` into three methods, renamed from `DiagramRenderer` | Natural consequence of #1 — graph extraction is no longer part of the render step at all |
| 4 | Registry stays `lang → provider` with no speculative capability metadata | Nothing consumes `supportsEditing`/`mime`/etc. yet; adding fields later is non-breaking |
| 5 | No bespoke `DiagramViewport` wrapper API; `svg-pan-zoom`'s native methods are called directly | No current feature needs cross-diagram pan/zoom sync; the library already exposes what's needed |
| 6 | No overlay-layer stack (Selection/Tooltip/AI-Annotation layers) | Only requirement today is a node-click event; a CSS class toggle covers it |
