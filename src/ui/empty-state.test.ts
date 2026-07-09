import { test, expect, vi } from 'vitest';
import { mountEmptyState } from './empty-state';

test('renders the two action rows, with App Settings disabled', () => {
  const root = document.createElement('div');
  mountEmptyState(root, { recentFiles: [], onOpen: () => {}, onSelectRecent: () => {} });

  const actions = root.querySelectorAll<HTMLButtonElement>('.empty-state__action');
  expect(actions).toHaveLength(2);
  expect(actions[0].textContent).toContain('Open a Markdown Document');
  expect(actions[0].disabled).toBe(false);
  expect(actions[1].textContent).toContain('App Settings');
  expect(actions[1].disabled).toBe(true);
});

test('clicking "Open a Markdown Document" calls onOpen', () => {
  const root = document.createElement('div');
  const onOpen = vi.fn();
  mountEmptyState(root, { recentFiles: [], onOpen, onSelectRecent: () => {} });

  root.querySelector<HTMLButtonElement>('.empty-state__action')!.click();
  expect(onOpen).toHaveBeenCalledOnce();
});

test('omits the Recent Files section entirely when there is no history', () => {
  const root = document.createElement('div');
  mountEmptyState(root, { recentFiles: [], onOpen: () => {}, onSelectRecent: () => {} });
  expect(root.querySelector('.empty-state__recent')).toBeNull();
});

test('renders a row per recent file and routes clicks to onSelectRecent', () => {
  const root = document.createElement('div');
  const onSelectRecent = vi.fn();
  mountEmptyState(root, {
    recentFiles: [
      { path: '/a/zoom_test.md', name: 'zoom_test.md' },
      { path: '/a/CLAUDE.md', name: 'CLAUDE.md' },
    ],
    onOpen: () => {},
    onSelectRecent,
  });

  const items = root.querySelectorAll<HTMLButtonElement>('.empty-state__recent-item');
  expect(items).toHaveLength(2);
  expect(items[0].querySelector('.empty-state__recent-name')?.textContent).toBe('zoom_test.md');
  expect(items[0].querySelector('.empty-state__recent-path')?.textContent).toBe('/a/zoom_test.md');

  items[1].click();
  expect(onSelectRecent).toHaveBeenCalledWith('/a/CLAUDE.md');
});

test('teardown removes the container from the DOM', () => {
  const root = document.createElement('div');
  const handle = mountEmptyState(root, { recentFiles: [], onOpen: () => {}, onSelectRecent: () => {} });
  expect(root.querySelector('.empty-state')).not.toBeNull();
  handle.teardown();
  expect(root.querySelector('.empty-state')).toBeNull();
});
