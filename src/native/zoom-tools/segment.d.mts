import type { SegmentBlock } from './types';

export function segment(source: string): { sourceLength: number; blocks: SegmentBlock[] };
