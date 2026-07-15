export const MARKER_HEAD: string;
export const MARKER_TAIL: string;
export const REQUIRED_TOP_LEVEL_KEYS: string[];
export function looksLikeLookupTable(value: unknown): boolean;
export function findExistingPayload(rawFull: string): { head: number; end: number } | null;
export function stripPayloads(raw: string): string;
export function hasDamagedEofMarker(text: string): boolean;
export function prePayloadSource(raw: string): string;
