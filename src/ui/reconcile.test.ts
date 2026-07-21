import { test, expect, vi } from 'vitest';
import { reconcile } from '../state/reload';
import { buildIndex, type LookupTable, type ParagraphNode, type SectionNode } from '../engine/schema';

function makeTable(sections: Array<[string, string[]]>): LookupTable {
  const paragraphs: Record<string, ParagraphNode> = {};
  const sectionRec: Record<string, SectionNode> = {};
  const orderSections: string[] = [];
  const orderParagraphs: string[] = [];
  for (const [sid, children] of sections) {
    orderSections.push(sid);
    sectionRec[sid] = { id: sid, level: -1, parent: 'M1', children: [...children], title: sid, body: '' };
    for (const pid of children) {
      orderParagraphs.push(pid);
      paragraphs[pid] = { id: pid, level: 0, parent: sid, kind: 'prose', span: { start: 0, end: 0 }, html: '' };
    }
  }
  return {
    version: 1,
    docHash: 'x'.repeat(64),
    meta: { M1: { id: 'M1', level: -2, children: orderSections, title: 'm', body: '' } },
    sections: sectionRec,
    paragraphs,
    order: { meta: ['M1'], sections: orderSections, paragraphs: orderParagraphs },
  };
}

/** A minimal `.pgroup[data-sid]` builder (the injected group factory). */
function makeBuildGroup() {
  return vi.fn((sid: string): HTMLElement => {
    const el = document.createElement('section');
    el.className = 'pgroup';
    el.dataset.sid = sid;
    return el;
  });
}

/** A reading-column whose wholesale-wipe paths throw if the reconcile ever hits them. */
function guardedColumn(): HTMLElement {
  const column = document.createElement('div');
  column.className = 'reading-column';
  Object.defineProperty(column, 'innerHTML', {
    configurable: true,
    get: () => '',
    set: () => {
      throw new Error('innerHTML setter must never be called in reconcile (D7)');
    },
  });
  column.replaceChildren = () => {
    throw new Error('replaceChildren must never be called wholesale in reconcile (D7)');
  };
  return column;
}

function sids(column: HTMLElement): string[] {
  return Array.from(column.querySelectorAll<HTMLElement>('.pgroup')).map((g) => g.dataset.sid!);
}

test('unchanged sid + child-list keeps the SAME DOM node across a reconcile', () => {
  const table = makeTable([['S-s1-0', ['P-a-0', 'P-b-0']], ['S-s2-0', ['P-c-0']]]);
  const index = buildIndex(table);
  const column = guardedColumn();
  const build = makeBuildGroup();

  const first = reconcile(column, table, index, new Map(), build);
  const nodeS1 = first.get('S-s1-0');
  const nodeS2 = first.get('S-s2-0');
  expect(build).toHaveBeenCalledTimes(2);

  const second = reconcile(column, table, index, first, build);
  // Same identity — no rebuild for unchanged groups.
  expect(second.get('S-s1-0')).toBe(nodeS1);
  expect(second.get('S-s2-0')).toBe(nodeS2);
  expect(build).toHaveBeenCalledTimes(2); // no new builds
  expect(sids(column)).toEqual(['S-s1-0', 'S-s2-0']);
});

test('appended section builds only the new node; existing nodes untouched', () => {
  const t1 = makeTable([['S-s1-0', ['P-a-0']], ['S-s2-0', ['P-b-0']]]);
  const t2 = makeTable([['S-s1-0', ['P-a-0']], ['S-s2-0', ['P-b-0']], ['S-s3-0', ['P-c-0']]]);
  const column = guardedColumn();
  const build = makeBuildGroup();

  const first = reconcile(column, t1, buildIndex(t1), new Map(), build);
  const nodeS1 = first.get('S-s1-0');
  const nodeS2 = first.get('S-s2-0');
  build.mockClear();

  const second = reconcile(column, t2, buildIndex(t2), first, build);
  expect(build).toHaveBeenCalledTimes(1);
  expect(build).toHaveBeenCalledWith('S-s3-0');
  expect(second.get('S-s1-0')).toBe(nodeS1); // untouched
  expect(second.get('S-s2-0')).toBe(nodeS2); // untouched
  expect(sids(column)).toEqual(['S-s1-0', 'S-s2-0', 'S-s3-0']);
});

test('removed section unmounts its node; others kept by identity', () => {
  const t1 = makeTable([['S-s1-0', ['P-a-0']], ['S-s2-0', ['P-b-0']], ['S-s3-0', ['P-c-0']]]);
  const t2 = makeTable([['S-s1-0', ['P-a-0']], ['S-s3-0', ['P-c-0']]]);
  const column = guardedColumn();
  const build = makeBuildGroup();

  const first = reconcile(column, t1, buildIndex(t1), new Map(), build);
  const nodeS1 = first.get('S-s1-0');
  const nodeS2 = first.get('S-s2-0');
  const nodeS3 = first.get('S-s3-0');

  const second = reconcile(column, t2, buildIndex(t2), first, build);
  expect(second.has('S-s2-0')).toBe(false);
  expect(nodeS2!.isConnected).toBe(false); // removed from the column
  expect(second.get('S-s1-0')).toBe(nodeS1);
  expect(second.get('S-s3-0')).toBe(nodeS3);
  expect(sids(column)).toEqual(['S-s1-0', 'S-s3-0']);
});

test('changed child-list rebuilds that group; siblings reused', () => {
  const t1 = makeTable([['S-s1-0', ['P-a-0']], ['S-s2-0', ['P-b-0']]]);
  const t2 = makeTable([['S-s1-0', ['P-a-0']], ['S-s2-0', ['P-b-0', 'P-b2-0']]]);
  const column = guardedColumn();
  const build = makeBuildGroup();

  const first = reconcile(column, t1, buildIndex(t1), new Map(), build);
  const nodeS1 = first.get('S-s1-0');
  const nodeS2 = first.get('S-s2-0');
  build.mockClear();

  const second = reconcile(column, t2, buildIndex(t2), first, build);
  expect(second.get('S-s1-0')).toBe(nodeS1); // unchanged → reused
  expect(second.get('S-s2-0')).not.toBe(nodeS2); // child-list changed → rebuilt
  expect(build).toHaveBeenCalledTimes(1);
  expect(build).toHaveBeenCalledWith('S-s2-0');
});

test('onRemove is called for each stale node just before it is removed', () => {
  const buildGroup = makeBuildGroup();
  const column = guardedColumn();
  const removed: HTMLElement[] = [];

  let prev = reconcile(
    column,
    makeTable([['S-a-0', ['P-a-0']], ['S-b-0', ['P-b-0']]]),
    buildIndex(makeTable([['S-a-0', ['P-a-0']], ['S-b-0', ['P-b-0']]])),
    new Map(),
    buildGroup,
  );

  // Second table drops section S-b-0 entirely — its node is now stale.
  const removedNode = prev.get('S-b-0')!;
  reconcile(
    column,
    makeTable([['S-a-0', ['P-a-0']]]),
    buildIndex(makeTable([['S-a-0', ['P-a-0']]])),
    prev,
    buildGroup,
    (el) => removed.push(el),
  );

  expect(removed).toEqual([removedNode]);
});
