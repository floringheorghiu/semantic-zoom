import type { LayersInput } from './types';

export function checkLayers(
  layers: LayersInput,
): { ok: true; sectionCount: number; metaCount: number } | { ok: false; errors: string[] };
