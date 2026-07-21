// src/ui/diagrams/mermaid-provider.test.ts
import { test, expect, vi, beforeEach } from 'vitest';

// mermaid.render performs real layout Mermaid needs `getBBox` for, which
// jsdom doesn't implement — mock the library boundary rather than exercising
// real rendering (see design spec §9). This also keeps these tests fast and
// deterministic, independent of Mermaid's actual SVG output.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(),
    render: vi.fn(),
  },
}));

import mermaid from 'mermaid';
import { mermaidProvider } from './mermaid-provider';

beforeEach(() => {
  vi.clearAllMocks();
});

test('language is "mermaid"', () => {
  expect(mermaidProvider.language).toBe('mermaid');
});

test('validate: ok when mermaid.parse succeeds', () => {
  vi.mocked(mermaid.parse).mockReturnValue(true as unknown as ReturnType<typeof mermaid.parse>);
  expect(mermaidProvider.validate('graph TD; A-->B')).toEqual({ ok: true });
});

test('validate: not ok when mermaid.parse returns false', () => {
  vi.mocked(mermaid.parse).mockReturnValue(false as unknown as ReturnType<typeof mermaid.parse>);
  const result = mermaidProvider.validate('not a diagram');
  expect(result.ok).toBe(false);
});

test('validate: not ok when mermaid.parse throws', () => {
  vi.mocked(mermaid.parse).mockImplementation(() => {
    throw new Error('Parse error on line 1');
  });
  const result = mermaidProvider.validate('garbage');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('Parse error on line 1');
});

test('render: calls mermaid.render and returns a sanitized SVG', async () => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg><script>bad</script><rect/></svg>', diagramType: 'flowchart' });
  // Distinct source from the cache-hit/theme-miss tests below: the module
  // cache is a singleton shared across all tests in this file (vitest
  // isolates per test FILE, not per test), so reusing the same source+theme
  // here would pre-populate the cache and make those tests' call-count
  // assertions spuriously pass/fail depending on run order.
  const svg = await mermaidProvider.render('graph TD; X-->Y', { theme: 'light' });
  expect(svg).toContain('<rect');
  expect(svg).not.toContain('<script');
});

test('render: a second call with identical source+theme does not call mermaid.render again (cache hit)', async () => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg><rect/></svg>', diagramType: 'flowchart' });
  await mermaidProvider.render('graph TD; A-->B', { theme: 'light' });
  await mermaidProvider.render('graph TD; A-->B', { theme: 'light' });
  expect(mermaid.render).toHaveBeenCalledTimes(1);
});

test('render: a different theme is a cache miss even with identical source', async () => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg><rect/></svg>', diagramType: 'flowchart' });
  // Distinct source from the earlier cache-hit test, for the same singleton-
  // cache reason noted above.
  await mermaidProvider.render('graph TD; M-->N', { theme: 'light' });
  await mermaidProvider.render('graph TD; M-->N', { theme: 'dark' });
  expect(mermaid.render).toHaveBeenCalledTimes(2);
});

test('extractGraph: flowchart source parses into nodes/edges', () => {
  const graph = mermaidProvider.extractGraph('graph TD\nA[Start] --> B[End]');
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      { id: 'A', label: 'Start' },
      { id: 'B', label: 'End' },
    ]),
  );
  expect(graph.edges).toHaveLength(1);
});

test('extractGraph: non-flowchart source returns an empty graph', () => {
  const graph = mermaidProvider.extractGraph('sequenceDiagram\n  Alice->>Bob: Hello');
  expect(graph).toEqual({ nodes: [], edges: [] });
});
