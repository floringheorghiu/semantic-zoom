# Mermaid Diagram Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `` ```mermaid `` fenced code blocks as live, sanitized, pan/zoomable SVG diagrams — in both the Native (payload) and Untagged (raw-markdown) rendering paths — while keeping the Mermaid source text as the only source of truth and deriving an app-owned `DiagramGraph` from that source text (never from the rendered SVG).

**Architecture:** A new `src/ui/diagrams/` module tree defines a `DiagramProvider` extension point (`validate`/`render`/`extractGraph`), a Mermaid implementation of it, a small dedicated flowchart-source parser for graph extraction, an SVG sanitizer (DOMPurify), and an in-memory render cache. `viewport.ts`'s existing `decoratePnode()` — already shared by both the native and raw-markdown rendering paths — gains one check: a registered-language code fence mounts a `DiagramComponent` (pan/zoom via `svg-pan-zoom`, node-click dispatching a new inert store action) instead of the plain code-block chrome.

**Tech Stack:** TypeScript, Vite, Vitest + jsdom, RxJS store (existing), `mermaid`, `dompurify`, `svg-pan-zoom`.

## Global Constraints

- No `@tauri-apps/*` imports anywhere under `src/engine/**` or `src/ui/**` (ESLint `no-restricted-imports`, `eslint.config.js:5-14`). All new diagram code lives under `src/ui/diagrams/**` and must stay Tauri-free.
- `DiagramGraph` extraction must parse Mermaid **source text**, never the rendered SVG DOM or Mermaid's internal render pipeline (design decision #1).
- Cache key must include render options (theme) and the Mermaid package version, not source text alone (design decision #2).
- No speculative/unused fields or methods (registry metadata, viewport wrapper API, overlay-layer stack) — YAGNI per CLAUDE.md (design decisions #4–#6).
- Every `mount()`-style function returns a teardown; nothing here holds state main.ts doesn't own or forgets to release (svg-pan-zoom instances must be `.destroy()`'d).
- `npm run ci` (lint + Rust tests + `npm test`) must stay green after every task.

---

### Task 1: `DiagramProvider` interface + registry

**Files:**
- Create: `src/ui/diagrams/provider.ts`
- Test: `src/ui/diagrams/provider.test.ts`

**Interfaces:**
- Produces: `RenderOptions { theme: 'light' | 'dark' }`, `DiagramGraphNode { id, label, kind?, metadata? }`, `DiagramGraphEdge { id, from, to, label?, metadata? }`, `DiagramGraph { nodes, edges }`, `DiagramProvider { language, validate, render, extractGraph }`, `registerDiagramProvider(provider)`, `getDiagramProvider(language)`, `clearDiagramProviders()`.

- [ ] **Step 1: Add dependencies**

Run: `npm install mermaid dompurify svg-pan-zoom && npm install -D @types/svg-pan-zoom`

(`mermaid` and `dompurify` ship their own TypeScript types; `svg-pan-zoom` needs the separate `@types` package.)

- [ ] **Step 2: Write the failing test**

```ts
// src/ui/diagrams/provider.test.ts
import { test, expect, beforeEach } from 'vitest';
import {
  registerDiagramProvider,
  getDiagramProvider,
  clearDiagramProviders,
  type DiagramProvider,
} from './provider';

beforeEach(() => clearDiagramProviders());

function stubProvider(language: string): DiagramProvider {
  return {
    language,
    validate: () => ({ ok: true }),
    render: async () => '<svg></svg>',
    extractGraph: () => ({ nodes: [], edges: [] }),
  };
}

test('getDiagramProvider returns undefined for an unregistered language', () => {
  expect(getDiagramProvider('mermaid')).toBeUndefined();
});

test('registerDiagramProvider makes a provider retrievable by its language', () => {
  const provider = stubProvider('mermaid');
  registerDiagramProvider(provider);
  expect(getDiagramProvider('mermaid')).toBe(provider);
});

test('registering a second provider for a different language does not clobber the first', () => {
  const mermaid = stubProvider('mermaid');
  const d2 = stubProvider('d2');
  registerDiagramProvider(mermaid);
  registerDiagramProvider(d2);
  expect(getDiagramProvider('mermaid')).toBe(mermaid);
  expect(getDiagramProvider('d2')).toBe(d2);
});

test('clearDiagramProviders empties the registry', () => {
  registerDiagramProvider(stubProvider('mermaid'));
  clearDiagramProviders();
  expect(getDiagramProvider('mermaid')).toBeUndefined();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/ui/diagrams/provider.test.ts`
Expected: FAIL — `./provider` has no exported member `registerDiagramProvider` (module doesn't exist yet).

- [ ] **Step 4: Write the implementation**

```ts
// src/ui/diagrams/provider.ts
//
// The extension point for AI-generated diagram formats (Mermaid first,
// others later — D2, PlantUML, Graphviz). A provider's `extractGraph` MUST
// parse the diagram's SOURCE TEXT, never the rendered SVG or the render
// pipeline's internals: SVG structure (class names, element ids) is not a
// stable public API for any of these tools, so treating it as one would
// silently break across a version bump. See
// docs/superpowers/specs/2026-07-21-mermaid-diagram-support-design.md §3.

export interface RenderOptions {
  theme: 'light' | 'dark';
}

export interface DiagramGraphNode {
  id: string;
  label: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export interface DiagramGraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface DiagramGraph {
  nodes: DiagramGraphNode[];
  edges: DiagramGraphEdge[];
}

export interface DiagramProvider {
  /** Matches the fenced code block's language, e.g. 'mermaid'. */
  language: string;
  /** Cheap syntax check — no rendering. */
  validate(source: string): { ok: true } | { ok: false; message: string };
  /** Returns a SANITIZED SVG string, ready for `innerHTML`. */
  render(source: string, options: RenderOptions): Promise<string>;
  /** Synchronous. Parses SOURCE TEXT — never the rendered SVG. */
  extractGraph(source: string): DiagramGraph;
}

const registry = new Map<string, DiagramProvider>();

export function registerDiagramProvider(provider: DiagramProvider): void {
  registry.set(provider.language, provider);
}

export function getDiagramProvider(language: string): DiagramProvider | undefined {
  return registry.get(language);
}

/** Test-only: reset the registry between test files/cases. */
export function clearDiagramProviders(): void {
  registry.clear();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/ui/diagrams/provider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/ui/diagrams/provider.ts src/ui/diagrams/provider.test.ts
git commit -m "diagrams: add DiagramProvider interface + registry"
```

---

### Task 2: Render cache (`fnv1a` hash + LRU cache)

**Files:**
- Create: `src/ui/diagrams/diagram-cache.ts`
- Test: `src/ui/diagrams/diagram-cache.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `fnv1a(input: string): string`, `cacheKey(source: string, theme: string, providerVersion: string): string`, `class DiagramCache { get(key): {svg: string} | undefined; set(key, value): void; clear(): void }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/diagrams/diagram-cache.test.ts
import { test, expect } from 'vitest';
import { fnv1a, cacheKey, DiagramCache } from './diagram-cache';

test('fnv1a is deterministic for the same input', () => {
  expect(fnv1a('graph TD; A-->B')).toBe(fnv1a('graph TD; A-->B'));
});

test('fnv1a differs for different input', () => {
  expect(fnv1a('graph TD; A-->B')).not.toBe(fnv1a('graph TD; A-->C'));
});

test('cacheKey differs when theme differs, same source', () => {
  const light = cacheKey('graph TD; A-->B', 'light', '10.9.0');
  const dark = cacheKey('graph TD; A-->B', 'dark', '10.9.0');
  expect(light).not.toBe(dark);
});

test('cacheKey differs when providerVersion differs, same source+theme', () => {
  const v1 = cacheKey('graph TD; A-->B', 'light', '10.9.0');
  const v2 = cacheKey('graph TD; A-->B', 'light', '10.9.1');
  expect(v1).not.toBe(v2);
});

test('DiagramCache: set then get returns the same value', () => {
  const cache = new DiagramCache();
  cache.set('k1', { svg: '<svg>1</svg>' });
  expect(cache.get('k1')).toEqual({ svg: '<svg>1</svg>' });
});

test('DiagramCache: miss returns undefined', () => {
  const cache = new DiagramCache();
  expect(cache.get('missing')).toBeUndefined();
});

test('DiagramCache: evicts the least-recently-used entry past its capacity', () => {
  const cache = new DiagramCache(2);
  cache.set('a', { svg: 'A' });
  cache.set('b', { svg: 'B' });
  cache.get('a'); // 'a' is now more recently used than 'b'
  cache.set('c', { svg: 'C' }); // over capacity → evict 'b', the least recently used
  expect(cache.get('a')).toEqual({ svg: 'A' });
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('c')).toEqual({ svg: 'C' });
});

test('DiagramCache: clear empties it', () => {
  const cache = new DiagramCache();
  cache.set('k1', { svg: '<svg>1</svg>' });
  cache.clear();
  expect(cache.get('k1')).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/diagrams/diagram-cache.test.ts`
Expected: FAIL — module `./diagram-cache` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/diagrams/diagram-cache.ts
//
// A same-process, in-memory cache for rendered diagram SVGs. Keyed by a fast
// NON-cryptographic hash (FNV-1a) of source + render options + the Mermaid
// package version — never source text alone, since two renders of identical
// source under a different theme (the app already has a light/dark switcher)
// or a Mermaid upgrade must not collide (design decision #2).

export interface DiagramRenderResult {
  svg: string;
}

/** FNV-1a, 32-bit. Cache keys only — never used anywhere security-sensitive. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function cacheKey(source: string, theme: string, providerVersion: string): string {
  return fnv1a(`${source}|${theme}|${providerVersion}`);
}

const DEFAULT_MAX_ENTRIES = 50;

/** Simple LRU: `Map` iteration order is insertion order, so re-inserting on
    every touch keeps the least-recently-used entry first (evict from front). */
export class DiagramCache {
  private map = new Map<string, DiagramRenderResult>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(key: string): DiagramRenderResult | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit); // refresh recency
    }
    return hit;
  }

  set(key: string, value: DiagramRenderResult): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/diagrams/diagram-cache.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/diagrams/diagram-cache.ts src/ui/diagrams/diagram-cache.test.ts
git commit -m "diagrams: add fnv1a-keyed LRU render cache"
```

---

### Task 3: SVG sanitizer

**Files:**
- Create: `src/ui/diagrams/sanitize-svg.ts`
- Test: `src/ui/diagrams/sanitize-svg.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `sanitizeSvg(svg: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/diagrams/sanitize-svg.test.ts
import { test, expect } from 'vitest';
import { sanitizeSvg } from './sanitize-svg';

test('strips <script> tags', () => {
  const dirty = '<svg><script>alert(1)</script><rect width="10" height="10"/></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('<script');
  expect(clean).not.toContain('alert(1)');
  expect(clean).toContain('<rect');
});

test('strips onclick/onload event handler attributes', () => {
  const dirty = '<svg><rect onclick="alert(1)" width="10" height="10"/></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('onclick');
});

test('strips <foreignObject> (a known SVG XSS vector)', () => {
  const dirty = '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml" onload="alert(1)"/></foreignObject></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('foreignObject');
  expect(clean).not.toContain('onload');
});

test('strips javascript: URLs from href', () => {
  const dirty = '<svg><a href="javascript:alert(1)"><text>click</text></a></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('javascript:');
});

test('keeps benign SVG structure and attributes intact', () => {
  const benign = '<svg width="100" height="50"><g class="node"><rect width="10" height="10"/><text>A</text></g></svg>';
  const clean = sanitizeSvg(benign);
  expect(clean).toContain('<rect');
  expect(clean).toContain('<text');
  expect(clean).toContain('class="node"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/diagrams/sanitize-svg.test.ts`
Expected: FAIL — module `./sanitize-svg` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/diagrams/sanitize-svg.ts
//
// Mermaid's SVG output is live, interactive DOM inserted via `innerHTML` —
// materially higher risk than the app's existing static, HTML-escaped
// <pre><code> code-block path, and the app's CSP is disabled entirely
// (src-tauri/tauri.conf.json: "csp": null), so this sanitization is a real
// gate, not a backstop. `mermaid.initialize({ securityLevel: 'strict' })`
// (Task 5) additionally disables Mermaid's own click-directive JS execution
// at the source; this is the second, independent layer.
import DOMPurify from 'dompurify';

export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Explicit defense-in-depth on top of DOMPurify's SVG profile defaults
    // (which already exclude <script> and event-handler attributes).
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onclick', 'onerror', 'onmouseover'],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/diagrams/sanitize-svg.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/diagrams/sanitize-svg.ts src/ui/diagrams/sanitize-svg.test.ts
git commit -m "diagrams: add DOMPurify SVG sanitizer"
```

---

### Task 4: Flowchart source-text graph parser

**Files:**
- Create: `src/ui/diagrams/flowchart-graph.ts`
- Test: `src/ui/diagrams/flowchart-graph.test.ts`

**Interfaces:**
- Consumes: `DiagramGraph`, `DiagramGraphNode`, `DiagramGraphEdge` from `./provider` (Task 1).
- Produces: `parseFlowchart(source: string): DiagramGraph`.

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/diagrams/flowchart-graph.test.ts
import { test, expect } from 'vitest';
import { parseFlowchart } from './flowchart-graph';

test('parses node definitions with each shape delimiter', () => {
  const source = 'flowchart TD\nA[Start]\nB(Round)\nC{Decision}';
  const graph = parseFlowchart(source);
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      { id: 'A', label: 'Start' },
      { id: 'B', label: 'Round' },
      { id: 'C', label: 'Decision' },
    ]),
  );
  expect(graph.edges).toEqual([]);
});

test('parses a plain arrow edge and infers both endpoint nodes', () => {
  const source = 'graph TD\nA[Start] --> B[End]';
  const graph = parseFlowchart(source);
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      { id: 'A', label: 'Start' },
      { id: 'B', label: 'End' },
    ]),
  );
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({ from: 'A', to: 'B', label: undefined });
});

test('parses a labeled edge', () => {
  const source = 'graph TD\nB{Decision} -- yes --> C[End]';
  const graph = parseFlowchart(source);
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({ from: 'B', to: 'C', label: 'yes' });
});

test('parses a plain (no-arrowhead) edge', () => {
  const source = 'graph TD\nA --- B';
  const graph = parseFlowchart(source);
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({ from: 'A', to: 'B' });
});

test('a realistic multi-line flowchart produces the expected node/edge counts', () => {
  const source = [
    'flowchart TD',
    'A[Start] --> B{Decision}',
    'B -- yes --> C[End]',
    'B -- no --> D[Retry]',
    'D --> B',
  ].join('\n');
  const graph = parseFlowchart(source);
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C', 'D']);
  expect(graph.edges).toHaveLength(4);
});

test('out-of-subset syntax (e.g. a sequence diagram) yields an empty graph without throwing', () => {
  const source = 'sequenceDiagram\n  Alice->>Bob: Hello Bob';
  expect(() => parseFlowchart(source)).not.toThrow();
  const graph = parseFlowchart(source);
  expect(graph.nodes).toEqual([]);
  expect(graph.edges).toEqual([]);
});

test('empty source yields an empty graph', () => {
  expect(parseFlowchart('')).toEqual({ nodes: [], edges: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/diagrams/flowchart-graph.test.ts`
Expected: FAIL — module `./flowchart-graph` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/diagrams/flowchart-graph.ts
//
// A minimal, DELIBERATELY PARTIAL parser for the Mermaid flowchart/graph
// source-text subset: `graph`/`flowchart` direction lines, node definitions
// (`id[label]` / `id(label)` / `id{label}`), and edges (`A --> B`,
// `A -- label --> B`, `A --- B`). Diagram types outside this subset are
// never routed here (see mermaid-provider.ts's extractGraph) — this is not
// a general Mermaid grammar, and any line it doesn't recognize is silently
// ignored rather than throwing, so it degrades to an empty graph instead of
// crashing on syntax it doesn't understand.
//
// Parses SOURCE TEXT ONLY — see provider.ts's module doc for why this must
// never read the rendered SVG.
import type { DiagramGraph, DiagramGraphNode, DiagramGraphEdge } from './provider';

const SHAPE_RE = /^(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})$/;
const ID_RE = '[A-Za-z0-9_-]+';
const SHAPE_GROUP = '(\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\})?';

const NODE_ONLY_RE = new RegExp(`^(${ID_RE})${SHAPE_GROUP}$`);
const LABELED_ARROW_RE = new RegExp(
  `^(${ID_RE})${SHAPE_GROUP}\\s*--\\s*(.+?)\\s*-->\\s*(${ID_RE})${SHAPE_GROUP}$`,
);
const PLAIN_ARROW_RE = new RegExp(`^(${ID_RE})${SHAPE_GROUP}\\s*-->\\s*(${ID_RE})${SHAPE_GROUP}$`);
const PLAIN_LINE_RE = new RegExp(`^(${ID_RE})${SHAPE_GROUP}\\s*---\\s*(${ID_RE})${SHAPE_GROUP}$`);

function labelFromShape(shape: string | undefined, id: string): string {
  if (!shape || !SHAPE_RE.test(shape)) return id;
  const inner = shape.slice(1, -1).trim();
  return inner || id;
}

export function parseFlowchart(source: string): DiagramGraph {
  const nodes = new Map<string, DiagramGraphNode>();
  const edges: DiagramGraphEdge[] = [];
  let edgeOrdinal = 0;

  const upsert = (id: string, shape?: string): void => {
    if (!nodes.has(id) || shape) {
      nodes.set(id, { id, label: labelFromShape(shape, id) });
    }
  };

  const lines = source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(graph|flowchart)\b/i.test(l));

  for (const line of lines) {
    const labeled = line.match(LABELED_ARROW_RE);
    if (labeled) {
      const [, fromId, fromShape, label, toId, toShape] = labeled;
      upsert(fromId, fromShape);
      upsert(toId, toShape);
      edges.push({ id: `E-${edgeOrdinal++}`, from: fromId, to: toId, label: label.trim() || undefined });
      continue;
    }

    const plainArrow = line.match(PLAIN_ARROW_RE);
    if (plainArrow) {
      const [, fromId, fromShape, toId, toShape] = plainArrow;
      upsert(fromId, fromShape);
      upsert(toId, toShape);
      edges.push({ id: `E-${edgeOrdinal++}`, from: fromId, to: toId, label: undefined });
      continue;
    }

    const plainLine = line.match(PLAIN_LINE_RE);
    if (plainLine) {
      const [, fromId, fromShape, toId, toShape] = plainLine;
      upsert(fromId, fromShape);
      upsert(toId, toShape);
      edges.push({ id: `E-${edgeOrdinal++}`, from: fromId, to: toId, label: undefined });
      continue;
    }

    const nodeOnly = line.match(NODE_ONLY_RE);
    if (nodeOnly) {
      const [, id, shape] = nodeOnly;
      upsert(id, shape);
    }
    // Anything else (subgraph blocks, styling directives, other diagram
    // types entirely) is silently ignored — see module doc.
  }

  return { nodes: Array.from(nodes.values()), edges };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/diagrams/flowchart-graph.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/diagrams/flowchart-graph.ts src/ui/diagrams/flowchart-graph.test.ts
git commit -m "diagrams: add source-text flowchart graph parser"
```

---

### Task 5: Mermaid `DiagramProvider` implementation

**Files:**
- Create: `src/ui/diagrams/mermaid-provider.ts`
- Test: `src/ui/diagrams/mermaid-provider.test.ts`

**Interfaces:**
- Consumes: `DiagramProvider`, `RenderOptions` (`./provider`, Task 1); `cacheKey`, `DiagramCache` (`./diagram-cache`, Task 2); `sanitizeSvg` (`./sanitize-svg`, Task 3); `parseFlowchart` (`./flowchart-graph`, Task 4); `mermaid` (npm package).
- Produces: `mermaidProvider: DiagramProvider` (`language: 'mermaid'`).

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/diagrams/mermaid-provider.test.ts
import { test, expect, vi, beforeEach } from 'vitest';

// mermaid.render performs real layout Mermaid needs `getBBox` for, which
// jsdom doesn't implement — mock the library boundary rather than exercising
// real rendering (see design spec §9). This also keeps these tests fast and
// deterministic, independent of Mermaid's actual SVG output.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(),
    render: vi.fn(),
  },
}));

import mermaid from 'mermaid';
import { mermaidProvider } from './mermaid-provider';

beforeEach(() => {
  vi.clearAllMocks();
});

test('language is "mermaid"', () => {
  expect(mermaidProvider.language).toBe('mermaid');
});

test('validate: ok when mermaid.parse succeeds', () => {
  vi.mocked(mermaid.parse).mockReturnValue(true as unknown as ReturnType<typeof mermaid.parse>);
  expect(mermaidProvider.validate('graph TD; A-->B')).toEqual({ ok: true });
});

test('validate: not ok when mermaid.parse returns false', () => {
  vi.mocked(mermaid.parse).mockReturnValue(false as unknown as ReturnType<typeof mermaid.parse>);
  const result = mermaidProvider.validate('not a diagram');
  expect(result.ok).toBe(false);
});

test('validate: not ok when mermaid.parse throws', () => {
  vi.mocked(mermaid.parse).mockImplementation(() => {
    throw new Error('Parse error on line 1');
  });
  const result = mermaidProvider.validate('garbage');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('Parse error on line 1');
});

test('render: calls mermaid.render and returns a sanitized SVG', async () => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg><script>bad</script><rect/></svg>' });
  const svg = await mermaidProvider.render('graph TD; A-->B', { theme: 'light' });
  expect(svg).toContain('<rect');
  expect(svg).not.toContain('<script');
});

test('render: a second call with identical source+theme does not call mermaid.render again (cache hit)', async () => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg><rect/></svg>' });
  await mermaidProvider.render('graph TD; A-->B', { theme: 'light' });
  await mermaidProvider.render('graph TD; A-->B', { theme: 'light' });
  expect(mermaid.render).toHaveBeenCalledTimes(1);
});

test('render: a different theme is a cache miss even with identical source', async () => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg><rect/></svg>' });
  await mermaidProvider.render('graph TD; A-->B', { theme: 'light' });
  await mermaidProvider.render('graph TD; A-->B', { theme: 'dark' });
  expect(mermaid.render).toHaveBeenCalledTimes(2);
});

test('extractGraph: flowchart source parses into nodes/edges', () => {
  const graph = mermaidProvider.extractGraph('graph TD\nA[Start] --> B[End]');
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      { id: 'A', label: 'Start' },
      { id: 'B', label: 'End' },
    ]),
  );
  expect(graph.edges).toHaveLength(1);
});

test('extractGraph: non-flowchart source returns an empty graph', () => {
  const graph = mermaidProvider.extractGraph('sequenceDiagram\n  Alice->>Bob: Hello');
  expect(graph).toEqual({ nodes: [], edges: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/diagrams/mermaid-provider.test.ts`
Expected: FAIL — module `./mermaid-provider` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/diagrams/mermaid-provider.ts
import mermaid from 'mermaid';
import type { DiagramProvider, RenderOptions, DiagramGraph } from './provider';
import { cacheKey, DiagramCache } from './diagram-cache';
import { sanitizeSvg } from './sanitize-svg';
import { parseFlowchart } from './flowchart-graph';

// Bundled by npm, not read from mermaid's runtime — a fixed string is fine:
// it only needs to change (invalidating the cache) when this package.json
// dependency is bumped, which is exactly when this literal is edited too.
const MERMAID_VERSION = '11';

const cache = new DiagramCache();
let renderCounter = 0;

function extractGraph(source: string): DiagramGraph {
  const firstLine = source.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!/^(graph|flowchart)\b/i.test(firstLine)) return { nodes: [], edges: [] };
  return parseFlowchart(source);
}

function validate(source: string): { ok: true } | { ok: false; message: string } {
  try {
    const result = mermaid.parse(source, { suppressErrors: true });
    if (result === false) return { ok: false, message: 'Could not parse diagram' };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function render(source: string, options: RenderOptions): Promise<string> {
  const key = cacheKey(source, options.theme, MERMAID_VERSION);
  const cached = cache.get(key);
  if (cached) return cached.svg;

  // securityLevel 'strict' disables Mermaid's own click-directive JS
  // execution — the first of two independent sanitization layers (the
  // second is sanitizeSvg below). See sanitize-svg.ts's module doc.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: options.theme === 'dark' ? 'dark' : 'default',
  });

  const renderId = `mermaid-diagram-${renderCounter++}`;
  const { svg } = await mermaid.render(renderId, source);
  const sanitized = sanitizeSvg(svg);
  cache.set(key, { svg: sanitized });
  return sanitized;
}

export const mermaidProvider: DiagramProvider = {
  language: 'mermaid',
  validate,
  render,
  extractGraph,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/diagrams/mermaid-provider.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/diagrams/mermaid-provider.ts src/ui/diagrams/mermaid-provider.test.ts
git commit -m "diagrams: add Mermaid DiagramProvider implementation"
```

---

### Task 6: `diagramNodeSelected` store action

**Files:**
- Modify: `src/state/store.ts`
- Modify: `src/state/actions.ts`
- Modify: `src/state/store.test.ts`

**Interfaces:**
- Produces: `Action` union gains `{ type: 'DIAGRAM_NODE_SELECTED'; diagramId: string; nodeId: string; label: string }`; `AppState` gains `selectedDiagramNode: { diagramId: string; nodeId: string; label: string } | null`; `diagramNodeSelected(diagramId, nodeId, label): Action` in `actions.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/state/store.test.ts` (open the file first to match its existing import style before appending):

```ts
test('DIAGRAM_NODE_SELECTED sets selectedDiagramNode', () => {
  const s0 = reduce(initialStateForTest(), {
    type: 'DIAGRAM_NODE_SELECTED',
    diagramId: 'diagram-1',
    nodeId: 'A',
    label: 'Start',
  });
  expect(s0.selectedDiagramNode).toEqual({ diagramId: 'diagram-1', nodeId: 'A', label: 'Start' });
});

test('DIAGRAM_NODE_SELECTED does not touch unrelated state', () => {
  const before = initialStateForTest();
  const after = reduce(before, {
    type: 'DIAGRAM_NODE_SELECTED',
    diagramId: 'diagram-1',
    nodeId: 'A',
    label: 'Start',
  });
  expect(after.zoom).toBe(before.zoom);
  expect(after.doc).toBe(before.doc);
});
```

(If `store.test.ts` doesn't already export/define an `initialStateForTest()` helper, use whatever helper the existing tests in that file use to get a base `AppState` — check the file's existing tests for the pattern before writing this step for real, since this plan can't see `store.test.ts`'s current contents.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/store.test.ts`
Expected: FAIL — TypeScript error, `'DIAGRAM_NODE_SELECTED'` is not assignable to `Action['type']`.

- [ ] **Step 3: Write the implementation**

In `src/state/store.ts`, add `selectedDiagramNode` to `AppState` (after `providerConfigured`, line 28):

```ts
  providerConfigured: boolean;
  /** Set by a diagram node click (src/ui/diagrams/diagram-component.ts).
      Inert in Phase 1 — no reducer/UI consumes it yet, same precedent as
      the Engine B stub (D3): the hook and event exist, nothing acts on it. */
  selectedDiagramNode: { diagramId: string; nodeId: string; label: string } | null;
}
```

Add the action variant to the `Action` union (after `SYNTHESIS_FAILED`, line 40):

```ts
  | { type: 'SYNTHESIS_FAILED'; error: string }
  | { type: 'DIAGRAM_NODE_SELECTED'; diagramId: string; nodeId: string; label: string };
```

Add the initial value (in `initial`, after `providerConfigured: false,` at line 47):

```ts
  providerConfigured: false,
  selectedDiagramNode: null,
};
```

Add the reducer case (anywhere in the `switch`, e.g. right before the closing `}` of the `reduce` function):

```ts
    case 'DIAGRAM_NODE_SELECTED':
      return {
        ...s,
        selectedDiagramNode: { diagramId: a.diagramId, nodeId: a.nodeId, label: a.label },
      };
  }
}
```

In `src/state/actions.ts`, add after `synthesisFailed` (line 34):

```ts
export const diagramNodeSelected = (diagramId: string, nodeId: string, label: string): Action => ({
  type: 'DIAGRAM_NODE_SELECTED',
  diagramId,
  nodeId,
  label,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/store.ts src/state/actions.ts src/state/store.test.ts
git commit -m "state: add inert DIAGRAM_NODE_SELECTED action"
```

---

### Task 7: `DiagramComponent` — mounts a provider's output, owns pan/zoom + click wiring

**Files:**
- Create: `src/ui/diagrams/diagram-component.ts`
- Test: `src/ui/diagrams/diagram-component.test.ts`
- Create: `src/styles/diagrams.css`

**Interfaces:**
- Consumes: `getDiagramProvider` (`./provider`, Task 1); `actions$` (`../../state/store`); `diagramNodeSelected` (`../../state/actions`, Task 6).
- Produces: `mountDiagram(pre: HTMLElement, lang: string): DiagramMountHandle | null`, `DiagramMountHandle { teardown(): void }`, `teardownDiagramsIn(root: ParentNode): void`.

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/diagrams/diagram-component.test.ts
import { test, expect, vi, beforeEach } from 'vitest';

const panZoomInstances: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
vi.mock('svg-pan-zoom', () => ({
  default: vi.fn(() => {
    const instance = { destroy: vi.fn() };
    panZoomInstances.push(instance);
    return instance;
  }),
}));

import {
  registerDiagramProvider,
  clearDiagramProviders,
  type DiagramProvider,
} from './provider';
import { mountDiagram, teardownDiagramsIn } from './diagram-component';
import { actions$ } from '../../state/store';

function stubProvider(overrides: Partial<DiagramProvider> = {}): DiagramProvider {
  return {
    language: 'mermaid',
    validate: () => ({ ok: true }),
    render: async () => '<svg><g id="flowchart-A-0"><text>Start</text></g></svg>',
    extractGraph: () => ({ nodes: [{ id: 'A', label: 'Start' }], edges: [] }),
    ...overrides,
  };
}

function makePre(source: string): HTMLElement {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  document.body.appendChild(pre);
  return pre;
}

beforeEach(() => {
  clearDiagramProviders();
  panZoomInstances.length = 0;
  document.body.replaceChildren();
});

test('returns null and leaves the <pre> untouched for an unregistered language', () => {
  const pre = makePre('graph TD; A-->B');
  const handle = mountDiagram(pre, 'python');
  expect(handle).toBeNull();
  expect(document.body.contains(pre)).toBe(true);
});

test('replaces the <pre> with a .diagram container for a registered language', () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  expect(document.body.contains(pre)).toBe(false);
  expect(document.body.querySelector('.diagram')).toBeTruthy();
});

test('after the async render resolves, the sanitized SVG is in the DOM and svg-pan-zoom was instantiated', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('.diagram__svg-host svg')).toBeTruthy();
  });
  expect(panZoomInstances).toHaveLength(1);
});

test('a validate() failure shows the error badge and the source, never inserts SVG', async () => {
  registerDiagramProvider(
    stubProvider({ validate: () => ({ ok: false, message: 'bad syntax' }) }),
  );
  const pre = makePre('not a diagram');
  mountDiagram(pre, 'mermaid');
  const errorEl = document.body.querySelector('.diagram__error');
  expect(errorEl?.textContent).toContain('bad syntax');
  expect(document.body.querySelector('.diagram__svg-host svg')).toBeNull();
  const sourceEl = document.body.querySelector<HTMLElement>('.diagram__source');
  expect(sourceEl?.hidden).toBe(false);
  expect(sourceEl?.textContent).toContain('not a diagram');
});

test('a render() rejection shows the error badge', async () => {
  registerDiagramProvider(
    stubProvider({ render: async () => { throw new Error('render exploded'); } }),
  );
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('.diagram__error')?.textContent).toContain('render exploded');
  });
});

test('the source toggle reveals and re-hides the raw source', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('.diagram__svg-host svg')).toBeTruthy();
  });
  const toggle = document.body.querySelector<HTMLButtonElement>('.diagram__source-toggle')!;
  const sourceEl = document.body.querySelector<HTMLElement>('.diagram__source')!;
  expect(sourceEl.hidden).toBe(true);
  toggle.click();
  expect(sourceEl.hidden).toBe(false);
  toggle.click();
  expect(sourceEl.hidden).toBe(true);
});

test('clicking a mapped graph node dispatches DIAGRAM_NODE_SELECTED', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('#flowchart-A-0')).toBeTruthy();
  });
  const dispatched: unknown[] = [];
  const sub = actions$.subscribe((a) => dispatched.push(a));
  document.body.querySelector<SVGElement>('#flowchart-A-0')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  sub.unsubscribe();
  expect(dispatched).toContainEqual(
    expect.objectContaining({ type: 'DIAGRAM_NODE_SELECTED', nodeId: 'A', label: 'Start' }),
  );
});

test('teardown destroys the svg-pan-zoom instance', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  const handle = mountDiagram(pre, 'mermaid')!;
  await vi.waitFor(() => {
    expect(panZoomInstances).toHaveLength(1);
  });
  handle.teardown();
  expect(panZoomInstances[0].destroy).toHaveBeenCalledTimes(1);
});

test('teardownDiagramsIn finds and tears down every diagram under a root', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(panZoomInstances).toHaveLength(1);
  });
  teardownDiagramsIn(document.body);
  expect(panZoomInstances[0].destroy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/diagrams/diagram-component.test.ts`
Expected: FAIL — module `./diagram-component` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/diagrams/diagram-component.ts
//
// Mounts one DiagramProvider's output in place of a plain code block's
// <pre>: renders the SVG, wires svg-pan-zoom (pan/zoom is ephemeral,
// DOM-local view interaction — it never touches the store, same pattern as
// content-scale.ts), and — for diagrams with a non-empty DiagramGraph —
// attaches a click listener per node that dispatches DIAGRAM_NODE_SELECTED.
// The provider itself knows nothing about viewport/DOM wiring; this module
// is the only place that does.
import svgPanZoom from 'svg-pan-zoom';
import type { SvgPanZoom } from 'svg-pan-zoom';
import { getDiagramProvider, type DiagramGraph } from './provider';
import { actions$ } from '../../state/store';
import { diagramNodeSelected } from '../../state/actions';

export interface DiagramMountHandle {
  teardown: () => void;
}

let diagramSeq = 0;
/** container element → its teardown, so `teardownDiagramsIn` can find and
    release every mounted diagram under a subtree being torn down (D7 keyed
    reconciliation removes stale `.pgroup` nodes without knowing what's
    inside them). */
const handles = new WeakMap<HTMLElement, DiagramMountHandle>();

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * Best-effort match of a DiagramGraph node id to the SVG element Mermaid
 * rendered for it. Mermaid's node-group ids aren't a stable public API
 * (hence the graph is parsed from SOURCE, not this SVG — see provider.ts) —
 * this lookup is soft-fail: if a future Mermaid version changes its id
 * scheme, matching nodes here simply get no click listener; rendering,
 * pan, and zoom are unaffected either way.
 */
function findGraphNodeElement(svgEl: SVGSVGElement, nodeId: string): SVGElement | null {
  return (
    svgEl.querySelector<SVGElement>(`[id$="-${nodeId}-0"]`) ??
    svgEl.querySelector<SVGElement>(`[id$="-${nodeId}"]`) ??
    svgEl.querySelector<SVGElement>(`[id="${nodeId}"]`)
  );
}

export function mountDiagram(pre: HTMLElement, lang: string): DiagramMountHandle | null {
  const provider = getDiagramProvider(lang);
  if (!provider) return null;

  const source = pre.querySelector('code')?.textContent ?? '';
  const diagramId = `diagram-${++diagramSeq}`;

  const container = document.createElement('div');
  container.className = 'diagram';
  container.dataset.diagramId = diagramId;
  pre.replaceWith(container);

  const svgHost = document.createElement('div');
  svgHost.className = 'diagram__svg-host';
  container.appendChild(svgHost);

  const errorBadge = document.createElement('div');
  errorBadge.className = 'diagram__error';
  errorBadge.hidden = true;
  container.appendChild(errorBadge);

  const sourcePre = document.createElement('pre');
  sourcePre.className = 'diagram__source';
  sourcePre.hidden = true;
  const sourceCode = document.createElement('code');
  sourceCode.textContent = source;
  sourcePre.appendChild(sourceCode);
  container.appendChild(sourcePre);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'diagram__source-toggle';
  toggle.textContent = 'View source';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const nowHidden = !sourcePre.hidden;
    sourcePre.hidden = nowHidden;
    toggle.setAttribute('aria-expanded', String(!nowHidden));
    toggle.textContent = nowHidden ? 'View source' : 'View diagram';
  });
  container.appendChild(toggle);

  let panZoomInstance: SvgPanZoom.Instance | null = null;
  let destroyed = false;

  function showError(message: string): void {
    svgHost.hidden = true;
    errorBadge.hidden = false;
    errorBadge.textContent = `Diagram error: ${message}`;
    sourcePre.hidden = false;
    toggle.hidden = true; // nothing to toggle to — source is the only view
  }

  function wireGraphClicks(graph: DiagramGraph, svgEl: SVGSVGElement): void {
    for (const node of graph.nodes) {
      const el = findGraphNodeElement(svgEl, node.id);
      if (!el) continue;
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        actions$.next(diagramNodeSelected(diagramId, node.id, node.label));
      });
    }
  }

  const validation = provider.validate(source);
  if (!validation.ok) {
    showError(validation.message);
  } else {
    provider
      .render(source, { theme: currentTheme() })
      .then((svg) => {
        if (destroyed) return;
        svgHost.hidden = false;
        svgHost.innerHTML = svg;
        const svgEl = svgHost.querySelector('svg');
        if (svgEl) {
          panZoomInstance = svgPanZoom(svgEl, {
            zoomEnabled: true,
            controlIconsEnabled: true,
            fit: true,
            center: true,
          });
          wireGraphClicks(provider.extractGraph(source), svgEl);
        }
      })
      .catch((err: unknown) => {
        if (destroyed) return;
        showError(err instanceof Error ? err.message : String(err));
      });
  }

  const handle: DiagramMountHandle = {
    teardown: () => {
      destroyed = true;
      panZoomInstance?.destroy();
      panZoomInstance = null;
    },
  };
  handles.set(container, handle);
  return handle;
}

/** Tear down every mounted diagram under `root` (inclusive) — called before
    a stale `.pgroup` is `.remove()`'d by D7 keyed reconciliation, so a
    svg-pan-zoom instance's window-level listeners are never leaked. */
export function teardownDiagramsIn(root: ParentNode): void {
  const containers =
    root instanceof Element && root.matches('.diagram')
      ? [root as HTMLElement]
      : Array.from(root.querySelectorAll<HTMLElement>('.diagram'));
  for (const container of containers) {
    handles.get(container)?.teardown();
  }
}
```

```css
/* src/styles/diagrams.css */
.diagram {
  position: relative;
  margin: 0.5em 0;
}

.diagram__svg-host {
  width: 100%;
  min-height: 120px;
  border: 1px solid var(--sz-border);
  border-radius: var(--sz-radius);
  overflow: hidden;
}

.diagram__svg-host svg {
  display: block;
  width: 100%;
  height: auto;
}

.diagram__error {
  color: var(--sz-warn-text);
  background: color-mix(in srgb, var(--sz-warn) 12%, transparent);
  border: 1px solid var(--sz-warn);
  border-radius: var(--sz-radius);
  padding: 6px 10px;
  font-size: 12px;
  margin-bottom: 6px;
}

.diagram__source-toggle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--sz-muted);
  background: none;
  border: 1px solid var(--sz-border);
  border-radius: var(--sz-radius-pill);
  padding: 2px 10px;
  cursor: pointer;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/diagrams/diagram-component.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/diagrams/diagram-component.ts src/ui/diagrams/diagram-component.test.ts src/styles/diagrams.css
git commit -m "diagrams: add DiagramComponent (pan/zoom + node-click wiring)"
```

---

### Task 8: Wire diagram detection into `decoratePnode`, teardown into D7 reconciliation, and registration into `main.ts`

**Files:**
- Modify: `src/ui/viewport.ts:180-190` (`decoratePnode`)
- Modify: `src/ui/viewport.test.ts`
- Modify: `src/state/reload.ts:122-163` (`reconcile`)
- Modify: `src/ui/reconcile.test.ts`
- Modify: `src/main.ts` (imports, registration, CSS, reconcile call site at `main.ts:1660`)

**Interfaces:**
- Consumes: `getDiagramProvider` (`./diagrams/provider`), `mountDiagram`, `teardownDiagramsIn` (`./diagrams/diagram-component`), `mermaidProvider` (`./diagrams/mermaid-provider`), `registerDiagramProvider` (`./diagrams/provider`).
- Produces: `reconcile(...)` gains an optional 6th parameter `onRemove?: (el: HTMLElement) => void`, called just before each stale node is `.remove()`'d.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/viewport.test.ts` (after the existing code-block tests, ~line 76):

```ts
import { registerDiagramProvider, clearDiagramProviders, type DiagramProvider } from './diagrams/provider';

// ... (keep existing imports/tests above)

test('a code paragraph with a registered diagram language mounts a .diagram instead of .code-wrap', () => {
  clearDiagramProviders();
  const provider: DiagramProvider = {
    language: 'mermaid',
    validate: () => ({ ok: true }),
    render: async () => '<svg></svg>',
    extractGraph: () => ({ nodes: [], edges: [] }),
  };
  registerDiagramProvider(provider);

  const table = structuredClone(sampleTable);
  const codePid = Object.keys(table.paragraphs).find((pid) => table.paragraphs[pid].kind === 'code')!;
  table.paragraphs[codePid].html = '<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>';

  const root = document.createElement('main');
  renderLevel(root, table, buildIndex(table), 0);

  const codeNode = root.querySelector('.pnode[data-kind="code"]')!;
  expect(codeNode.querySelector('.diagram')).toBeTruthy();
  expect(codeNode.querySelector('.code-wrap')).toBeNull();

  clearDiagramProviders();
});

test('a code paragraph with an UNregistered language falls back to .code-wrap as before', () => {
  clearDiagramProviders();
  const table = structuredClone(sampleTable);
  const codePid = Object.keys(table.paragraphs).find((pid) => table.paragraphs[pid].kind === 'code')!;
  table.paragraphs[codePid].html = '<pre><code class="language-python">print(1)</code></pre>';

  const root = document.createElement('main');
  renderLevel(root, table, buildIndex(table), 0);

  const codeNode = root.querySelector('.pnode[data-kind="code"]')!;
  expect(codeNode.querySelector('.code-wrap')).toBeTruthy();
  expect(codeNode.querySelector('.diagram')).toBeNull();
});
```

Add to `src/ui/reconcile.test.ts` (after the existing tests — check the file's end for its exact closing structure before appending):

```ts
test('onRemove is called for each stale node just before it is removed', () => {
  const buildGroup = makeBuildGroup();
  const column = guardedColumn();
  const removed: HTMLElement[] = [];

  let prev = reconcile(
    column,
    makeTable([['S-a-0', ['P-a-0']], ['S-b-0', ['P-b-0']]]),
    buildIndex(makeTable([['S-a-0', ['P-a-0']], ['S-b-0', ['P-b-0']]])),
    new Map(),
    buildGroup,
  );

  // Second table drops section S-b-0 entirely — its node is now stale.
  const removedNode = prev.get('S-b-0')!;
  reconcile(
    column,
    makeTable([['S-a-0', ['P-a-0']]]),
    buildIndex(makeTable([['S-a-0', ['P-a-0']]])),
    prev,
    buildGroup,
    (el) => removed.push(el),
  );

  expect(removed).toEqual([removedNode]);
});
```

(This test needs `buildIndex` imported in `reconcile.test.ts` — add `buildIndex` to the existing `import { buildIndex, type LookupTable, ... } from '../engine/schema';` line if it isn't already imported there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/viewport.test.ts src/ui/reconcile.test.ts`
Expected: FAIL — `decoratePnode` still always builds `.code-wrap`; `reconcile` doesn't accept/call a 6th argument.

- [ ] **Step 3: Write the implementation**

In `src/ui/viewport.ts`, add the import (near the top, with the other `./cards` import block, ~line 20):

```ts
import { getDiagramProvider } from './diagrams/provider';
import { mountDiagram } from './diagrams/diagram-component';
```

Replace `decoratePnode` (lines 180-190) with:

```ts
export function decoratePnode(node: HTMLElement): void {
  for (const tbl of node.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    tbl.replaceWith(scroll);
    scroll.appendChild(tbl);
  }
  for (const pre of node.querySelectorAll<HTMLElement>('pre')) {
    const lang = pre.querySelector('code')?.className.match(/language-(\S+)/)?.[1];
    if (lang && getDiagramProvider(lang)) {
      mountDiagram(pre, lang);
      continue;
    }
    wrapCodeBlock(pre);
  }
}
```

In `src/state/reload.ts`, change `reconcile`'s signature and the removal loop (lines 122-163):

```ts
export function reconcile(
  readingColumn: HTMLElement,
  newTable: LookupTable,
  _index: ResolvedIndex,
  prev: Map<string, HTMLElement>,
  buildGroup: (sid: string) => HTMLElement,
  onRemove?: (el: HTMLElement) => void,
): Map<string, HTMLElement> {
  const next = new Map<string, HTMLElement>();
  let cursor: ChildNode | null = readingColumn.firstChild;

  for (const sid of newTable.order.sections) {
    if (!newTable.sections[sid]) continue;
    const key = groupKey(newTable, sid);

    const existing = prev.get(sid);
    let node: HTMLElement;
    if (existing && existing.dataset.key === key) {
      node = existing;
    } else {
      node = buildGroup(sid);
    }
    node.dataset.key = key;
    next.set(sid, node);

    if (cursor === node) {
      cursor = node.nextSibling;
    } else {
      readingColumn.insertBefore(node, cursor);
    }
  }

  const kept = new Set(next.values());
  for (const child of Array.from(readingColumn.children)) {
    if (!kept.has(child as HTMLElement)) {
      onRemove?.(child as HTMLElement);
      child.remove();
    }
  }

  return next;
}
```

In `src/main.ts`:

1. Add imports (near the other `./ui/*` imports, e.g. after the `./ui/raw-markdown` import):

```ts
import { registerDiagramProvider } from './ui/diagrams/provider';
import { mermaidProvider } from './ui/diagrams/mermaid-provider';
import { teardownDiagramsIn } from './ui/diagrams/diagram-component';
```

2. Add the CSS import (with the other `./styles/*.css` imports, ~line 71):

```ts
import './styles/diagrams.css';
```

3. Register the provider at module init (near the other `init*()` calls, after `initDensity();`):

```ts
registerDiagramProvider(mermaidProvider);
```

4. Update the `reconcile` call site (`main.ts:1660`) to pass the teardown hook:

```ts
        prevGroups = reconcile(
          column,
          table,
          index,
          prevGroups,
          (sid) => buildGroup(table, index, sid, skipPid),
          teardownDiagramsIn,
        );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/viewport.test.ts src/ui/reconcile.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite and lint**

Run: `npm run lint && npx vitest run`
Expected: no lint errors; all tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/ui/viewport.ts src/ui/viewport.test.ts src/state/reload.ts src/ui/reconcile.test.ts src/main.ts
git commit -m "diagrams: wire Mermaid detection into decoratePnode + D7 teardown"
```

---

### Task 9: End-to-end smoke test + manual verification note

**Files:**
- Create: `src/ui/diagrams/__smoke__.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.

- [ ] **Step 1: Write the smoke test**

```ts
// src/ui/diagrams/__smoke__.test.ts
//
// One end-to-end pass through the real wiring (registry → decoratePnode →
// DiagramComponent → sanitize → cache), with only mermaid/svg-pan-zoom
// mocked at their module boundary (see mermaid-provider.test.ts and
// diagram-component.test.ts for why: real Mermaid rendering needs layout
// jsdom doesn't provide). Everything else — the registry, decoratePnode's
// lang detection, DiagramComponent's DOM construction, the sanitizer, the
// cache — is exercised for real.
import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(() => true),
    render: vi.fn(async () => ({ svg: '<svg><g id="flowchart-A-0"><text>Start</text></g></svg>' })),
  },
}));
vi.mock('svg-pan-zoom', () => ({ default: vi.fn(() => ({ destroy: vi.fn() })) }));

import { registerDiagramProvider, clearDiagramProviders } from './provider';
import { mermaidProvider } from './mermaid-provider';
import { decoratePnode } from '../viewport';

beforeEach(() => {
  clearDiagramProviders();
  registerDiagramProvider(mermaidProvider);
});

test('a real mermaid fenced block, run through decoratePnode, ends up as a sanitized rendered diagram', async () => {
  const node = document.createElement('div');
  node.innerHTML = '<pre><code class="language-mermaid">graph TD\nA[Start] --> B[End]</code></pre>';
  document.body.appendChild(node);

  decoratePnode(node);
  expect(node.querySelector('.diagram')).toBeTruthy();

  await vi.waitFor(() => {
    expect(node.querySelector('.diagram__svg-host svg')).toBeTruthy();
  });
  expect(node.querySelector('.diagram__svg-host')!.innerHTML).not.toContain('<script');
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/ui/diagrams/__smoke__.test.ts`
Expected: PASS

- [ ] **Step 3: Run the full CI suite**

Run: `npm run ci`
Expected: lint clean, `cargo test` passes (unaffected by this frontend-only change), full `vitest run` passes.

- [ ] **Step 4: Commit**

```bash
git add src/ui/diagrams/__smoke__.test.ts
git commit -m "diagrams: add end-to-end smoke test"
```

- [ ] **Step 5: Flag manual verification (do not skip)**

This plan's automated tests mock Mermaid's actual rendering (jsdom can't run it — see Task 5/7/9 module docs). Real visual/interaction verification — does a diagram actually render, does pan/zoom feel right, does clicking a node work, does dark/light theme switching restyle it, does an invalid diagram show the error state correctly — needs a manual pass in the real WKWebView app, which this implementation session cannot run itself. Open the app with a `.md` file containing a `` ```mermaid `` fence (both a valid flowchart and a deliberately broken one) and confirm by eye before considering this feature done.

---

## Self-Review Notes

- **Spec coverage:** detection (Task 8) ✓; retain source text (Task 7, `sourceCode.textContent`) ✓; render via official mermaid.js to SVG (Task 5) ✓; sanitize (Task 3) ✓; error state showing source (Task 7's `showError`) ✓; pan/zoom (Task 7, svg-pan-zoom) ✓; node-click event for future AI actions (Task 6 + 7) ✓; cache + re-render on source change (Task 2, cache; Task 8, D7 already rebuilds on hash change) ✓; modular for future formats (Task 1's registry) ✓; graph from source text, not SVG (Task 4 + Task 5's `extractGraph`) ✓.
- **Placeholder scan:** no TBD/TODO markers; every step has real, complete code.
- **Type consistency:** `DiagramProvider`/`DiagramGraph`/`RenderOptions` (Task 1) are used with identical shapes in Tasks 4, 5, 7; `mountDiagram`/`teardownDiagramsIn` (Task 7) signatures match their Task 8 call sites; `reconcile`'s new `onRemove` parameter (Task 8) matches its `main.ts` call site.
