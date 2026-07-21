// src/ui/diagrams/diagram-component.test.ts
import { test, expect, vi, beforeEach } from 'vitest';

const panZoomInstances: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
vi.mock('svg-pan-zoom', () => ({
  default: vi.fn(() => {
    const instance = { destroy: vi.fn() };
    panZoomInstances.push(instance);
    return instance;
  }),
}));

import {
  registerDiagramProvider,
  clearDiagramProviders,
  type DiagramProvider,
} from './provider';
import { mountDiagram, teardownDiagramsIn } from './diagram-component';
import { actions$ } from '../../state/store';

function stubProvider(overrides: Partial<DiagramProvider> = {}): DiagramProvider {
  return {
    language: 'mermaid',
    validate: () => ({ ok: true }),
    render: async () => '<svg><g id="flowchart-A-0"><text>Start</text></g></svg>',
    extractGraph: () => ({ nodes: [{ id: 'A', label: 'Start' }], edges: [] }),
    ...overrides,
  };
}

function makePre(source: string): HTMLElement {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  document.body.appendChild(pre);
  return pre;
}

beforeEach(() => {
  clearDiagramProviders();
  panZoomInstances.length = 0;
  document.body.replaceChildren();
});

test('returns null and leaves the <pre> untouched for an unregistered language', () => {
  const pre = makePre('graph TD; A-->B');
  const handle = mountDiagram(pre, 'python');
  expect(handle).toBeNull();
  expect(document.body.contains(pre)).toBe(true);
});

test('replaces the <pre> with a .diagram container for a registered language', () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  expect(document.body.contains(pre)).toBe(false);
  expect(document.body.querySelector('.diagram')).toBeTruthy();
});

test('after the async render resolves, the sanitized SVG is in the DOM and svg-pan-zoom was instantiated', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('.diagram__svg-host svg')).toBeTruthy();
  });
  expect(panZoomInstances).toHaveLength(1);
});

test('a validate() failure shows the error badge and the source, never inserts SVG', async () => {
  registerDiagramProvider(
    stubProvider({ validate: () => ({ ok: false, message: 'bad syntax' }) }),
  );
  const pre = makePre('not a diagram');
  mountDiagram(pre, 'mermaid');
  const errorEl = document.body.querySelector('.diagram__error');
  expect(errorEl?.textContent).toContain('bad syntax');
  expect(document.body.querySelector('.diagram__svg-host svg')).toBeNull();
  const sourceEl = document.body.querySelector<HTMLElement>('.diagram__source');
  expect(sourceEl?.hidden).toBe(false);
  expect(sourceEl?.textContent).toContain('not a diagram');
});

test('a render() rejection shows the error badge', async () => {
  registerDiagramProvider(
    stubProvider({ render: async () => { throw new Error('render exploded'); } }),
  );
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('.diagram__error')?.textContent).toContain('render exploded');
  });
});

test('the source toggle reveals and re-hides the raw source', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('.diagram__svg-host svg')).toBeTruthy();
  });
  const toggle = document.body.querySelector<HTMLButtonElement>('.diagram__source-toggle')!;
  const sourceEl = document.body.querySelector<HTMLElement>('.diagram__source')!;
  expect(sourceEl.hidden).toBe(true);
  toggle.click();
  expect(sourceEl.hidden).toBe(false);
  toggle.click();
  expect(sourceEl.hidden).toBe(true);
});

test('clicking a mapped graph node dispatches DIAGRAM_NODE_SELECTED', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(document.body.querySelector('#flowchart-A-0')).toBeTruthy();
  });
  const dispatched: unknown[] = [];
  const sub = actions$.subscribe((a) => dispatched.push(a));
  document.body.querySelector<SVGElement>('#flowchart-A-0')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  sub.unsubscribe();
  expect(dispatched).toContainEqual(
    expect.objectContaining({ type: 'DIAGRAM_NODE_SELECTED', nodeId: 'A', label: 'Start' }),
  );
});

test('teardown destroys the svg-pan-zoom instance', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  const handle = mountDiagram(pre, 'mermaid')!;
  await vi.waitFor(() => {
    expect(panZoomInstances).toHaveLength(1);
  });
  handle.teardown();
  expect(panZoomInstances[0].destroy).toHaveBeenCalledTimes(1);
});

test('teardownDiagramsIn finds and tears down every diagram under a root', async () => {
  registerDiagramProvider(stubProvider());
  const pre = makePre('graph TD; A-->B');
  mountDiagram(pre, 'mermaid');
  await vi.waitFor(() => {
    expect(panZoomInstances).toHaveLength(1);
  });
  teardownDiagramsIn(document.body);
  expect(panZoomInstances[0].destroy).toHaveBeenCalledTimes(1);
});
