import { test, expect, vi } from 'vitest';
import { mountUpdateDialog } from './update-dialog';

// jsdom doesn't implement HTMLDialogElement.showModal() / close() natively.
// Add minimal polyfills so these tests can work.
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

function foundOpts(overrides: Partial<Parameters<ReturnType<typeof mountUpdateDialog>['showFound']>[0]> = {}) {
  return {
    currentVersion: '0.8.0',
    latestVersion: '0.9.0',
    releaseNotes: [{ version: '0.9.0', notesMarkdown: 'Fixed things.' }],
    autoInstall: true,
    onAutoInstallChange: vi.fn(),
    onSkip: vi.fn(),
    onRemindLater: vi.fn(),
    onInstall: vi.fn(),
    ...overrides,
  };
}

test('showFound renders the headline, version line, and release notes', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showFound(foundOpts());

  expect(root.querySelector('.update-dialog__headline')?.textContent).toContain('Semantic Zoom');
  expect(root.querySelector('.update-dialog__version-line')?.textContent).toContain('0.8.0');
  expect(root.querySelector('.update-dialog__version-line')?.textContent).toContain('0.9.0');
  expect(root.querySelector('.update-dialog__notes')?.textContent).toContain('Fixed things.');
});

test('the auto-install checkbox reflects the given state and reports changes', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onAutoInstallChange = vi.fn();
  handle.showFound(foundOpts({ autoInstall: false, onAutoInstallChange }));

  const checkbox = root.querySelector<HTMLInputElement>('.update-dialog__auto-install');
  expect(checkbox?.checked).toBe(false);

  checkbox!.checked = true;
  checkbox!.dispatchEvent(new Event('change'));
  expect(onAutoInstallChange).toHaveBeenCalledWith(true);
});

test('Skip This Version calls onSkip and closes the dialog', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onSkip = vi.fn();
  handle.showFound(foundOpts({ onSkip }));

  root.querySelector<HTMLButtonElement>('.update-dialog__skip')!.click();
  expect(onSkip).toHaveBeenCalledOnce();
  expect(root.querySelector('dialog')?.open).toBeFalsy();
});

test('Remind Me Later calls onRemindLater and closes the dialog', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onRemindLater = vi.fn();
  handle.showFound(foundOpts({ onRemindLater }));

  root.querySelector<HTMLButtonElement>('.update-dialog__remind-later')!.click();
  expect(onRemindLater).toHaveBeenCalledOnce();
  expect(root.querySelector('dialog')?.open).toBeFalsy();
});

test('Install Update calls onInstall and leaves the dialog open (caller switches to progress)', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onInstall = vi.fn();
  handle.showFound(foundOpts({ onInstall }));

  root.querySelector<HTMLButtonElement>('.update-dialog__install')!.click();
  expect(onInstall).toHaveBeenCalledOnce();
  expect(root.querySelector('dialog')?.open).toBe(true);
});

test('close() closes the dialog', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showFound(foundOpts());
  expect(root.querySelector('dialog')?.open).toBe(true);

  handle.close();
  expect(root.querySelector('dialog')?.open).toBeFalsy();
});

test('renders one heading per release when there are several unreleased-to-the-user versions', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showFound(
    foundOpts({
      releaseNotes: [
        { version: '0.9.0', notesMarkdown: 'Newest.' },
        { version: '0.8.1', notesMarkdown: 'Older.' },
      ],
    }),
  );

  const headings = root.querySelectorAll('.update-dialog__notes-version');
  expect(headings).toHaveLength(2);
  expect(headings[0].textContent).toBe('0.9.0');
  expect(headings[1].textContent).toBe('0.8.1');
});
