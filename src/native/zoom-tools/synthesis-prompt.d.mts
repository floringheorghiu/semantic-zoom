import type { SegmentBlock } from './types';

export const CONTRACT_HEADER: string;
export const DEFAULT_EDITORIAL: string;
export const CONTRACT_FOOTER: string;
export function buildSystemPrompt(editorial?: string): string;

export interface BuiltinTemplate {
  id: string;
  name: string;
  text: string;
}
export const BUILTIN_TEMPLATES: BuiltinTemplate[];

export function truncateForPrompt(text: string): string;
export function buildUserMessage(title: string, blocks: SegmentBlock[]): string;
