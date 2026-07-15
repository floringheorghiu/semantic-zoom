import { test, expect, vi, afterEach } from 'vitest';
import { mountStatusBadge } from './status-badge';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** No modal/dialog element is ever created (spec §5.3: non-modal only). */
function assertNoModal(root: HTMLElement): void {
  expect(root.querySelector('dialog')).toBeNull();
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  expect(root.querySelector('[role="alertdialog"]')).toBeNull();
}

test('setStatus("corrupt", error) shows a non-modal warning carrying the error; native clears it', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const badge = mountStatusBadge(root);

  badge.setStatus('corrupt', 'bad json at 12');
  const warn = root.querySelector('[data-status="corrupt"]') as HTMLElement | null;
  expect(warn).not.toBeNull();
  const text = `${warn!.textContent ?? ''} ${warn!.title}`;
  expect(text).toContain('bad json at 12');
  assertNoModal(root);

  badge.setStatus('native');
  expect(root.querySelector('[data-status="corrupt"]')).toBeNull();
  assertNoModal(root);

  badge.teardown();
});

test('setStatus("untagged") shows a calm neutral note, never a warning', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const badge = mountStatusBadge(root);

  badge.setStatus('untagged');
  expect(root.querySelector('[data-status="untagged"]')).not.toBeNull();
  expect(root.querySelector('[data-status="corrupt"]')).toBeNull();
  assertNoModal(root);

  badge.teardown();
});

test('flashUpdated shows a pill that auto-dismisses after 1500ms', () => {
  vi.useFakeTimers();
  const root = document.createElement('div');
  document.body.appendChild(root);
  const badge = mountStatusBadge(root);

  badge.flashUpdated();
  expect(root.querySelector('[data-pill="updated"]')).not.toBeNull();

  vi.advanceTimersByTime(1499);
  expect(root.querySelector('[data-pill="updated"]')).not.toBeNull();

  vi.advanceTimersByTime(1);
  expect(root.querySelector('[data-pill="updated"]')).toBeNull();
  assertNoModal(root);

  badge.teardown();
});

test('calling flashUpdated twice keeps a single pill and resets the 1500ms timer', () => {
  vi.useFakeTimers();
  const root = document.createElement('div');
  document.body.appendChild(root);
  const badge = mountStatusBadge(root);

  badge.flashUpdated();
  vi.advanceTimersByTime(1000);
  badge.flashUpdated('Updated');
  // still exactly one pill
  expect(root.querySelectorAll('[data-pill="updated"]').length).toBe(1);

  // 1000ms after the second call the FIRST call's window (1500) has passed,
  // but the reset timer means it must still be present.
  vi.advanceTimersByTime(1000);
  expect(root.querySelector('[data-pill="updated"]')).not.toBeNull();

  // 1500ms after the LAST call → gone.
  vi.advanceTimersByTime(500);
  expect(root.querySelector('[data-pill="updated"]')).toBeNull();

  badge.teardown();
});

test('teardown removes the mounted element', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const badge = mountStatusBadge(root);
  expect(root.children.length).toBeGreaterThan(0);
  badge.teardown();
  expect(root.children.length).toBe(0);
});

test('setStatus("synthesizing") shows a live elapsed ticker (m:ss) that any status change stops', () => {
  vi.useFakeTimers();
  const root = document.createElement('div');
  document.body.appendChild(root);
  const badge = mountStatusBadge(root);
  const note = root.querySelector<HTMLElement>('.status-badge__note')!;

  badge.setStatus('synthesizing');
  expect(note.textContent).toBe('Generating summary… 0:00');

  vi.advanceTimersByTime(65_000);
  expect(note.textContent).toBe('Generating summary… 1:05');

  // Any status change stops the ticker — the text must never mutate again.
  badge.setStatus('generationFailed', 'boom');
  expect(note.textContent).toBe('⚠ Summary generation failed');
  vi.advanceTimersByTime(10_000);
  expect(note.textContent).toBe('⚠ Summary generation failed');

  assertNoModal(root);
  badge.teardown();
});

test('setStatus("generationFailed", error) shows a persistent warning with the full error on hover', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const badge = mountStatusBadge(root);
  const note = root.querySelector<HTMLElement>('.status-badge__note')!;

  badge.setStatus('generationFailed', 'synthesis failed after 3 attempts');
  expect(note.dataset.status).toBe('generation-failed');
  expect(note.textContent).toContain('generation failed');
  expect(note.title).toContain('synthesis failed after 3 attempts');

  // Persistent: nothing dismisses it but the next status change.
  badge.setStatus('untagged');
  expect(note.dataset.status).toBe('untagged');

  assertNoModal(root);
  badge.teardown();
});
