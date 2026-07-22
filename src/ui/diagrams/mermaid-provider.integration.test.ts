// src/ui/diagrams/mermaid-provider.integration.test.ts
//
// mermaid-provider.test.ts mocks `mermaid` entirely (real rendering needs
// `getBBox`, which jsdom doesn't implement — see that file's module doc).
// That's the right call for unit-testing this provider's own logic, but it
// means NOTHING in the automated suite ever exercised real Mermaid output
// through the real sanitizer — which is exactly how a real bug shipped
// undetected: Mermaid's default flowchart renderer puts ALL label text
// inside <foreignObject> (confirmed by direct render: 0 <text> elements, 3
// foreignObject blocks for a 2-node flowchart), and sanitize-svg.ts's
// FORBID_TAGS strips <foreignObject> as an XSS defense — silently deleting
// every flowchart's visible label text along with it. Sequence diagrams use
// plain <text> and were unaffected, which is why the bug wasn't obvious
// from a single manual test.
//
// This file stubs ONLY the two SVG layout APIs jsdom is missing
// (`getBBox`/`getComputedTextLength`) and otherwise runs the REAL `mermaid`
// package through the REAL `sanitizeSvg`, so a regression here means a
// diagram would genuinely render with missing or stripped label text in
// the real app, not just in a mock's imagination.
import { test, expect, beforeAll } from 'vitest';
import { mermaidProvider } from './mermaid-provider';

beforeAll(() => {
  // Minimal layout stubs — enough for Mermaid's dagre-based layout pass to
  // complete without throwing; the actual returned numbers don't matter for
  // this test (it checks text/foreignObject presence, not exact geometry).
  // @ts-expect-error `getBBox` is spec'd on SVGGraphicsElement, but jsdom's
  // SVG element classes don't actually chain through it at runtime — every
  // SVG element (including the <text> nodes Mermaid measures) inherits
  // directly from SVGElement in jsdom, so patching SVGGraphicsElement's
  // prototype (the type-correct target) silently does nothing here.
  SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 }) as DOMRect;
  // @ts-expect-error jsdom has no real text-measurement implementation
  SVGElement.prototype.getComputedTextLength = () => 50;
});

test('a real flowchart render keeps its label text visible after sanitization', async () => {
  const svg = await mermaidProvider.render('graph TD\nA[Start] --> B{Decision}', { theme: 'light' });
  expect(svg).not.toContain('foreignObject');
  expect(svg).toContain('Start');
  expect(svg).toContain('Decision');
});

test('a real sequence diagram render keeps its label text visible after sanitization', async () => {
  const svg = await mermaidProvider.render('sequenceDiagram\n  User->>App: Submit form', { theme: 'light' });
  expect(svg).not.toContain('foreignObject');
  expect(svg).toContain('Submit form');
});
