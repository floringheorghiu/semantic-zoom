import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mountGenerationTooltip,
  type GenerationRun,
  type GenerationTooltipHandle,
} from './generation-tooltip';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function successRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    outcome: 'succeeded',
    providerKind: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'gemma4:latest',
    durationMs: 328_000,
    finishedAt: '2026-07-16T12:34:00',
    version: 1,
    attempts: 1,
    temperature: 0,
    promptTokens: 8200,
    completionTokens: 1020,
    milestones: 4,
    sections: 12,
    ...overrides,
  };
}

function failedRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    ...successRun(),
    outcome: 'failed',
    attempts: 3,
    temperature: 0.6,
    milestones: undefined,
    sections: undefined,
    error:
      'Engine B synthesis failed after 3 attempts. Last rejection: response was not valid JSON',
    ...overrides,
  };
}

function mount(runs: GenerationRun[]): { anchor: HTMLElement; handle: GenerationTooltipHandle } {
  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  const handle = mountGenerationTooltip(document.body, { anchor, getRuns: () => runs });
  return { anchor, handle };
}

function hoverOpen(anchor: HTMLElement): void {
  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  vi.advanceTimersByTime(300);
}

test('hovering the anchor opens the card after the intent delay', () => {
  const { anchor, handle } = mount([successRun()]);

  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  expect(document.querySelector('.generation-tooltip')).toBeNull();
  vi.advanceTimersByTime(299);
  expect(document.querySelector('.generation-tooltip')).toBeNull();
  vi.advanceTimersByTime(1);
  expect(document.querySelector('.generation-tooltip')).not.toBeNull();

  handle.teardown();
});

test('no recorded runs → the tooltip never appears (fresh raw file)', () => {
  const { anchor, handle } = mount([]);
  hoverOpen(anchor);
  expect(document.querySelector('.generation-tooltip')).toBeNull();
  handle.teardown();
});

test('a successful run renders the mock’s rows', () => {
  const { anchor, handle } = mount([successRun()]);
  hoverOpen(anchor);

  const card = document.querySelector('.generation-tooltip')!;
  const text = card.textContent!;
  expect(text).toContain('Inference:');
  expect(text).toContain('Ollama, local');
  expect(text).toContain('gemma4:latest');
  expect(text).toContain('5 min 28 sec');
  expect(text).toContain('July 16, 2026');
  expect(text).toContain('12:34 PM');
  expect(text).toContain('Version:');
  expect(text).toContain('8,200 in → 1,020 out');
  expect(text).toContain('0.0');
  expect(text).toContain('4 milestones · 12 sections');
  expect(text).toContain('Succeeded on the first attempt.');
  expect(text).not.toContain('“'); // no quoted error on success

  handle.teardown();
});

test('a failed run quotes the full error and shows the real attempt count', () => {
  const { anchor, handle } = mount([failedRun()]);
  hoverOpen(anchor);

  const card = document.querySelector('.generation-tooltip')!;
  expect(card.textContent).toContain('Failed after 3 attempts.');
  expect(card.querySelector('.generation-tooltip__error')!.textContent).toContain(
    'response was not valid JSON',
  );
  // Final-attempt temperature, not attempt 1's 0.0.
  expect(card.textContent).toContain('0.6');

  handle.teardown();
});

test('a run carrying a template (Task 12) renders a Template row with its name', () => {
  const { anchor, handle } = mount([successRun({ template: 'PRD / Spec' })]);
  hoverOpen(anchor);

  const card = document.querySelector('.generation-tooltip')!;
  expect(card.textContent).toContain('Template:');
  expect(card.textContent).toContain('PRD / Spec');

  handle.teardown();
});

test('an older run with no template field omits the Template row entirely', () => {
  const { anchor, handle } = mount([successRun()]); // no `template` — pre-PR-3 run
  hoverOpen(anchor);

  const card = document.querySelector('.generation-tooltip')!;
  expect(card.textContent).not.toContain('Template:');
  expect(card.textContent).not.toContain('undefined');

  handle.teardown();
});

test('remote runs show the endpoint host; custom-local its own label', () => {
  const { anchor, handle } = mount([
    successRun({ providerKind: 'remote', baseUrl: 'https://api.cerebras.ai/v1' }),
    successRun({ providerKind: 'custom-local' }),
  ]);
  hoverOpen(anchor);

  const text = document.querySelector('.generation-tooltip')!.textContent!;
  expect(text).toContain('api.cerebras.ai, remote');
  expect(text).toContain('Custom server, local');

  handle.teardown();
});

test('entries render newest first (store order is chronological)', () => {
  const { anchor, handle } = mount([
    successRun({ model: 'older-run' }),
    failedRun({ model: 'newest-run' }),
  ]);
  hoverOpen(anchor);

  const entries = document.querySelectorAll('.generation-tooltip__entry');
  expect(entries).toHaveLength(2);
  expect(entries[0].textContent).toContain('newest-run');
  expect(entries[1].textContent).toContain('older-run');

  handle.teardown();
});

test('a pre-flight refusal (attempts 0) omits provider-only rows', () => {
  const { anchor, handle } = mount([
    failedRun({
      attempts: 0,
      promptTokens: undefined,
      completionTokens: undefined,
      error: 'Document is too large to generate a summary',
    }),
  ]);
  hoverOpen(anchor);

  const text = document.querySelector('.generation-tooltip')!.textContent!;
  expect(text).toContain('Refused before any attempt.');
  expect(text).not.toContain('Tokens:');
  expect(text).not.toContain('Temp:');

  handle.teardown();
});

test('leaving the anchor closes after the grace period — unless the pointer reaches the card', () => {
  const { anchor, handle } = mount([successRun()]);
  hoverOpen(anchor);
  const card = document.querySelector<HTMLElement>('.generation-tooltip')!;

  // Leave the anchor but enter the card within the grace window → stays.
  anchor.dispatchEvent(new MouseEvent('mouseleave'));
  vi.advanceTimersByTime(100);
  card.dispatchEvent(new MouseEvent('mouseenter'));
  vi.advanceTimersByTime(500);
  expect(document.querySelector('.generation-tooltip')).not.toBeNull();

  // Leaving the card closes it after the grace.
  card.dispatchEvent(new MouseEvent('mouseleave'));
  vi.advanceTimersByTime(200);
  expect(document.querySelector('.generation-tooltip')).toBeNull();

  handle.teardown();
});

test('keyboard: focus opens immediately, Escape closes', () => {
  const { anchor, handle } = mount([successRun()]);

  anchor.dispatchEvent(new FocusEvent('focus'));
  expect(document.querySelector('.generation-tooltip')).not.toBeNull();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.querySelector('.generation-tooltip')).toBeNull();

  // The anchor was made focusable for keyboard users.
  expect(anchor.getAttribute('tabindex')).toBe('0');

  handle.teardown();
});

test('getRuns is consulted at open time — later runs appear without remounting', () => {
  const runs: GenerationRun[] = [];
  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  const handle = mountGenerationTooltip(document.body, { anchor, getRuns: () => runs });

  hoverOpen(anchor);
  expect(document.querySelector('.generation-tooltip')).toBeNull();

  runs.push(successRun());
  anchor.dispatchEvent(new MouseEvent('mouseleave'));
  hoverOpen(anchor);
  expect(document.querySelector('.generation-tooltip')).not.toBeNull();

  handle.teardown();
});

function mountTagged(
  runs: GenerationRun[],
  onRemoveRequest = vi.fn(),
): { anchor: HTMLElement; handle: GenerationTooltipHandle; onRemoveRequest: ReturnType<typeof vi.fn> } {
  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  const handle = mountGenerationTooltip(document.body, {
    anchor,
    getRuns: () => runs,
    isTagged: () => true,
    onRemoveRequest,
  });
  return { anchor, handle, onRemoveRequest };
}

test('tagged doc with zero runs: card opens with the empty state and the Remove button', () => {
  // Files tagged before history tracking existed (or outside this app):
  // payload present, no run records — the card must still be reachable.
  const { anchor, handle } = mountTagged([]);
  hoverOpen(anchor);

  const card = document.querySelector('.generation-tooltip')!;
  expect(card.textContent).toContain('No generation history for this file');
  expect(card.querySelector('.generation-tooltip__remove')).not.toBeNull();

  handle.teardown();
});

test('tagged doc with runs: run list plus the Remove button, no empty state', () => {
  const { anchor, handle } = mountTagged([successRun()]);
  hoverOpen(anchor);

  const card = document.querySelector('.generation-tooltip')!;
  expect(card.querySelectorAll('.generation-tooltip__entry')).toHaveLength(1);
  expect(card.textContent).not.toContain('No generation history for this file');
  // The action sits on TOP of the history stack, above the newest entry.
  expect(card.firstElementChild!.className).toBe('generation-tooltip__remove');

  handle.teardown();
});

test('untagged doc with runs (after a removal): history survives, no Remove button', () => {
  const { anchor, handle } = mount([successRun()]);
  hoverOpen(anchor);

  const card = document.querySelector('.generation-tooltip')!;
  expect(card.querySelectorAll('.generation-tooltip__entry')).toHaveLength(1);
  expect(card.querySelector('.generation-tooltip__remove')).toBeNull();

  handle.teardown();
});

test('clicking the Remove button fires onRemoveRequest', () => {
  const { anchor, handle, onRemoveRequest } = mountTagged([successRun()]);
  hoverOpen(anchor);

  const button = document.querySelector<HTMLButtonElement>('.generation-tooltip__remove')!;
  button.click();
  expect(onRemoveRequest).toHaveBeenCalledTimes(1);

  handle.teardown();
});

test('a removed event renders as its own compact entry', () => {
  const { anchor, handle } = mount([
    successRun(),
    {
      ...successRun(),
      outcome: 'removed',
      providerKind: '',
      baseUrl: '',
      model: '',
      durationMs: 0,
      attempts: 0,
      finishedAt: '2026-07-17T10:00:00',
    },
  ]);
  hoverOpen(anchor);

  const entries = document.querySelectorAll('.generation-tooltip__entry');
  expect(entries).toHaveLength(2);
  // Newest first: the removal is on top.
  expect(entries[0].textContent).toContain('Zoom layers removed');
  expect(entries[0].textContent).toContain('July 17, 2026');
  // A removal entry has no provider rows.
  expect(entries[0].textContent).not.toContain('Inference:');
  expect(entries[0].textContent).not.toContain('Model:');

  handle.teardown();
});

test('teardown removes the card, the listeners, and is idempotent', () => {
  const { anchor, handle } = mount([successRun()]);
  hoverOpen(anchor);
  expect(document.querySelector('.generation-tooltip')).not.toBeNull();

  handle.teardown();
  expect(document.querySelector('.generation-tooltip')).toBeNull();

  // Listeners gone: hovering again opens nothing.
  hoverOpen(anchor);
  expect(document.querySelector('.generation-tooltip')).toBeNull();
  expect(() => handle.teardown()).not.toThrow();
});
