// updates-tab.test.ts — mocks @tauri-apps/api/core's invoke and
// @tauri-apps/plugin-updater's check, same pattern as inference-tab and
// prompt-tab: this is about the tab's state machine, not the real bridge.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const getVersionMock = vi.fn().mockResolvedValue('0.8.0');
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: () => getVersionMock(),
}));

const checkMock = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(false),
}));

const fetchReleasesSinceMock = vi.fn().mockResolvedValue([]);
vi.mock('../github-releases', () => ({
  fetchReleasesSince: (...args: unknown[]) => fetchReleasesSinceMock(...args),
  compareVersions: (a: string, b: string) => {
    const as = a.split('.').map(Number);
    const bs = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((as[i] ?? 0) !== (bs[i] ?? 0)) return (as[i] ?? 0) - (bs[i] ?? 0);
    return 0;
  },
}));

import { initUpdatesTab } from './updates-tab';

// jsdom doesn't implement HTMLDialogElement.showModal()/close() natively.
// Same polyfill as src/ui/update-dialog.test.ts (that module's own test
// applies it locally rather than globally in vitest.setup.ts) — this tab
// mounts a real update-dialog.ts instance, so it needs it too.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
}

function setDom(): void {
  document.body.innerHTML = `
    <p id="updates-current-version">—</p>
    <button id="updates-check-now" type="button"></button>
    <div id="updates-status-line"></div>
    <input type="checkbox" id="updates-auto-check" />
    <input type="checkbox" id="updates-auto-install" />
    <div id="updates-changelog"></div>
    <div id="updates-dialog-mount"></div>
  `;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'get_update_prefs') {
      return Promise.resolve({ autoCheck: true, autoInstall: false, skippedVersion: null });
    }
    return Promise.resolve(undefined);
  });
  checkMock.mockReset().mockResolvedValue(null);
  fetchReleasesSinceMock.mockReset().mockResolvedValue([]);
  setDom();
});

describe('initUpdatesTab', () => {
  it('shows the current app version', async () => {
    initUpdatesTab();
    await vi.waitFor(() => {
      expect(document.getElementById('updates-current-version')?.textContent).toBe('0.8.0');
    });
  });

  it('loads the saved toggle state into the checkboxes', async () => {
    initUpdatesTab();
    await vi.waitFor(() => {
      expect((document.getElementById('updates-auto-check') as HTMLInputElement).checked).toBe(true);
      expect((document.getElementById('updates-auto-install') as HTMLInputElement).checked).toBe(false);
    });
  });

  it('persists a toggle change via set_update_prefs', async () => {
    initUpdatesTab();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_update_prefs'));

    const autoInstall = document.getElementById('updates-auto-install') as HTMLInputElement;
    autoInstall.checked = true;
    autoInstall.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_update_prefs', {
        prefs: { autoCheck: true, autoInstall: true, skippedVersion: null },
      });
    });
  });

  it('"Check for Updates now" with no update available shows an up-to-date message', async () => {
    checkMock.mockResolvedValue(null);
    initUpdatesTab();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_update_prefs'));

    document.getElementById('updates-check-now')!.click();

    await vi.waitFor(() => {
      expect(document.getElementById('updates-status-line')?.textContent).toContain('up to date');
    });
  });

  it('"Check for Updates now" with an update available opens the dialog and syncs the main window', async () => {
    checkMock.mockResolvedValue({ version: '0.9.0', downloadAndInstall: vi.fn() });
    fetchReleasesSinceMock.mockResolvedValue([{ version: '0.9.0', notesMarkdown: 'Fixed things.' }]);
    initUpdatesTab();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_update_prefs'));

    document.getElementById('updates-check-now')!.click();

    await vi.waitFor(() => {
      expect(document.getElementById('updates-dialog-mount')?.querySelector('dialog')?.open).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith('request_update_check');
    });
  });

  it('renders one changelog entry per fetched release', async () => {
    fetchReleasesSinceMock.mockResolvedValue([
      { version: '0.9.0', notesMarkdown: 'Fixed things.' },
      { version: '0.8.1', notesMarkdown: 'Older fix.' },
    ]);
    initUpdatesTab();

    await vi.waitFor(() => {
      const entries = document.querySelectorAll('#updates-changelog .updates-changelog__entry');
      expect(entries).toHaveLength(2);
      expect(entries[0].textContent).toContain('0.9.0');
      expect(entries[0].textContent).toContain('Fixed things.');
    });
  });
});
