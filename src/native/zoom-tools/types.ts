// types.ts — shared TS-only types for the portable zoom-tools .mjs modules
// (T4/T6). Kept as a normal .ts file (not ambient) so index.d.ts's module
// declarations can `import type` from it without ambient-scope issues.

export interface SegmentBlock {
  id: string;
  kind: 'heading' | 'code' | 'list' | 'table' | 'blockquote' | 'prose';
  span: { start: number; end: number };
  text: string;
  html: string;
  lang?: string;
}

export interface LayersInput {
  meta: { title: string; body: string; sections: string[] }[];
  sections: { key: string; title: string; body: string; paragraphs: string[] }[];
}

/** The model's raw synthesis output shape, per docs/prompts/engine-b-synthesis.md. */
export interface SynthesisModelOutput {
  meta: { title: string; body: string };
  sections: { children: string[]; title: string; body: string }[];
}
