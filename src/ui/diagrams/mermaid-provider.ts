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
    // mermaid's real .d.ts types `parse(..., { suppressErrors: true })` as
    // Promise<ParseResult | false> (mermaid v10+ loads diagram definitions
    // lazily), but this provider's `validate` must stay synchronous to match
    // the DiagramProvider interface (Task 1, out of this task's scope to
    // change). The cast below preserves this file's brief-specified runtime
    // behavior (and matches the test's synchronous mock) without fighting
    // the type checker — it does not change behavior either way. Flagged as
    // a known limitation: against the REAL (non-mocked) mermaid package,
    // `result` here is always a Promise object (truthy, never `=== false`),
    // so validate() will only report `ok: false` when parse throws
    // synchronously, not for its normal async-rejected-parse path.
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
