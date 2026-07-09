import { test, expect } from 'vitest';
import { truncateId, idRange, buildMetaCard, buildMilestoneDivider, buildSidLabel } from './cards';
import type { LookupTable } from '../engine/schema';

// --- truncateId --------------------------------------------------------------

test('truncateId keeps the prefix + hash, drops the ordinal, marks the elision', () => {
  expect(truncateId('S-ab80d77b-0')).toBe('S-ab80d77b…');
  expect(truncateId('P-1c9a2b3f-0')).toBe('P-1c9a2b3f…');
});

test('truncateId drops a multi-digit ordinal', () => {
  expect(truncateId('S-02a9a62b-12')).toBe('S-02a9a62b…');
  expect(truncateId('P-1c9a2b3f-107')).toBe('P-1c9a2b3f…');
});

test('truncateId leaves odd input alone rather than mangling it', () => {
  expect(truncateId('M1')).toBe('M1');       // positional meta id (D6)
  expect(truncateId('')).toBe('');
  expect(truncateId('S-')).toBe('S-');
  expect(truncateId('no-ordinal-here')).toBe('no-ordinal-here');
  // Short hash (test fixtures) is kept whole, not padded.
  expect(truncateId('S-s1-0')).toBe('S-s1…');
});

// --- idRange -----------------------------------------------------------------

test('idRange: empty → empty string', () => {
  expect(idRange([])).toBe('');
});

test('idRange: a single id → just that truncated id (no dash)', () => {
  expect(idRange(['S-ab80d77b-0'])).toBe('S-ab80d77b…');
});

test('idRange: many ids → first – last, en dash, spaced, ignoring the middle', () => {
  const range = idRange(['S-ab80d77b-0', 'S-deadbeef-0', 'S-02a9a62b-3']);
  expect(range).toBe('S-ab80d77b… – S-02a9a62b…');
  expect(range).toContain('–'); // en dash, not a hyphen
  expect(range).not.toContain('deadbeef');
});

// --- Fixtures ----------------------------------------------------------------

const table: LookupTable = {
  version: 1,
  docHash: 'a'.repeat(64),
  meta: {
    M1: {
      id: 'M1',
      level: -2,
      children: ['S-ab80d77b-0', 'S-02a9a62b-0'],
      title: 'The data backbone',
      body: '**Accomplished:** shapes were written\n\n**Next step:** read the table',
    },
    M2: { id: 'M2', level: -2, children: ['S-cafebabe-0'], title: 'Solo', body: 'plain prose' },
  },
  sections: {},
  paragraphs: {},
  order: { meta: ['M1', 'M2'], sections: [], paragraphs: [] },
};

// --- buildMetaCard -----------------------------------------------------------

test('buildMetaCard renders .metacard[data-mid] with header, body and footer', () => {
  const card = buildMetaCard(table, 'M1');

  expect(card.classList.contains('pgroup')).toBe(true);
  expect(card.classList.contains('metacard')).toBe(true);
  expect(card.dataset.mid).toBe('M1');

  // header: the `M1` label + the milestone title
  const head = card.querySelector('.metacard-head')!;
  expect(head.querySelector('.metacard-label')?.textContent).toBe('M1');
  expect(head.querySelector('.metacard-title')?.textContent).toBe('The data backbone');

  // body: the existing summary rendering
  const body = card.querySelector('.metacard-body')!;
  expect(body.querySelector('.summary-card')).not.toBeNull();
  expect(body.querySelectorAll('.summary-row').length).toBe(2);

  // footer: "N sections" · rule · ID range
  const foot = card.querySelector('.metacard-foot')!;
  expect(foot.querySelector('.metacard-count')?.textContent).toBe('2 sections');
  expect(foot.querySelector('.metacard-rule')).not.toBeNull();
  expect(foot.querySelector('.metacard-ids')?.textContent).toBe('S-ab80d77b… – S-02a9a62b…');
});

test('buildMetaCard pluralizes a single-section footer and takes the prose body path', () => {
  const card = buildMetaCard(table, 'M2');
  expect(card.querySelector('.metacard-count')?.textContent).toBe('1 section');
  expect(card.querySelector('.metacard-ids')?.textContent).toBe('S-cafebabe…');
  expect(card.querySelector('.metacard-body .summary-body')).not.toBeNull();
});

test('buildMetaCard on an unknown mid still yields an anchorable .pgroup[data-mid]', () => {
  const card = buildMetaCard(table, 'M9');
  expect(card.classList.contains('pgroup')).toBe(true);
  expect(card.dataset.mid).toBe('M9');
  expect(card.querySelector('.metacard-head')).toBeNull();
});

test('buildMetaCard never positions the card (offsetParent invariant)', () => {
  const card = buildMetaCard(table, 'M1');
  expect(card.style.position).toBe('');
});

// --- buildMilestoneDivider ---------------------------------------------------

test('buildMilestoneDivider renders the M-label + milestone title', () => {
  const divider = buildMilestoneDivider(table, 'M1');
  expect(divider.classList.contains('milestone-divider')).toBe(true);
  expect(divider.classList.contains('pgroup')).toBe(false); // chrome, not an anchor
  expect(divider.dataset.mid).toBe('M1');
  expect(divider.querySelector('.milestone-label')?.textContent).toBe('M1');
  expect(divider.querySelector('.milestone-title')?.textContent).toBe('The data backbone');
});

test('buildMilestoneDivider on an unknown mid renders an empty title, not undefined', () => {
  expect(buildMilestoneDivider(table, 'M9').querySelector('.milestone-title')?.textContent).toBe('');
});

// --- buildSidLabel -----------------------------------------------------------

test('buildSidLabel renders the truncated id in normal flow', () => {
  const label = buildSidLabel('S-ab80d77b-0');
  expect(label.classList.contains('sid-label')).toBe(true);
  expect(label.textContent).toBe('S-ab80d77b…');
  expect(label.style.position).toBe('');
});
