import type { LookupTable } from './schema';

/**
 * TS mirror of the Rust `LoadResult` enum (spec §2.6). The Rust side uses
 * `#[serde(tag = "kind", rename_all = "camelCase")]`, so this is a
 * discriminated union on `kind` with camelCase variant names.
 *
 * - `native`:   Engine A succeeded — render immediately.
 * - `untagged`: no payload found — show k=0, route to Engine B (stub in P1).
 * - `corrupt`:  payload present but invalid — show k=0 + warning badge.
 */
export type LoadResultDTO =
  | { kind: 'native'; table: LookupTable; raw: string }
  | { kind: 'untagged'; raw: string }
  | { kind: 'corrupt'; raw: string; error: string };
