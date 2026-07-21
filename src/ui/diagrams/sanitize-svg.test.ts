import { test, expect } from 'vitest';
import { sanitizeSvg } from './sanitize-svg';

test('strips <script> tags', () => {
  const dirty = '<svg><script>alert(1)</script><rect width="10" height="10"/></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('<script');
  expect(clean).not.toContain('alert(1)');
  expect(clean).toContain('<rect');
});

test('strips onclick/onload event handler attributes', () => {
  const dirty = '<svg><rect onclick="alert(1)" width="10" height="10"/></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('onclick');
});

test('strips <foreignObject> (a known SVG XSS vector)', () => {
  const dirty = '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml" onload="alert(1)"/></foreignObject></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('foreignObject');
  expect(clean).not.toContain('onload');
});

test('strips javascript: URLs from href', () => {
  const dirty = '<svg><a href="javascript:alert(1)"><text>click</text></a></svg>';
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toContain('javascript:');
});

test('keeps benign SVG structure and attributes intact', () => {
  const benign = '<svg width="100" height="50"><g class="node"><rect width="10" height="10"/><text>A</text></g></svg>';
  const clean = sanitizeSvg(benign);
  expect(clean).toContain('<rect');
  expect(clean).toContain('<text');
  expect(clean).toContain('class="node"');
});
