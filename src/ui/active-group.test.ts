import { test, expect, vi } from 'vitest';
import { markActiveGroup, clearActiveGroups, sectionAtTop } from './active-group';

/** A `.level-layer` holding three groups: two section groups + one meta card. */
function layerWith(): { layer: HTMLElement; groups: Record<string, HTMLElement> } {
  const layer = document.createElement('div');
  layer.className = 'level-layer';

  const mk = (attr: 'sid' | 'mid', id: string): HTMLElement => {
    const el = document.createElement('section');
    el.className = 'pgroup';
    el.dataset[attr] = id;
    layer.appendChild(el);
    return el;
  };

  return {
    layer,
    groups: {
      'S-1': mk('sid', 'S-1'),
      'S-2': mk('sid', 'S-2'),
      M1: mk('mid', 'M1'),
    },
  };
}

const active = (el: HTMLElement): boolean => el.hasAttribute('data-active');

// --- markActiveGroup ---------------------------------------------------------

test('markActiveGroup marks the target group by data-sid', () => {
  const { layer, groups } = layerWith();
  markActiveGroup(layer, 'S-2', null);
  expect(active(groups['S-2'])).toBe(true);
  expect(active(groups['S-1'])).toBe(false);
  expect(active(groups.M1)).toBe(false);
});

test('markActiveGroup marks the target group by data-mid (k=−2 MetaCard)', () => {
  const { layer, groups } = layerWith();
  markActiveGroup(layer, 'M1', null);
  expect(active(groups.M1)).toBe(true);
});

test('markActiveGroup moves the marker off prev and onto active', () => {
  const { layer, groups } = layerWith();
  markActiveGroup(layer, 'S-1', null);
  markActiveGroup(layer, 'S-2', 'S-1');
  expect(active(groups['S-1'])).toBe(false);
  expect(active(groups['S-2'])).toBe(true);
  expect(layer.querySelectorAll('[data-active]').length).toBe(1);
});

test('markActiveGroup is a no-op when the active group is unchanged', () => {
  const { layer, groups } = layerWith();
  markActiveGroup(layer, 'S-1', null);
  const set = vi.spyOn(groups['S-1'], 'setAttribute');
  const remove = vi.spyOn(groups['S-1'], 'removeAttribute');

  markActiveGroup(layer, 'S-1', 'S-1');

  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(active(groups['S-1'])).toBe(true);
});

test('markActiveGroup with null active clears prev and marks nothing', () => {
  const { layer, groups } = layerWith();
  markActiveGroup(layer, 'S-1', null);
  markActiveGroup(layer, null, 'S-1');
  expect(layer.querySelectorAll('[data-active]').length).toBe(0);
  expect(active(groups['S-1'])).toBe(false);
});

test('markActiveGroup tolerates null↔null and ids that are not mounted', () => {
  const { layer } = layerWith();
  expect(() => markActiveGroup(layer, null, null)).not.toThrow();
  expect(() => markActiveGroup(layer, 'S-nope', 'S-gone')).not.toThrow();
  expect(layer.querySelectorAll('[data-active]').length).toBe(0);
});

test('markActiveGroup touches ONLY the prev and active elements', () => {
  const { layer, groups } = layerWith();
  markActiveGroup(layer, 'S-1', null);

  // A third, uninvolved group must see zero attribute writes.
  const set = vi.spyOn(groups.M1, 'setAttribute');
  const remove = vi.spyOn(groups.M1, 'removeAttribute');
  const prevRemove = vi.spyOn(groups['S-1'], 'removeAttribute');
  const activeSet = vi.spyOn(groups['S-2'], 'setAttribute');

  markActiveGroup(layer, 'S-2', 'S-1');

  expect(set).toHaveBeenCalledTimes(0);
  expect(remove).toHaveBeenCalledTimes(0);
  expect(prevRemove).toHaveBeenCalledTimes(1);
  expect(activeSet).toHaveBeenCalledTimes(1);
});

// --- clearActiveGroups (layer rebuild) ---------------------------------------

test('clearActiveGroups drops every marker (survives a keyed reconcile)', () => {
  const { layer, groups } = layerWith();
  groups['S-1'].setAttribute('data-active', '');
  groups.M1.setAttribute('data-active', '');

  clearActiveGroups(layer);

  expect(layer.querySelectorAll('[data-active]').length).toBe(0);
});

test('clearActiveGroups on a freshly built layer is a no-op', () => {
  const { layer, groups } = layerWith();
  const remove = vi.spyOn(groups['S-1'], 'removeAttribute');
  clearActiveGroups(layer);
  expect(remove).not.toHaveBeenCalled();
});

// --- sectionAtTop -------------------------------------------------------------

const BOXES = [
  { id: 'S-1', offsetTop: 0 },
  { id: 'S-2', offsetTop: 500 },
  { id: 'S-3', offsetTop: 520 }, // a short section right after a tall one
  { id: 'S-4', offsetTop: 2000 }, // e.g. after a section padded by a big code block
];

test('sectionAtTop picks the last section whose top has scrolled past', () => {
  expect(sectionAtTop(BOXES, 0)).toBe('S-1');
  expect(sectionAtTop(BOXES, 499)).toBe('S-1');
  expect(sectionAtTop(BOXES, 500)).toBe('S-2');
  expect(sectionAtTop(BOXES, 521)).toBe('S-3');
  expect(sectionAtTop(BOXES, 1999)).toBe('S-3');
  expect(sectionAtTop(BOXES, 2000)).toBe('S-4');
  expect(sectionAtTop(BOXES, 9999)).toBe('S-4'); // past the last section: stays on it
});

test('sectionAtTop defaults to the first section when scrolled above it', () => {
  const boxes = [{ id: 'S-1', offsetTop: 40 }, { id: 'S-2', offsetTop: 200 }];
  expect(sectionAtTop(boxes, 0)).toBe('S-1');
});

test('sectionAtTop is completely unaffected by any section height — only offsetTop matters', () => {
  // Same offsetTops as BOXES, but imagine S-2 were secretly a 480px content-
  // visibility placeholder standing in for a 3000px section with a big code
  // block: sectionAtTop never reads a height at all, so the result cannot
  // change because of a wrong height estimate.
  expect(sectionAtTop(BOXES, 510)).toBe('S-2');
});

test('sectionAtTop returns null for an empty list', () => {
  expect(sectionAtTop([], 100)).toBeNull();
});
