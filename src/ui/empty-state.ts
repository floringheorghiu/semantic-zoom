// The pre-open placeholder (Figma 111:3743, superseding 77:2622): shown in
// #viewport before any document is loaded. A binoculars logo, two action rows
// ("Open a Markdown Document" / "App Settings"), a Recent Files list, and a
// bottom shortcut-hints bar with the app version. Tauri-free and store-free —
// main.ts drives it imperatively (ui/ boundary), like status-badge.ts.
import type { RecentFile } from '../state/recent-files';

export interface EmptyStateHandle {
  teardown: () => void;
}

export interface EmptyStateOptions {
  recentFiles: RecentFile[];
  onOpen: () => void;
  onSelectRecent: (path: string) => void;
  onSettings: () => void;
  /** "Clear history" affordance (Figma 306:174); omitted → link not shown. */
  onClearRecent?: () => void;
  /** App version shown at the end of the footer (e.g. "0.3.0"); omitted → no version chip. */
  version?: string;
  /** A known-available update; omitted → no banner. Clicking the banner's
      button never installs directly — it opens the same update-dialog.ts
      component main.ts already drives, so there's one install path. */
  updateAvailable?: { version: string; onOpenDialog: () => void };
}

// Binoculars mark (Figma 111:3780 "Union"). Fill rides --sz-map-bar — the
// asset's own #D5E0FF is exactly that token's light value, so the logo follows
// the theme (dim indigo in dark mode) for free.
const LOGO_SVG =
  '<svg viewBox="0 0 78.3346 88.9293" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  '<path fill="var(--sz-map-bar)" d="M65.9756 71.7998C68.9044 71.7999 71.2783 74.1746 71.2783 77.1035C71.2783 79.4773 69.7013 81.5617 67.417 82.207L47.8945 87.7207C42.1882 89.3322 36.1467 89.3322 30.4404 87.7207L10.9179 82.207C8.63363 81.5617 7.05663 79.4773 7.05662 77.1035C7.05662 74.1746 9.43048 71.8 12.3594 71.7998H65.9756ZM26.79 0C28.3793 0 29.9536 0.314041 31.4219 0.923828C32.89 1.53361 34.2241 2.42709 35.3476 3.55371C35.6284 3.83548 35.8511 4.17005 36.0029 4.53809C36.1547 4.90611 36.2327 5.88556 36.2324 6.28418V13.499C36.2325 15.1115 37.5398 16.4189 39.1523 16.4189C40.7648 16.4189 42.0721 15.1115 42.0722 13.499V6.28418C42.0737 5.48227 42.1863 4.28555 42.957 3.56152C44.0806 2.43487 45.4146 1.54142 46.8828 0.931641C48.3509 0.321894 49.9245 0.00785484 51.5136 0.0078125C53.1029 0.0078125 54.6772 0.321853 56.1455 0.931641C57.6133 1.54127 58.4899 2.03285 59.6133 3.15918C59.8792 3.42548 60.5508 4.37573 60.7021 4.7207L76.4209 40.3018C76.7516 40.9534 77.0439 41.6241 77.2949 42.3105C77.3054 42.3361 77.3139 42.3628 77.3203 42.3896C77.321 42.3927 77.3213 42.3963 77.3213 42.3994V42.4229C77.3213 42.4282 77.3248 42.4332 77.3301 42.4346C77.3339 42.4355 77.3375 42.4386 77.3388 42.4424C78.898 46.9643 78.6174 51.9198 76.5586 56.2363C74.4986 60.555 70.8239 63.8866 66.331 65.5078C61.8383 67.1289 56.8893 66.9092 52.5566 64.8975C48.2238 62.8857 44.8559 59.2435 43.1836 54.7598C42.4472 52.7457 42.0758 50.6157 42.0869 48.4707V32.1123C42.0869 30.4997 40.7796 29.1924 39.167 29.1924C37.5545 29.1926 36.247 30.4998 36.247 32.1123V48.4668C36.2582 50.6118 35.8876 52.7419 35.1513 54.7559C33.479 59.2397 30.1112 62.8827 25.7783 64.8945C21.4455 66.9063 16.4957 67.1251 12.0029 65.5039C7.51038 63.8827 3.83632 60.5517 1.77634 56.2334C-0.280242 51.9219 -0.562896 46.9718 0.99021 42.4541C0.995241 42.4394 0.998023 42.4189 0.998023 42.4033C0.998044 42.3915 0.99958 42.3844 1.00291 42.373C1.00906 42.352 1.01614 42.3309 1.02439 42.3105C1.27539 41.6241 1.56765 40.9534 1.89841 40.3018L17.6015 4.71289C17.7529 4.36795 18.3375 3.42558 18.6035 3.15918C19.7271 2.03251 20.691 1.53358 22.1592 0.923828C23.6273 0.314094 25.2009 5.52019e-05 26.79 0ZM65.1904 37.4775C62.7281 36.366 59.9656 36.1126 57.3427 36.7568C54.7198 37.4011 52.3867 38.9063 50.7158 41.0332C49.0451 43.16 48.1321 45.7861 48.122 48.4932V48.5352C48.1208 50.4877 48.59 52.4116 49.4892 54.1436C50.3886 55.8755 51.6919 57.3644 53.2881 58.4834C54.8841 59.6023 56.726 60.3187 58.6572 60.5713C60.5886 60.8238 62.5528 60.6058 64.3818 59.9346C67.381 58.834 69.8246 56.5889 71.1797 53.6895C72.5347 50.7901 72.6911 47.4708 71.6152 44.4561L70.9306 42.8906C69.6733 40.4947 67.6527 38.5891 65.1904 37.4775ZM20.9687 36.7393C18.3451 36.0931 15.5809 36.3457 13.1172 37.457C10.6533 38.5684 8.63191 40.475 7.374 42.8721L6.68943 44.4375C5.64699 47.4525 5.83146 50.7581 7.2031 53.6377C8.5747 56.517 11.0226 58.7387 14.0166 59.8213C17.0107 60.9038 20.3101 60.7598 23.1992 59.4209C26.0861 58.0828 28.3322 55.6587 29.4502 52.6738C29.4509 52.673 29.4521 52.6735 29.4521 52.6748C29.4522 52.6762 29.4545 52.6762 29.4551 52.6748C29.9358 51.3479 30.1824 49.9469 30.1826 48.5352V48.4902C30.1759 45.7818 29.2652 43.1529 27.5957 41.0234C25.926 38.8939 23.5925 37.3855 20.9687 36.7393Z"/>' +
  '</svg>';

/** Footer shortcut hints (Figma 111:3838), in display order. */
const FOOTER_HINTS = [
  '⌘1 — raw level',
  '⌘2 — section level',
  '⌘3 — milestone level',
  '⌘↓ — next section',
  '⌘↑ — previous section',
  '⌘W — close',
  '⌘/ — help',
];

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

function buildFooter(version?: string): HTMLElement {
  const footer = document.createElement('footer');
  footer.className = 'empty-state__footer';
  for (const hint of FOOTER_HINTS) {
    const span = document.createElement('span');
    span.className = 'empty-state__footer-hint';
    span.textContent = hint;
    footer.appendChild(span);
  }
  if (version) {
    const span = document.createElement('span');
    span.className = 'empty-state__footer-hint empty-state__footer-version';
    span.textContent = `v${version}`;
    footer.appendChild(span);
  }
  return footer;
}

function buildUpdateBanner(update: { version: string; onOpenDialog: () => void }): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'empty-state__update-banner';

  const text = document.createElement('span');
  text.textContent = `Version ${update.version} is available.`;
  banner.appendChild(text);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'empty-state__update-banner-action';
  action.textContent = 'Update';
  action.addEventListener('click', () => update.onOpenDialog());
  banner.appendChild(action);

  return banner;
}

/** Mount the empty state into `root` (the viewport). Returns a teardown. */
export function mountEmptyState(root: HTMLElement, opts: EmptyStateOptions): EmptyStateHandle {
  const container = document.createElement('div');
  container.className = 'empty-state';

  const body = document.createElement('div');
  body.className = 'empty-state__body';

  const logo = document.createElement('div');
  logo.className = 'empty-state__logo';
  logo.innerHTML = LOGO_SVG;
  body.appendChild(logo);

  const actions = document.createElement('div');
  actions.className = 'empty-state__actions';
  actions.appendChild(
    buildActionRow('Open a Markdown Document', '⌘O', { onClick: opts.onOpen }),
  );
  // "⌘," matches the Settings… accelerator installed by main.ts's app menu.
  actions.appendChild(buildActionRow('App Settings', '⌘,', { onClick: opts.onSettings }));
  body.appendChild(actions);

  if (opts.recentFiles.length > 0) {
    const recent = document.createElement('div');
    recent.className = 'empty-state__recent';

    const head = document.createElement('div');
    head.className = 'empty-state__recent-head';

    const label = document.createElement('p');
    label.className = 'empty-state__recent-label';
    label.textContent = 'Recent Files';
    head.appendChild(label);

    if (opts.onClearRecent) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'empty-state__recent-clear';
      clear.textContent = 'Clear history';
      clear.addEventListener('click', () => opts.onClearRecent?.());
      head.appendChild(clear);
    }
    recent.appendChild(head);

    for (const file of opts.recentFiles) {
      recent.appendChild(buildRecentItem(file, opts.onSelectRecent));
    }
    body.appendChild(recent);
  }

  container.appendChild(body);
  if (opts.updateAvailable) {
    container.appendChild(buildUpdateBanner(opts.updateAvailable));
  }
  container.appendChild(buildFooter(opts.version));
  root.appendChild(container);

  return {
    teardown: () => container.remove(),
  };
}
