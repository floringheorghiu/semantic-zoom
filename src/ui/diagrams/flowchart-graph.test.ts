import { test, expect } from 'vitest';
import { parseFlowchart } from './flowchart-graph';

test('parses node definitions with each shape delimiter', () => {
  const source = 'flowchart TD\nA[Start]\nB(Round)\nC{Decision}';
  const graph = parseFlowchart(source);
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      { id: 'A', label: 'Start' },
      { id: 'B', label: 'Round' },
      { id: 'C', label: 'Decision' },
    ]),
  );
  expect(graph.edges).toEqual([]);
});

test('parses a plain arrow edge and infers both endpoint nodes', () => {
  const source = 'graph TD\nA[Start] --> B[End]';
  const graph = parseFlowchart(source);
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      { id: 'A', label: 'Start' },
      { id: 'B', label: 'End' },
    ]),
  );
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({ from: 'A', to: 'B', label: undefined });
});

test('parses a labeled edge', () => {
  const source = 'graph TD\nB{Decision} -- yes --> C[End]';
  const graph = parseFlowchart(source);
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({ from: 'B', to: 'C', label: 'yes' });
});

test('parses a plain (no-arrowhead) edge', () => {
  const source = 'graph TD\nA --- B';
  const graph = parseFlowchart(source);
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({ from: 'A', to: 'B' });
});

test('a realistic multi-line flowchart produces the expected node/edge counts', () => {
  const source = [
    'flowchart TD',
    'A[Start] --> B{Decision}',
    'B -- yes --> C[End]',
    'B -- no --> D[Retry]',
    'D --> B',
  ].join('\n');
  const graph = parseFlowchart(source);
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C', 'D']);
  expect(graph.edges).toHaveLength(4);
});

test('out-of-subset syntax (e.g. a sequence diagram) yields an empty graph without throwing', () => {
  const source = 'sequenceDiagram\n  Alice->>Bob: Hello Bob';
  expect(() => parseFlowchart(source)).not.toThrow();
  const graph = parseFlowchart(source);
  expect(graph.nodes).toEqual([]);
  expect(graph.edges).toEqual([]);
});

test('empty source yields an empty graph', () => {
  expect(parseFlowchart('')).toEqual({ nodes: [], edges: [] });
});
