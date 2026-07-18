import { test, expect, beforeEach } from 'vitest';
import { getRecentFiles, addRecentFile, clearRecentFiles } from './recent-files';

beforeEach(() => {
  window.localStorage.clear();
});

test('getRecentFiles is empty with nothing persisted', () => {
  expect(getRecentFiles()).toEqual([]);
});

test('addRecentFile persists path + derived basename, most-recent first', () => {
  addRecentFile('/a/b/one.md');
  const result = addRecentFile('/a/b/two.md');
  expect(result).toEqual([
    { path: '/a/b/two.md', name: 'two.md' },
    { path: '/a/b/one.md', name: 'one.md' },
  ]);
  expect(getRecentFiles()).toEqual(result);
});

test('re-adding an existing path moves it to the front instead of duplicating', () => {
  addRecentFile('/a/one.md');
  addRecentFile('/a/two.md');
  const result = addRecentFile('/a/one.md');
  expect(result).toEqual([
    { path: '/a/one.md', name: 'one.md' },
    { path: '/a/two.md', name: 'two.md' },
  ]);
});

test('list is capped at 5 entries', () => {
  for (let i = 0; i < 7; i++) addRecentFile(`/a/${i}.md`);
  const result = getRecentFiles();
  expect(result).toHaveLength(5);
  expect(result.map((f) => f.path)).toEqual(['/a/6.md', '/a/5.md', '/a/4.md', '/a/3.md', '/a/2.md']);
});

test('clearRecentFiles empties the persisted history', () => {
  addRecentFile('/a/one.md');
  clearRecentFiles();
  expect(getRecentFiles()).toEqual([]);
});
