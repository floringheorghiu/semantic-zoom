import type { SegmentBlock } from './types';

export const SYNTHESIS_SYSTEM_PROMPT: string;
export function truncateForPrompt(text: string): string;
export function buildUserMessage(title: string, blocks: SegmentBlock[]): string;
