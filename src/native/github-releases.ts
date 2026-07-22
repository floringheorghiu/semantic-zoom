// github-releases.ts — fetch-based GitHub Releases access for the update
// dialog's stacked release-notes list and the Updates tab's changelog
// panel. Deliberately Tauri-free (plain fetch, no @tauri-apps/* import) so
// it's importable from anywhere without touching the no-restricted-imports
// boundary — the actual update *detection*/*install* goes through
// @tauri-apps/plugin-updater separately (main.ts / updates-tab.ts own
// that), this module only supplies the human-readable notes text.

const REPO = 'floringheorghiu/semantic-zoom';

export interface ReleaseNote {
  version: string;
  notesMarkdown: string;
}

interface GitHubRelease {
  tag_name: string;
  body: string | null;
}

/** Numeric per-segment compare on `x.y.z` tags (missing segments = 0). Not
    full semver (no pre-release/build metadata handling) — this app's tags
    are plain `vMAJOR.MINOR.PATCH`, so that's all this needs to get right. */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.').map((n) => parseInt(n, 10) || 0);
  const bs = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Every published release newer than `currentVersion`, newest first.
    Returns an empty list on any fetch/parse failure rather than throwing —
    a changelog panel that fails to load is a degraded UI, not a crash. */
export async function fetchReleasesSince(currentVersion: string): Promise<ReleaseNote[]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases`);
    if (!res.ok) return [];
    const releases = (await res.json()) as GitHubRelease[];
    return releases
      .map((r) => ({ version: r.tag_name.replace(/^v/, ''), notesMarkdown: r.body ?? '' }))
      .filter((r) => compareVersions(r.version, currentVersion) > 0)
      .sort((a, b) => compareVersions(b.version, a.version));
  } catch {
    return [];
  }
}
