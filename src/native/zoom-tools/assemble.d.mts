import type { LookupTable } from '../../engine/schema';
import type { LayersInput } from './types';

export class AssembleError extends Error {}
export function buildLookupTable(
  raw: string,
  layers: LayersInput,
): { table: LookupTable; docHash: string; prefix: string };
