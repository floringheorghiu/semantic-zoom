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
