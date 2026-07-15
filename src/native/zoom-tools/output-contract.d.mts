import type { LayersInput, SynthesisModelOutput } from './types';

export function checkOutputContract(
  parsed: unknown,
  inputIds: string[],
): { ok: true } | { ok: false; error: string };
export function stripMarkdownFence(text: string): string;
export function normalizeSynthesisOutput(parsed: unknown): unknown;
export function toAssemblerLayers(parsed: SynthesisModelOutput): LayersInput;
