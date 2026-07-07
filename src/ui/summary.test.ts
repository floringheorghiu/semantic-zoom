import { test, expect } from 'vitest';
import { renderSummaryBody } from './viewport';

test('labeled body renders a card of badge-tagged rows with semantic variants', () => {
  const host = document.createElement('div');
  const body = [
    '**What this covers:** the data backbone',
    '**Accomplished:** shapes were written',
    '**Blockers:** the fallback is not built',
    '**Prerequisites:** none',
    '**Next step:** read the decisions table',
  ].join('\n\n');

  renderSummaryBody(host, body);

  const card = host.querySelector('.summary-card');
  expect(card).not.toBeNull();
  const rows = host.querySelectorAll('.summary-row');
  expect(rows.length).toBe(5);

  const variants = [...host.querySelectorAll('.badge')].map((b) =>
    (b as HTMLElement).dataset.variant,
  );
  expect(variants).toEqual(['covers', 'done', 'blocker', 'prereq', 'next']);

  // Badge text is the original label; the wall-of-bold labels are gone.
  expect(host.querySelector('.badge')?.textContent).toBe('What this covers');
  expect(host.querySelector('.summary-text')?.textContent).toBe('the data backbone');
});

test('inline emphasis inside a segment becomes <strong>, not literal asterisks', () => {
  const host = document.createElement('div');
  renderSummaryBody(host, '**Next step:** read the **decisions** table');
  const text = host.querySelector('.summary-text')!;
  expect(text.querySelector('strong')?.textContent).toBe('decisions');
  expect(text.textContent).not.toContain('*');
});

test('unlabeled prose falls back to paragraphs, no card', () => {
  const host = document.createElement('div');
  renderSummaryBody(host, 'A plain walkthrough.\n\nSecond paragraph.');
  expect(host.querySelector('.summary-card')).toBeNull();
  const paras = host.querySelectorAll('.summary-body p');
  expect(paras.length).toBe(2);
  expect(paras[0].textContent).toBe('A plain walkthrough.');
});
