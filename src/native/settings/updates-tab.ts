// updates-tab.ts — Updates tab (version, toggles, manual check, changelog,
// Buy Me a Coffee). This tab OWNS its own update-dialog.ts instance (see
// that module's header comment: no cross-window shared instance). Manual
// checks here always ignore skippedVersion — only the automatic,
// main-window startup check honors it.
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check as checkForUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask } from '@tauri-apps/plugin-dialog';
import { mountUpdateDialog } from '../../ui/update-dialog';
import { fetchReleasesSince } from '../github-releases';

interface UpdatePrefs {
  autoCheck: boolean;
  autoInstall: boolean;
  skippedVersion: string | null;
}

export function initUpdatesTab(): void {
  function el<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`updates-tab: missing #${id}`);
    return found as T;
  }

  const currentVersionEl = el<HTMLElement>('updates-current-version');
  const checkNowButton = el<HTMLButtonElement>('updates-check-now');
  const statusLine = el<HTMLElement>('updates-status-line');
  const autoCheckBox = el<HTMLInputElement>('updates-auto-check');
  const autoInstallBox = el<HTMLInputElement>('updates-auto-install');
  const changelogEl = el<HTMLElement>('updates-changelog');
  const dialogMount = el<HTMLElement>('updates-dialog-mount');

  const dialog = mountUpdateDialog(dialogMount);

  let prefs: UpdatePrefs = { autoCheck: true, autoInstall: true, skippedVersion: null };
  let appVersion = '';

  async function savePrefs(): Promise<void> {
    await invoke('set_update_prefs', { prefs });
  }

  autoCheckBox.addEventListener('change', () => {
    prefs = { ...prefs, autoCheck: autoCheckBox.checked };
    void savePrefs();
  });

  autoInstallBox.addEventListener('change', () => {
    prefs = { ...prefs, autoInstall: autoInstallBox.checked };
    void savePrefs();
  });

  async function runInstall(update: Awaited<ReturnType<typeof checkForUpdate>>): Promise<void> {
    if (!update) return;
    let downloaded = 0;
    let total = 0;
    dialog.showProgress({ downloadedBytes: 0, totalBytes: 0, onCancel: () => {} });
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        dialog.updateProgress(downloaded, total);
      }
    });
    dialog.close();
    const shouldRestart = await ask('Restart Semantic Zoom now to finish updating?', {
      title: 'Update Installed',
    });
    if (shouldRestart) await relaunch();
  }

  async function handleCheckNow(): Promise<void> {
    statusLine.textContent = 'Checking…';
    const update = await checkForUpdate();
    // Keep the main window's empty-state banner in sync with this manual
    // check, whether or not an update was found.
    void invoke('request_update_check');

    if (!update) {
      statusLine.textContent = "You're up to date.";
      return;
    }
    statusLine.textContent = '';

    const releaseNotes = await fetchReleasesSince(appVersion);
    dialog.showFound({
      currentVersion: appVersion,
      latestVersion: update.version,
      releaseNotes: releaseNotes.length > 0 ? releaseNotes : [{ version: update.version, notesMarkdown: update.body ?? '' }],
      autoInstall: prefs.autoInstall,
      onAutoInstallChange: (value) => {
        prefs = { ...prefs, autoInstall: value };
        autoInstallBox.checked = value;
        void savePrefs();
      },
      onSkip: () => {
        prefs = { ...prefs, skippedVersion: update.version };
        void savePrefs();
      },
      onRemindLater: () => {},
      onInstall: () => void runInstall(update),
    });
  }

  checkNowButton.addEventListener('click', () => {
    void handleCheckNow();
  });

  function renderChangelog(releases: Awaited<ReturnType<typeof fetchReleasesSince>>): void {
    changelogEl.replaceChildren();
    if (releases.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'updates-changelog__empty';
      empty.textContent = "You're on the latest version — no newer release notes to show.";
      changelogEl.appendChild(empty);
      return;
    }
    for (const release of releases) {
      const entry = document.createElement('div');
      entry.className = 'updates-changelog__entry';

      const heading = document.createElement('h4');
      heading.textContent = release.version;
      entry.appendChild(heading);

      const body = document.createElement('p');
      body.textContent = release.notesMarkdown;
      entry.appendChild(body);

      changelogEl.appendChild(entry);
    }
  }

  async function load(): Promise<void> {
    appVersion = await getVersion();
    currentVersionEl.textContent = appVersion;

    prefs = await invoke<UpdatePrefs>('get_update_prefs');
    autoCheckBox.checked = prefs.autoCheck;
    autoInstallBox.checked = prefs.autoInstall;

    const releases = await fetchReleasesSince(appVersion);
    renderChangelog(releases);
  }

  void load();
}
