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

/** Test-only: the render cache is a deliberate module-level singleton (it
    must persist for the app's lifetime, not per-call) — this lets tests
    clear it between cases instead of relying solely on distinct source
    strings to dodge cross-test collisions. */
export function resetDiagramCacheForTests(): void {
  cache.clear();
}

function extractGraph(source: string): DiagramGraph {
  const firstLine = source.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!/^(graph|flowchart)\b/i.test(firstLine)) return { nodes: [], edges: [] };
  return parseFlowchart(source);
}

// KNOWN LIMITATION, confirmed against the installed mermaid package (not
// just its types): `mermaid.parse()` is an `async function` in mermaid v10+
// (lazy diagram-definition loading). That means two things for `validate`
// below, which must stay SYNCHRONOUS to satisfy `DiagramProvider`'s
// committed interface (Task 1 — changing that interface is out of this
// file's scope; see CLAUDE.md's rule on flagging rather than silently
// overriding an architectural decision):
//   1. `mermaid.parse(...)` always returns a Promise object here — truthy,
//      never `=== false` — so the `result === false` branch below can never
//      fire against the real library. It only fires against the unit
//      tests' synchronous mock.
//   2. An `async function` cannot throw SYNCHRONOUSLY under any
//      circumstances (an internal error becomes a rejected Promise, not a
//      thrown value), so the `catch` block below is unreachable dead code
//      against the real library too.
// NET EFFECT: `validate()` returns `{ ok: true }` for every real input,
// regardless of whether the Mermaid source is actually valid. It does NOT
// leave the "invalid diagram -> show source + error state" requirement
// unimplemented, though: `render()` below awaits the real `mermaid.render()`,
// which DOES reject on invalid syntax (mermaid internally substitutes an
// error diagram for its own visible fallback, then still rethrows the
// original parse exception) — and the design spec explicitly treats a
// render() rejection as an equally valid trigger for the error-state UI
// (docs/superpowers/specs/2026-07-21-mermaid-diagram-support-design.md §7:
// "validate() failing (or render() throwing) means: no SVG is inserted").
// ACTION REQUIRED OF ANY CALLER (Task 7's mountDiagram, or anything else
// that consumes this provider): do not treat a passing validate() as proof
// the source is valid, and do not skip wiring a render()-rejection handler
// on the assumption validate() already caught the bad cases — it hasn't.
// If this provider's validate() needs to become a REAL synchronous or async
// pre-check in the future, that requires revisiting DiagramProvider's
// interface (Task 1) — a decision for the plan owner, not a silent change
// here.
function validate(source: string): { ok: true } | { ok: false; message: string } {
  try {
    const result = mermaid.parse(source, { suppressErrors: true }) as unknown as boolean;
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
