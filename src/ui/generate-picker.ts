// generate-picker.ts — the inference-provider picker shown when the Generate
// affordance is clicked (Figma node 252:951, "Modal-LLM-selection-v2"). Three
// option cards mirroring the Settings provider kinds — Ollama, local custom
// server, remote endpoint — over a dimming overlay, with a close ✕. The
// microcopy is fixed and model-agnostic per the v2 design; only the option
// picked, not a provider name, varies at runtime.
//
// This is deliberately a MODAL, unlike every status surface in this app
// (status-badge.ts's "NEVER a modal" rule): it isn't feedback, it's a
// user-initiated choice that blocks the action it configures, and it is the
// visible trust boundary of §8.5 — picking the remote endpoint is the moment
// document text is consented to leave the machine, so it must interrupt.
//
// Pure DOM, no `@tauri-apps/*` (ui/ boundary). The caller (main.ts) maps the
// choice onto the provider config store, owns the lifecycle, and tears this
// down from its onPick/onDismiss handlers. Icons are the exact
// Figma-exported assets (figma-design-to-code icon-fidelity rule),
// recolorable via `--fill-0`.

import ollamaIconSvg from '../assets/picker-ollama.svg?raw';
import customLocalIconSvg from '../assets/picker-custom-local.svg?raw';
import remoteIconSvg from '../assets/picker-remote.svg?raw';
import closeIconSvg from '../assets/picker-close.svg?raw';

/** Mirrors ProviderConfig.kind in src-tauri/src/commands/provider_config.rs. */
export type GeneratePickerChoice = 'ollama' | 'custom-local' | 'remote';

export interface GeneratePickerOptions {
  onPick: (choice: GeneratePickerChoice) => void;
  onDismiss: () => void;
}

export interface GeneratePickerHandle {
  teardown: () => void;
}

function buildOption(
  choice: GeneratePickerChoice,
  iconSvg: string,
  lines: string[],
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'generate-picker__option';
  btn.dataset.choice = choice;

  const icon = document.createElement('span');
  icon.className = `generate-picker__icon generate-picker__icon--${choice}`;
  icon.innerHTML = iconSvg;
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'generate-picker__label';
  for (const text of lines) {
    const line = document.createElement('span');
    line.textContent = text;
    label.appendChild(line);
  }

  btn.append(icon, label);
  return btn;
}

/**
 * Mounts the picker into `root` (main.ts passes `document.body`; the overlay
 * is fixed-position so the root only anchors it in the DOM). Focus moves to
 * the first option and is restored on teardown. Escape, the ✕, and clicking
 * the overlay all route to `onDismiss`; the component never removes itself —
 * teardown stays with the caller (main.ts owns all lifecycles).
 */
export function mountGeneratePicker(
  root: HTMLElement,
  opts: GeneratePickerOptions,
): GeneratePickerHandle {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement('div');
  overlay.className = 'generate-picker__overlay';

  const dialog = document.createElement('div');
  dialog.className = 'generate-picker';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Choose how to generate the summary');

  // Line breaks match the v2 mock exactly (Figma 252:951).
  const ollamaBtn = buildOption('ollama', ollamaIconSvg, ['Generate locally', 'with Ollama']);
  const customLocalBtn = buildOption('custom-local', customLocalIconSvg, [
    'Generate on a local',
    'custom server',
  ]);
  const remoteBtn = buildOption('remote', remoteIconSvg, ['Generate on a', 'remote endpoint']);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'generate-picker__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = closeIconSvg;

  dialog.append(ollamaBtn, customLocalBtn, remoteBtn, closeBtn);
  overlay.appendChild(dialog);

  const handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (target === overlay) {
      opts.onDismiss();
      return;
    }
    if (closeBtn.contains(target)) {
      opts.onDismiss();
      return;
    }
    const option = target.closest<HTMLButtonElement>('.generate-picker__option');
    if (option) opts.onPick(option.dataset.choice as GeneratePickerChoice);
  };
  overlay.addEventListener('click', handleClick);

  // Escape dismisses; Tab cycles within the dialog (focus must not escape
  // into the dimmed document behind the overlay).
  const focusables = [ollamaBtn, customLocalBtn, remoteBtn, closeBtn];
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      opts.onDismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const index = focusables.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.shiftKey ? -1 : 1;
    const next = (index + step + focusables.length) % focusables.length;
    event.preventDefault();
    focusables[next].focus();
  };
  overlay.addEventListener('keydown', handleKeydown);

  root.appendChild(overlay);
  ollamaBtn.focus();

  let torndown = false;
  return {
    teardown: () => {
      if (torndown) return;
      torndown = true;
      overlay.removeEventListener('click', handleClick);
      overlay.removeEventListener('keydown', handleKeydown);
      overlay.remove();
      previouslyFocused?.focus();
    },
  };
}
