export type ZoomLevel = -2 | -1 | 0;

/** Raw paragraph — level 0. Immutable view of a slice of the source file. */
export interface ParagraphNode {
  id: string;                     // "P-1c9a2b3f-0" (D6)
  level: 0;
  parent: string;                 // S-node id
  kind: 'prose' | 'code' | 'list' | 'table' | 'heading' | 'blockquote';
  /** Byte offsets into the ORIGINAL markdown source. Enables copy-exact
      and cheap diffing on hot reload. */
  span: { start: number; end: number };
  /** Pre-rendered HTML (markdown → HTML at parse time, never at scroll time). */
  html: string;
  /** For kind === 'code' only. */
  lang?: string;
}

/** Plain-English section — level −1. */
export interface SectionNode {
  id: string;                     // "S-7e02d4aa-0" (D6)
  level: -1;
  parent: string;                 // M-node id
  children: string[];             // ordered P ids — THE sibling group
  title: string;
  body: string;                   // jargon-free walkthrough, plain markdown
}

/** Story meta-node — level −2. */
export interface MetaNode {
  id: string;                     // "M1" (positional — see §2.1)
  level: -2;
  children: string[];             // ordered S ids
  title: string;
  body: string;                   // accomplished / blockers / next steps
}

export interface LookupTable {
  version: 1;
  /** SHA-256 of all bytes PRECEDING the payload marker — a payload
      cannot hash a file that contains itself. The watcher's no-op
      short-circuit (§5.3) must hash the same region. */
  docHash: string;
  meta: Record<string, MetaNode>;
  sections: Record<string, SectionNode>;
  paragraphs: Record<string, ParagraphNode>;
  /** Document-order arrays. Rendering iterates these; never Object.keys(). */
  order: { meta: string[]; sections: string[]; paragraphs: string[] };
}

/** O(1) child→parent resolution both directions. Built once per load. */
export interface ResolvedIndex {
  parentOfParagraph: Map<string, string>;   // P → S
  parentOfSection: Map<string, string>;     // S → M
  siblingGroup: Map<string, string[]>;      // P → all P ids in its group
}

export function buildIndex(t: LookupTable): ResolvedIndex {
  const parentOfParagraph = new Map<string, string>();
  const parentOfSection = new Map<string, string>();
  const siblingGroup = new Map<string, string[]>();
  for (const s of Object.values(t.sections)) {
    parentOfSection.set(s.id, s.parent);
    for (const p of s.children) {
      parentOfParagraph.set(p, s.id);
      siblingGroup.set(p, s.children);
    }
  }
  return { parentOfParagraph, parentOfSection, siblingGroup };
}
