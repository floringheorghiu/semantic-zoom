// Recently-opened file paths, persisted in `localStorage`. This is view-truth
// (a UI convenience, not document state) so it stays entirely on the TS side —
// no new Rust/TS crossing is needed (CLAUDE.md: exactly three crossings).

export interface RecentFile {
  path: string;
  name: string;
}

const STORAGE_KEY = 'sz.recentFiles';
const MAX_RECENT = 5;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function toRecentFiles(paths: string[]): RecentFile[] {
  return paths.map((path) => ({ path, name: basename(path) }));
}

/** Most-recently-opened first, capped at `MAX_RECENT`. */
export function getRecentFiles(): RecentFile[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return toRecentFiles(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    return [];
  }
}

/** Move `path` to the front (de-duplicating), cap the list, and persist it. */
export function addRecentFile(path: string): RecentFile[] {
  const rest = getRecentFiles()
    .map((f) => f.path)
    .filter((p) => p !== path);
  const next = [path, ...rest].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode / quota) — recent files just won't persist.
  }
  return toRecentFiles(next);
}
