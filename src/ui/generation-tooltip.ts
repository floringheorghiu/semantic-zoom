// generation-tooltip.ts — the generation-history hover card (Figma node
// 241:456, "Tooltip-LLM-results"; spec:
// docs/superpowers/specs/2026-07-16-generation-history-tooltip-design.md).
//
// Hovering (or keyboard-focusing) the permanent status pill opens a card
// listing this document's past Engine B runs, newest first — provider,
// model, duration, tokens, temperature, and the full error text for
// failures. NOT a modal: it never blocks input and closes the moment the
// pointer leaves (status-badge.ts's non-modal rule governs here — this is
// hover-disclosed status detail, not a dialog).
//
// Pure DOM, no `@tauri-apps/*` (ui/ boundary). main.ts owns the lifecycle
// and supplies the runs via a getter, so the card always renders the list
// as of open time — no stale snapshot from mount time.

export interface GenerationRun {
  outcome: 'succeeded' | 'failed' | 'removed';
  providerKind: string;
  baseUrl: string;
  model: string;
  durationMs: number;
  /** ISO-8601; rendered as the "Created" row. */
  finishedAt: string;
  version: number;
  /** Retry-ladder attempts used; 0 = refused before any provider call. */
  attempts: number;
  temperature: number;
  promptTokens?: number;
  completionTokens?: number;
  milestones?: number;
  sections?: number;
  error?: string;
  /** Display name of the summarization template this run used (Task 8/12
      — e.g. "PRD / Spec"). Absent on runs recorded before PR 3, which must
      render with no Template row at all rather than "Template: undefined". */
  template?: string;
}

export interface GenerationTooltipOptions {
  /** The status pill (statusBadge.anchor) — hover/focus entry point. */
  anchor: HTMLElement;
  /** Called at open time. Empty list ⇒ the tooltip never appears —
      unless `isTagged()` says the document has a payload. */
  getRuns: () => GenerationRun[];
  /** Whether the CURRENT document carries a zoom payload. Tagged docs get
      the card even with zero recorded runs (files tagged before history
      tracking existed), plus the Remove action. Default: false. */
  isTagged?: () => boolean;
  /** Fired when the user clicks "Remove zoom layers…". main.ts owns the
      confirmation dialog and the actual removal — this component stays
      Tauri-free (ui/ boundary). */
  onRemoveRequest?: () => void;
}

export interface GenerationTooltipHandle {
  teardown: () => void;
}

/** Hover intent delay before opening; leaving either surface closes after
    a short grace so the pointer can travel from pill to card. */
const OPEN_DELAY_MS = 300;
const CLOSE_GRACE_MS = 200;

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 1) return '< 1 sec';
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} sec`;
  if (s === 0) return `${m} min`;
  return `${m} min ${s} sec`;
}

/** "July 16, 2026 12:34 PM" — the mock's en-US rendering, kept fixed so the
    card matches the design regardless of system locale. */
function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function inferenceLabel(run: GenerationRun): string {
  if (run.providerKind === 'ollama') return 'Ollama, local';
  if (run.providerKind === 'custom-local') return 'Custom server, local';
  try {
    const host = new URL(run.baseUrl).hostname;
    return host ? `${host}, remote` : 'Remote endpoint';
  } catch {
    return 'Remote endpoint';
  }
}

function attemptsLabel(run: GenerationRun): string {
  if (run.attempts === 0) return 'Refused before any attempt.';
  if (run.outcome === 'succeeded') {
    return run.attempts === 1
      ? 'Succeeded on the first attempt.'
      : `Succeeded on attempt ${run.attempts}.`;
  }
  return run.attempts === 1 ? '1 failed attempt.' : `Failed after ${run.attempts} attempts.`;
}

function row(label: string, value: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'generation-tooltip__row';
  const key = document.createElement('span');
  key.className = 'generation-tooltip__key';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = 'generation-tooltip__value';
  val.textContent = value;
  line.append(key, val);
  return line;
}

function buildEntry(run: GenerationRun): HTMLElement {
  const entry = document.createElement('div');
  entry.className = 'generation-tooltip__entry';
  entry.dataset.outcome = run.outcome;

  // A removal is an event, not a run — no provider ever existed for it, so
  // the provider rows would all be "—" noise. Compact entry instead.
  if (run.outcome === 'removed') {
    const label = document.createElement('div');
    label.className = 'generation-tooltip__removed-label';
    label.textContent = 'Zoom layers removed';
    entry.appendChild(label);
    entry.appendChild(row('Removed:', formatCreated(run.finishedAt)));
    return entry;
  }

  entry.appendChild(row('Inference:', inferenceLabel(run)));
  entry.appendChild(row('Model:', run.model || '—'));
  entry.appendChild(row('Duration:', formatDuration(run.durationMs)));
  entry.appendChild(row('Created:', formatCreated(run.finishedAt)));
  entry.appendChild(row('Version:', String(run.version)));
  // Older runs (recorded before PR 3) carry no `template` field — omit the
  // row entirely rather than render "Template: undefined".
  if (run.template !== undefined) {
    entry.appendChild(row('Template:', run.template));
  }
  if (run.attempts > 0) {
    // Provider-facing facts exist only if a provider was actually called.
    if (run.promptTokens !== undefined || run.completionTokens !== undefined) {
      const fmt = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString('en-US'));
      entry.appendChild(row('Tokens:', `${fmt(run.promptTokens)} in → ${fmt(run.completionTokens)} out`));
    }
    entry.appendChild(row('Temp:', run.temperature.toFixed(1)));
  }
  if (run.outcome === 'succeeded' && (run.milestones !== undefined || run.sections !== undefined)) {
    entry.appendChild(row('Output:', `${run.milestones ?? 0} milestones · ${run.sections ?? 0} sections`));
  }

  const attempts = row('Attempts:', attemptsLabel(run));
  if (run.outcome === 'failed' && run.error) {
    const quote = document.createElement('span');
    quote.className = 'generation-tooltip__error';
    quote.textContent = `“${run.error}”`;
    attempts.querySelector('.generation-tooltip__value')!.appendChild(quote);
  }
  entry.appendChild(attempts);
  return entry;
}

/**
 * Wire the hover/focus behavior onto `opts.anchor`; the card mounts into
 * `root` (main.ts passes document.body — the card is fixed-position, the
 * root only anchors it in the DOM) on open and unmounts on close.
 */
export function mountGenerationTooltip(
  root: HTMLElement,
  opts: GenerationTooltipOptions,
): GenerationTooltipHandle {
  let card: HTMLElement | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (openTimer !== null) clearTimeout(openTimer);
    if (closeTimer !== null) clearTimeout(closeTimer);
    openTimer = null;
    closeTimer = null;
  }

  function close(): void {
    clearTimers();
    card?.remove();
    card = null;
  }

  function open(): void {
    if (card !== null) return;
    const runs = opts.getRuns();
    const tagged = opts.isTagged?.() ?? false;
    // Fresh untagged file: no history, no tooltip. A TAGGED doc always gets
    // the card — even with zero runs (payload predates history tracking) —
    // because the Remove action lives here.
    if (runs.length === 0 && !tagged) return;

    // READ the anchor's geometry before any DOM write (read-then-write
    // discipline) — the card is right-aligned under the pill.
    const rect = opts.anchor.getBoundingClientRect();

    card = document.createElement('div');
    card.className = 'generation-tooltip';
    card.setAttribute('role', 'tooltip');
    card.style.top = `${rect.bottom + 8}px`;
    card.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;

    // The action sits on TOP of the stack — visible without scrolling a
    // long history; the confirmation dialog is the real destructive gate.
    if (tagged) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'generation-tooltip__remove';
      remove.textContent = 'Remove zoom layers…';
      remove.addEventListener('click', () => {
        close();
        opts.onRemoveRequest?.();
      });
      card.appendChild(remove);
    }

    // Newest first — the store appends chronologically.
    for (const run of [...runs].reverse()) card.appendChild(buildEntry(run));

    if (runs.length === 0 && tagged) {
      const empty = document.createElement('div');
      empty.className = 'generation-tooltip__empty';
      empty.textContent =
        'No generation history for this file — its zoom layers were created ' +
        'before history tracking, or outside this app.';
      card.appendChild(empty);
    }

    card.addEventListener('mouseenter', handleEnter);
    card.addEventListener('mouseleave', handleLeave);
    root.appendChild(card);
  }

  function handleEnter(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (card === null && openTimer === null) {
      openTimer = setTimeout(() => {
        openTimer = null;
        open();
      }, OPEN_DELAY_MS);
    }
  }

  function handleLeave(): void {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (card !== null && closeTimer === null) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        close();
      }, CLOSE_GRACE_MS);
    }
  }

  // Keyboard parity: focus opens without the hover-intent delay (a focus is
  // already deliberate), blur closes after the same grace.
  function handleFocus(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    open();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && card !== null) close();
  }

  opts.anchor.addEventListener('mouseenter', handleEnter);
  opts.anchor.addEventListener('mouseleave', handleLeave);
  opts.anchor.addEventListener('focus', handleFocus);
  opts.anchor.addEventListener('blur', handleLeave);
  document.addEventListener('keydown', handleKeydown);
  // The pill is a <span>; focusability is part of being the tooltip's
  // keyboard entry point.
  if (!opts.anchor.hasAttribute('tabindex')) opts.anchor.setAttribute('tabindex', '0');

  let torndown = false;
  return {
    teardown: () => {
      if (torndown) return;
      torndown = true;
      close();
      opts.anchor.removeEventListener('mouseenter', handleEnter);
      opts.anchor.removeEventListener('mouseleave', handleLeave);
      opts.anchor.removeEventListener('focus', handleFocus);
      opts.anchor.removeEventListener('blur', handleLeave);
      document.removeEventListener('keydown', handleKeydown);
    },
  };
}
