import { test, expect, vi } from 'vitest';
import { mountGeneratePicker, type GeneratePickerChoice } from './generate-picker';

function mount(overrides: Partial<Parameters<typeof mountGeneratePicker>[1]> = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const onPick = vi.fn<(choice: GeneratePickerChoice) => void>();
  const onDismiss = vi.fn();
  const handle = mountGeneratePicker(root, { onPick, onDismiss, ...overrides });
  return { root, onPick, onDismiss, handle };
}

test('renders both options with the mock labels and a close button', () => {
  const { root, handle } = mount();

  const options = root.querySelectorAll<HTMLButtonElement>('.generate-picker__option');
  expect(options).toHaveLength(2);
  expect(options[0].textContent).toContain('Generate locally');
  expect(options[0].textContent).toContain('with Ollama');
  expect(options[1].textContent).toContain('Generate remotely');
  expect(options[1].textContent).toContain('with Cerebras');
  expect(root.querySelector('.generate-picker__close')).not.toBeNull();

  // Both option icons are real inline SVGs (Figma exports), never empty.
  const icons = root.querySelectorAll('.generate-picker__icon svg');
  expect(icons).toHaveLength(2);

  handle.teardown();
  root.remove();
});

test('provider names are caller-overridable (dialog reflects real config)', () => {
  const { root, handle } = mount({ localName: 'gemma4:latest', remoteName: 'api.example.com' });

  expect(root.textContent).toContain('with gemma4:latest');
  expect(root.textContent).toContain('with api.example.com');

  handle.teardown();
  root.remove();
});

test('clicking an option reports its choice', () => {
  const { root, onPick, onDismiss, handle } = mount();

  root.querySelector<HTMLButtonElement>('[data-choice="local"]')!.click();
  expect(onPick).toHaveBeenCalledWith('local');

  root.querySelector<HTMLButtonElement>('[data-choice="remote"]')!.click();
  expect(onPick).toHaveBeenCalledWith('remote');
  expect(onDismiss).not.toHaveBeenCalled();

  handle.teardown();
  root.remove();
});

test('close button, overlay click, and Escape all dismiss — dialog body does not', () => {
  const { root, onPick, onDismiss, handle } = mount();
  const overlay = root.querySelector<HTMLElement>('.generate-picker__overlay')!;

  root.querySelector<HTMLButtonElement>('.generate-picker__close')!.click();
  expect(onDismiss).toHaveBeenCalledTimes(1);

  overlay.click();
  expect(onDismiss).toHaveBeenCalledTimes(2);

  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onDismiss).toHaveBeenCalledTimes(3);

  // A click on the dialog surface itself (not an option, not close) is inert.
  root.querySelector<HTMLElement>('.generate-picker')!.click();
  expect(onDismiss).toHaveBeenCalledTimes(3);
  expect(onPick).not.toHaveBeenCalled();

  handle.teardown();
  root.remove();
});

test('moves focus into the dialog on open and restores it on teardown', () => {
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  outside.focus();

  const { root, handle } = mount();
  expect(document.activeElement).toBe(root.querySelector('[data-choice="local"]'));

  handle.teardown();
  expect(document.activeElement).toBe(outside);

  root.remove();
  outside.remove();
});

test('Tab cycles focus within the dialog instead of escaping it', () => {
  const { root, handle } = mount();
  const overlay = root.querySelector<HTMLElement>('.generate-picker__overlay')!;
  const remote = root.querySelector<HTMLButtonElement>('[data-choice="remote"]')!;
  const close = root.querySelector<HTMLButtonElement>('.generate-picker__close')!;
  const local = root.querySelector<HTMLButtonElement>('[data-choice="local"]')!;

  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(remote);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(close);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(local);
  overlay.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
  );
  expect(document.activeElement).toBe(close);

  handle.teardown();
  root.remove();
});

test('teardown removes the overlay from the DOM and is idempotent', () => {
  const { root, handle } = mount();
  expect(root.querySelector('.generate-picker__overlay')).not.toBeNull();

  handle.teardown();
  expect(root.querySelector('.generate-picker__overlay')).toBeNull();
  expect(() => handle.teardown()).not.toThrow();

  root.remove();
});
