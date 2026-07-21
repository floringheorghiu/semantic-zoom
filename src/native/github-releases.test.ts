import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, fetchReleasesSince } from './github-releases';

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.9.0')).toBe(0);
  });

  it('treats a missing patch segment as 0', () => {
    expect(compareVersions('0.9', '0.9.0')).toBe(0);
    expect(compareVersions('0.9.1', '0.9')).toBeGreaterThan(0);
  });
});

describe('fetchReleasesSince', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns releases newer than currentVersion, newest first, v-prefix stripped', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: 'v0.10.0', body: 'Fixed things.' },
        { tag_name: 'v0.9.0', body: 'Added stuff.' },
        { tag_name: 'v0.8.0', body: 'Old release.' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const releases = await fetchReleasesSince('0.8.0');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/floringheorghiu/semantic-zoom/releases',
    );
    expect(releases).toEqual([
      { version: '0.10.0', notesMarkdown: 'Fixed things.' },
      { version: '0.9.0', notesMarkdown: 'Added stuff.' },
    ]);
  });

  it('returns an empty list when the fetch fails, rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => [] }));
    await expect(fetchReleasesSince('0.8.0')).resolves.toEqual([]);
  });
});
