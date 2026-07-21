// update-dialog.ts — the Sparkle/Typora-style "update found" + download-
// progress dialog. Mounted independently by BOTH main.ts (main window:
// automatic checks) and updates-tab.ts (settings window: manual checks) —
// there is no cross-window shared instance, just a shared component.
// Tauri-free by design (no-restricted-imports, src/ui/**): all data comes
// in as plain options, all actions go out as plain callbacks. Follows the
// mountX(root, opts) -> handle pattern (mountStatusBadge, mountThemeSwitcher),
// not empty-state.ts's mount-per-state-change pattern, because this dialog
// needs live updates during a download (Task 8).
import type { ReleaseNote } from '../native/github-releases';

export interface FoundUpdateOptions {
  currentVersion: string;
  latestVersion: string;
  /** Every release newer than currentVersion, newest first. */
  releaseNotes: ReleaseNote[];
  autoInstall: boolean;
  onAutoInstallChange: (value: boolean) => void;
  onSkip: () => void;
  onRemindLater: () => void;
  onInstall: () => void;
}

export interface DownloadProgressOptions {
  downloadedBytes: number;
  totalBytes: number;
  onCancel: () => void;
}

export interface UpdateDialogHandle {
  showFound: (opts: FoundUpdateOptions) => void;
  showProgress: (opts: DownloadProgressOptions) => void;
  updateProgress: (downloadedBytes: number, totalBytes: number) => void;
  close: () => void;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Mount the (initially empty, closed) dialog shell into `root`. Call
    showFound/showProgress to populate and open it. */
export function mountUpdateDialog(root: HTMLElement): UpdateDialogHandle {
  const dialog = document.createElement('dialog');
  dialog.className = 'update-dialog';
  root.appendChild(dialog);

  let onCancelCallback: (() => void) | null = null;

  function renderFound(opts: FoundUpdateOptions): void {
    dialog.replaceChildren();

    const icon = document.createElement('div');
    icon.className = 'update-dialog__icon';
    dialog.appendChild(icon);

    const headline = document.createElement('h2');
    headline.className = 'update-dialog__headline';
    headline.textContent = 'A new version of Semantic Zoom is available!';
    dialog.appendChild(headline);

    const versionLine = document.createElement('p');
    versionLine.className = 'update-dialog__version-line';
    versionLine.textContent = `Semantic Zoom ${opts.latestVersion} is now available — you have ${opts.currentVersion}.`;
    dialog.appendChild(versionLine);

    const notesLabel = document.createElement('p');
    notesLabel.className = 'update-dialog__notes-label';
    notesLabel.textContent = 'Release Notes:';
    dialog.appendChild(notesLabel);

    const notes = document.createElement('div');
    notes.className = 'update-dialog__notes';
    for (const release of opts.releaseNotes) {
      const versionHeading = document.createElement('h3');
      versionHeading.className = 'update-dialog__notes-version';
      versionHeading.textContent = release.version;
      notes.appendChild(versionHeading);

      const body = document.createElement('p');
      body.textContent = release.notesMarkdown;
      notes.appendChild(body);
    }
    dialog.appendChild(notes);

    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'update-dialog__checkbox-field';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'update-dialog__auto-install';
    checkbox.checked = opts.autoInstall;
    checkbox.addEventListener('change', () => opts.onAutoInstallChange(checkbox.checked));
    checkboxLabel.appendChild(checkbox);
    checkboxLabel.appendChild(document.createTextNode('Automatically download and install updates in the future'));
    dialog.appendChild(checkboxLabel);

    const actions = document.createElement('div');
    actions.className = 'update-dialog__actions';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'update-dialog__skip';
    skip.textContent = 'Skip This Version';
    skip.addEventListener('click', () => {
      opts.onSkip();
      dialog.close();
    });
    actions.appendChild(skip);

    const remindLater = document.createElement('button');
    remindLater.type = 'button';
    remindLater.className = 'update-dialog__remind-later';
    remindLater.textContent = 'Remind Me Later';
    remindLater.addEventListener('click', () => {
      opts.onRemindLater();
      dialog.close();
    });
    actions.appendChild(remindLater);

    const install = document.createElement('button');
    install.type = 'button';
    install.className = 'update-dialog__install';
    install.textContent = 'Install Update';
    install.addEventListener('click', () => opts.onInstall());
    actions.appendChild(install);

    dialog.appendChild(actions);

    if (!dialog.open) dialog.showModal();
  }

  function renderProgress(opts: DownloadProgressOptions): void {
    dialog.replaceChildren();
    onCancelCallback = opts.onCancel;

    const icon = document.createElement('div');
    icon.className = 'update-dialog__icon';
    dialog.appendChild(icon);

    const headline = document.createElement('h2');
    headline.className = 'update-dialog__headline';
    headline.textContent = 'Updating Semantic Zoom';
    dialog.appendChild(headline);

    const label = document.createElement('p');
    label.className = 'update-dialog__progress-label';
    label.textContent = 'Downloading update…';
    dialog.appendChild(label);

    const track = document.createElement('div');
    track.className = 'update-dialog__progress-track';
    const bar = document.createElement('div');
    bar.className = 'update-dialog__progress-bar';
    track.appendChild(bar);
    dialog.appendChild(track);

    const byteCount = document.createElement('p');
    byteCount.className = 'update-dialog__progress-bytes';
    dialog.appendChild(byteCount);

    const actions = document.createElement('div');
    actions.className = 'update-dialog__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'update-dialog__cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      onCancelCallback?.();
      dialog.close();
    });
    actions.appendChild(cancel);
    dialog.appendChild(actions);

    if (!dialog.open) dialog.showModal();
    applyProgress(opts.downloadedBytes, opts.totalBytes);
  }

  function applyProgress(downloadedBytes: number, totalBytes: number): void {
    const bar = dialog.querySelector<HTMLElement>('.update-dialog__progress-bar');
    const byteCount = dialog.querySelector<HTMLElement>('.update-dialog__progress-bytes');
    if (!bar || !byteCount) return; // showProgress hasn't been called yet
    const pct = totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : 0;
    bar.style.width = `${pct}%`;
    byteCount.textContent = `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`;
  }

  return {
    showFound: renderFound,
    showProgress: renderProgress,
    updateProgress: applyProgress,
    close: () => dialog.close(),
  };
}
