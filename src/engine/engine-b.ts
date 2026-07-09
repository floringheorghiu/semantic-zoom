// src/engine/engine-b.ts
import type { LookupTable } from './schema';

export interface Synthesizer {
  /** Segments raw markdown (unified + remark-parse → AST → paragraph
      grouping) and generates S/M layers. Resolves with a full LookupTable. */
  synthesize(raw: string, signal: AbortSignal): Promise<LookupTable>;
}

/** Phase 1 stub: rejects immediately; UI stays at k=0. */
export const stubSynthesizer: Synthesizer = {
  synthesize: async () => { throw new Error('ENGINE_B_NOT_IMPLEMENTED'); },
};

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

const processor = unified().use(remarkParse);

export function segment(raw: string): { kind: string; start: number; end: number }[] {
  const tree = processor.parse(raw);
  const out: { kind: string; start: number; end: number }[] = [];
  visit(tree, (node: any) => {
    if (!node.position || node.type === 'root') return;
    if (['paragraph', 'code', 'list', 'table', 'heading', 'blockquote'].includes(node.type)) {
      out.push({ kind: node.type, start: node.position.start.offset, end: node.position.end.offset });
      return 'skip'; // don't descend into block children
    }
  });
  return out;
}
