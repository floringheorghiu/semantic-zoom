// The pre-open placeholder (Figma 77:2622): shown in #viewport before any
// document is loaded. Two action rows ("Open a Markdown Document" / "App
// Settings") plus a Recent Files list. Tauri-free and store-free — main.ts
// drives it imperatively (ui/ boundary), like status-badge.ts.
//
// "App Settings" is rendered disabled: settings UI is an explicit Phase-1
// non-goal (spec §7), so the row keeps the Figma layout without wiring up a
// feature that doesn't exist yet.
import type { RecentFile } from '../state/recent-files';

export interface EmptyStateHandle {
  teardown: () => void;
}

export interface EmptyStateOptions {
  recentFiles: RecentFile[];
  onOpen: () => void;
  onSelectRecent: (path: string) => void;
}

function buildActionRow(
  label: string,
  accelerator: string,
  opts: { disabled?: boolean; onClick?: () => void },
): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'empty-state__action';
  if (opts.disabled) {
    row.disabled = true;
    row.setAttribute('aria-disabled', 'true');
  } else {
    row.addEventListener('click', () => opts.onClick?.());
  }

  const text = document.createElement('span');
  text.className = 'empty-state__action-label';
  text.textContent = label;
  row.appendChild(text);

  const kbd = document.createElement('span');
  kbd.className = 'empty-state__action-key';
  kbd.textContent = accelerator;
  row.appendChild(kbd);

  return row;
}

function buildRecentItem(file: RecentFile, onSelect: (path: string) => void): HTMLElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'empty-state__recent-item';
  item.title = file.path;
  item.addEventListener('click', () => onSelect(file.path));

  const name = document.createElement('span');
  name.className = 'empty-state__recent-name';
  name.textContent = file.name;
  item.appendChild(name);

  const path = document.createElement('span');
  path.className = 'empty-state__recent-path';
  path.textContent = file.path;
  item.appendChild(path);

  return item;
}

/** Mount the empty state into `root` (the viewport). Returns a teardown. */
export function mountEmptyState(root: HTMLElement, opts: EmptyStateOptions): EmptyStateHandle {
  const container = document.createElement('div');
  container.className = 'empty-state';

  const actions = document.createElement('div');
  actions.className = 'empty-state__actions';
  actions.appendChild(
    buildActionRow('Open a Markdown Document', '⌘O', { onClick: opts.onOpen }),
  );
  actions.appendChild(buildActionRow('App Settings', '⌘S', { disabled: true }));
  container.appendChild(actions);

  if (opts.recentFiles.length > 0) {
    const recent = document.createElement('div');
    recent.className = 'empty-state__recent';

    const label = document.createElement('p');
    label.className = 'empty-state__recent-label';
    label.textContent = 'Recent Files';
    recent.appendChild(label);

    for (const file of opts.recentFiles) {
      recent.appendChild(buildRecentItem(file, opts.onSelectRecent));
    }
    container.appendChild(recent);
  }

  root.appendChild(container);

  return {
    teardown: () => container.remove(),
  };
}
