import { test, expect, vi } from 'vitest';
import { mountEmptyState } from './empty-state';

const noopHandlers = { onOpen: () => {}, onSelectRecent: () => {}, onSettings: () => {} };

test('renders the two action rows, both enabled', () => {
  const root = document.createElement('div');
  mountEmptyState(root, { recentFiles: [], ...noopHandlers });

  const actions = root.querySelectorAll<HTMLButtonElement>('.empty-state__action');
  expect(actions).toHaveLength(2);
  expect(actions[0].textContent).toContain('Open a Markdown Document');
  expect(actions[0].disabled).toBe(false);
  expect(actions[1].textContent).toContain('App Settings');
  expect(actions[1].disabled).toBe(false);
});

test('the App Settings row shows the real menu accelerator (⌘,), not ⌘S', () => {
  const root = document.createElement('div');
  mountEmptyState(root, { recentFiles: [], ...noopHandlers });

  const settingsRow = root.querySelectorAll<HTMLButtonElement>('.empty-state__action')[1];
  expect(settingsRow.querySelector('.empty-state__action-key')?.textContent).toBe('⌘,');
});

test('clicking "Open a Markdown Document" calls onOpen', () => {
  const root = document.createElement('div');
  const onOpen = vi.fn();
  mountEmptyState(root, { recentFiles: [], ...noopHandlers, onOpen });

  root.querySelector<HTMLButtonElement>('.empty-state__action')!.click();
  expect(onOpen).toHaveBeenCalledOnce();
});

test('clicking "App Settings" calls onSettings', () => {
  const root = document.createElement('div');
  const onSettings = vi.fn();
  mountEmptyState(root, { recentFiles: [], ...noopHandlers, onSettings });

  root.querySelectorAll<HTMLButtonElement>('.empty-state__action')[1].click();
  expect(onSettings).toHaveBeenCalledOnce();
});

test('omits the Recent Files section entirely when there is no history', () => {
  const root = document.createElement('div');
  mountEmptyState(root, { recentFiles: [], ...noopHandlers });
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
    ...noopHandlers,
    onSelectRecent,
  });

  const items = root.querySelectorAll<HTMLButtonElement>('.empty-state__recent-item');
  expect(items).toHaveLength(2);
  expect(items[0].querySelector('.empty-state__recent-name')?.textContent).toBe('zoom_test.md');
  expect(items[0].querySelector('.empty-state__recent-path')?.textContent).toBe('/a/zoom_test.md');

  items[1].click();
  expect(onSelectRecent).toHaveBeenCalledWith('/a/CLAUDE.md');
});

test('renders the logo, and a footer with all seven shortcut hints plus the version', () => {
  const root = document.createElement('div');
  mountEmptyState(root, {
    recentFiles: [],
    ...noopHandlers,
    version: '9.9.9',
  });

  expect(root.querySelector('.empty-state__logo svg')).not.toBeNull();

  const hints = root.querySelectorAll('.empty-state__footer .empty-state__footer-hint');
  expect(hints).toHaveLength(8); // 7 shortcuts + version
  expect(hints[0].textContent).toBe('⌘1 — raw level');
  expect(hints[3].textContent).toBe('⌘↓ — next section');
  expect(hints[6].textContent).toBe('⌘/ — help');
  expect(root.querySelector('.empty-state__footer-version')?.textContent).toBe('v9.9.9');
});

test('omits the version chip when no version is provided', () => {
  const root = document.createElement('div');
  mountEmptyState(root, { recentFiles: [], ...noopHandlers });
  expect(root.querySelector('.empty-state__footer-version')).toBeNull();
  expect(root.querySelectorAll('.empty-state__footer-hint')).toHaveLength(7);
});

test('teardown removes the container from the DOM', () => {
  const root = document.createElement('div');
  const handle = mountEmptyState(root, { recentFiles: [], ...noopHandlers });
  expect(root.querySelector('.empty-state')).not.toBeNull();
  handle.teardown();
  expect(root.querySelector('.empty-state')).toBeNull();
});

test('renders "Clear history" when a handler is given and routes clicks to it', () => {
  const root = document.createElement('div');
  const onClearRecent = vi.fn();
  mountEmptyState(root, {
    recentFiles: [{ path: '/a/zoom_test.md', name: 'zoom_test.md' }],
    ...noopHandlers,
    onClearRecent,
  });

  const clear = root.querySelector<HTMLButtonElement>('.empty-state__recent-clear');
  expect(clear?.textContent).toBe('Clear history');
  clear!.click();
  expect(onClearRecent).toHaveBeenCalledOnce();
});

test('omits "Clear history" when no handler is provided', () => {
  const root = document.createElement('div');
  mountEmptyState(root, {
    recentFiles: [{ path: '/a/zoom_test.md', name: 'zoom_test.md' }],
    ...noopHandlers,
  });
  expect(root.querySelector('.empty-state__recent-clear')).toBeNull();
});
