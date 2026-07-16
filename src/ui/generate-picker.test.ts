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

test('renders the three provider options with the v2 labels and a close button', () => {
  const { root, handle } = mount();

  const options = root.querySelectorAll<HTMLButtonElement>('.generate-picker__option');
  expect(options).toHaveLength(3);
  expect(options[0].dataset.choice).toBe('ollama');
  expect(options[0].textContent).toContain('Generate locally');
  expect(options[0].textContent).toContain('with Ollama');
  expect(options[1].dataset.choice).toBe('custom-local');
  expect(options[1].textContent).toContain('Generate on a local');
  expect(options[1].textContent).toContain('custom server');
  expect(options[2].dataset.choice).toBe('remote');
  expect(options[2].textContent).toContain('Generate on a');
  expect(options[2].textContent).toContain('remote endpoint');
  expect(root.querySelector('.generate-picker__close')).not.toBeNull();

  // All option icons are real inline SVGs (Figma exports), never empty.
  const icons = root.querySelectorAll('.generate-picker__icon svg');
  expect(icons).toHaveLength(3);

  handle.teardown();
  root.remove();
});

test('clicking an option reports its provider kind', () => {
  const { root, onPick, onDismiss, handle } = mount();

  root.querySelector<HTMLButtonElement>('[data-choice="ollama"]')!.click();
  expect(onPick).toHaveBeenCalledWith('ollama');

  root.querySelector<HTMLButtonElement>('[data-choice="custom-local"]')!.click();
  expect(onPick).toHaveBeenCalledWith('custom-local');

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
  expect(document.activeElement).toBe(root.querySelector('[data-choice="ollama"]'));

  handle.teardown();
  expect(document.activeElement).toBe(outside);

  root.remove();
  outside.remove();
});

test('Tab cycles focus within the dialog instead of escaping it', () => {
  const { root, handle } = mount();
  const overlay = root.querySelector<HTMLElement>('.generate-picker__overlay')!;
  const ollama = root.querySelector<HTMLButtonElement>('[data-choice="ollama"]')!;
  const customLocal = root.querySelector<HTMLButtonElement>('[data-choice="custom-local"]')!;
  const remote = root.querySelector<HTMLButtonElement>('[data-choice="remote"]')!;
  const close = root.querySelector<HTMLButtonElement>('.generate-picker__close')!;

  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(customLocal);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(remote);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(close);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.activeElement).toBe(ollama);
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
