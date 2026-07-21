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
    .filter((l) => l.length > 0 && !/^(graph|flowchart|sequencediagram|classdiagram|statediagram|erdiagram|gitgraph|pie|journey|quadrantchart|requirementdiagram)\b/i.test(l));

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
