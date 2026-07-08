import { test, expect, vi } from 'vitest';

import { buildIndex, type LookupTable } from '../engine/schema';
import {
  buildMapModel,
  visibleIds,
  mountContentMap,
  type MapEntry,
} from './content-map';

/**
 * A two-milestone table: M1 → [S1, S2], M2 → [S3, S4, S5]. Only the fields
 * `buildMapModel` reads are populated (order arrays + section parents).
 */
function fixture(): { table: LookupTable; index: ReturnType<typeof buildIndex> } {
  const section = (id: string, parent: string): LookupTable['sections'][string] => ({
    id,
    level: -1,
    parent,
    children: [],
    title: id,
    body: '',
  });
  const meta = (id: string, children: string[]): LookupTable['meta'][string] => ({
    id,
    level: -2,
    children,
    title: id,
    body: '',
  });
  const table: LookupTable = {
    version: 1,
    docHash: 'deadbeef',
    meta: { M1: meta('M1', ['S1', 'S2']), M2: meta('M2', ['S3', 'S4', 'S5']) },
    sections: {
      S1: section('S1', 'M1'),
      S2: section('S2', 'M1'),
      S3: section('S3', 'M2'),
      S4: section('S4', 'M2'),
      S5: section('S5', 'M2'),
    },
    paragraphs: {},
    order: { meta: ['M1', 'M2'], sections: ['S1', 'S2', 'S3', 'S4', 'S5'], paragraphs: [] },
  };
  return { table, index: buildIndex(table) };
}

const EXPECTED_SECTION_MODEL: MapEntry[] = [
  { kind: 'bar', id: 'S1' },
  { kind: 'bar', id: 'S2' },
  { kind: 'sep' },
  { kind: 'bar', id: 'S3' },
  { kind: 'bar', id: 'S4' },
  { kind: 'bar', id: 'S5' },
];

// --- buildMapModel ----------------------------------------------------------

test('buildMapModel at k=0: section bars with a separator at the milestone boundary', () => {
  const { table, index } = fixture();
  expect(buildMapModel(table, index, 0)).toEqual(EXPECTED_SECTION_MODEL);
});

test('buildMapModel at k=-1 matches k=0 (same section bars + separators)', () => {
  const { table, index } = fixture();
  expect(buildMapModel(table, index, -1)).toEqual(EXPECTED_SECTION_MODEL);
});

test('buildMapModel never emits a leading or trailing separator', () => {
  const { table, index } = fixture();
  const model = buildMapModel(table, index, 0);
  expect(model[0]).toEqual({ kind: 'bar', id: 'S1' });
  expect(model[model.length - 1]).toEqual({ kind: 'bar', id: 'S5' });
  // Exactly one boundary between two milestones.
  expect(model.filter((e) => e.kind === 'sep')).toHaveLength(1);
});

test('buildMapModel at k=-2: milestone bars only, no separators', () => {
  const { table, index } = fixture();
  expect(buildMapModel(table, index, -2)).toEqual([
    { kind: 'bar', id: 'M1' },
    { kind: 'bar', id: 'M2' },
  ]);
});

// --- visibleIds -------------------------------------------------------------

const BOXES = [
  { id: 'a', offsetTop: 0, offsetHeight: 100 }, // entirely above the window
  { id: 'b', offsetTop: 100, offsetHeight: 100 }, // straddles the top edge
  { id: 'c', offsetTop: 200, offsetHeight: 50 }, // fully inside
  { id: 'd', offsetTop: 250, offsetHeight: 100 }, // straddles the bottom edge
  { id: 'e', offsetTop: 350, offsetHeight: 100 }, // entirely below the window
];

test('visibleIds returns every box intersecting the scroll window', () => {
  // window = [150, 350)
  expect(visibleIds(BOXES, 150, 200)).toEqual(new Set(['b', 'c', 'd']));
});

test('visibleIds excludes boxes that only touch an edge (half-open interval)', () => {
  // window = [100, 200): 'a' ends exactly at 100, 'c' starts exactly at 200.
  expect(visibleIds(BOXES, 100, 100)).toEqual(new Set(['b']));
});

test('visibleIds on an empty window or empty box list yields an empty set', () => {
  // clientHeight 0 (layer hidden / not yet laid out) → nothing is visible,
  // even though the window sits inside box 'b'.
  expect(visibleIds(BOXES, 150, 0)).toEqual(new Set());
  expect(visibleIds([], 0, 500)).toEqual(new Set());
});

test('visibleIds excludes a zero-height group sitting inside the window', () => {
  const boxes = [{ id: 'empty-section', offsetTop: 150, offsetHeight: 0 }];
  expect(visibleIds(boxes, 100, 200)).toEqual(new Set());
});

// --- mountContentMap --------------------------------------------------------

const MODEL: MapEntry[] = EXPECTED_SECTION_MODEL;

test('render builds one bar per group and one dot per separator', () => {
  const host = document.createElement('aside');
  const map = mountContentMap(host, { onSelect: vi.fn() });
  map.render(MODEL);

  expect(host.querySelectorAll('.map-bar')).toHaveLength(5);
  expect(host.querySelectorAll('.map-sep')).toHaveLength(1);
  expect([...host.querySelectorAll('.map-bar')].map((b) => (b as HTMLElement).dataset.barId)).toEqual([
    'S1',
    'S2',
    'S3',
    'S4',
    'S5',
  ]);
  const bar = host.querySelector<HTMLElement>('.map-bar')!;
  expect(bar.getAttribute('role')).toBe('button');
  expect(bar.getAttribute('tabindex')).toBe('0');
  map.teardown();
});

test('clicking a bar calls onSelect with its group id', () => {
  const host = document.createElement('aside');
  const onSelect = vi.fn();
  const map = mountContentMap(host, { onSelect });
  map.render(MODEL);

  host.querySelector<HTMLElement>('.map-bar[data-bar-id="S4"]')!.click();
  expect(onSelect).toHaveBeenCalledWith('S4');
  expect(onSelect).toHaveBeenCalledTimes(1);

  // Separator dots are inert.
  host.querySelector<HTMLElement>('.map-sep')!.click();
  expect(onSelect).toHaveBeenCalledTimes(1);
  map.teardown();
});

test('Enter and Space on a focused bar call onSelect', () => {
  const host = document.createElement('aside');
  const onSelect = vi.fn();
  const map = mountContentMap(host, { onSelect });
  map.render(MODEL);

  const bar = host.querySelector<HTMLElement>('.map-bar[data-bar-id="S2"]')!;
  bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  bar.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenNthCalledWith(1, 'S2');
  map.teardown();
});

test('setActive toggles data-active on exactly the given bars', () => {
  const host = document.createElement('aside');
  const map = mountContentMap(host, { onSelect: vi.fn() });
  map.render(MODEL);

  const active = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('.map-bar[data-active]')].map((b) => b.dataset.barId!);

  expect(active()).toEqual([]);
  map.setActive(new Set(['S2', 'S3']));
  expect(active()).toEqual(['S2', 'S3']);

  map.setActive(new Set(['S3', 'S4']));
  expect(active()).toEqual(['S3', 'S4']);

  map.setActive(new Set());
  expect(active()).toEqual([]);
  map.teardown();
});

test('teardown empties the host and detaches listeners', () => {
  const host = document.createElement('aside');
  const onSelect = vi.fn();
  const map = mountContentMap(host, { onSelect });
  map.render(MODEL);
  const bar = host.querySelector<HTMLElement>('.map-bar[data-bar-id="S1"]')!;

  map.teardown();
  expect(host.children).toHaveLength(0);

  bar.click(); // detached node, listener removed from the (now empty) list
  expect(onSelect).not.toHaveBeenCalled();
});
