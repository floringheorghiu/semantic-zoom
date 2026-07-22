// A same-process, in-memory cache for rendered diagram SVGs. Keyed by a fast
// NON-cryptographic hash (FNV-1a) of source + render options + the Mermaid
// package version — never source text alone, since two renders of identical
// source under a different theme (the app already has a light/dark switcher)
// or a Mermaid upgrade must not collide (design decision #2).

export interface DiagramRenderResult {
  svg: string;
}

/** FNV-1a, 32-bit. Cache keys only — never used anywhere security-sensitive. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function cacheKey(source: string, theme: string, providerVersion: string): string {
  return fnv1a(`${source}|${theme}|${providerVersion}`);
}

const DEFAULT_MAX_ENTRIES = 50;

/** Simple LRU: `Map` iteration order is insertion order, so re-inserting on
    every touch keeps the least-recently-used entry first (evict from front). */
export class DiagramCache {
  private map = new Map<string, DiagramRenderResult>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(key: string): DiagramRenderResult | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit); // refresh recency
    }
    return hit;
  }

  set(key: string, value: DiagramRenderResult): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
