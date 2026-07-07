import { test, expect } from 'vitest';
import { nextScale, SCALE_MIN, SCALE_MAX, SCALE_DEFAULT } from './content-scale';

test('steps up and down by 0.1 without float drift', () => {
  expect(nextScale(SCALE_DEFAULT, 1)).toBe(1.1);
  expect(nextScale(SCALE_DEFAULT, -1)).toBe(0.9);
  expect(nextScale(1.2, 1)).toBe(1.3);
  expect(nextScale(1.1, 1)).toBe(1.2); // no 1.10000000001 drift
});

test('clamps at both bounds', () => {
  expect(nextScale(SCALE_MAX, 1)).toBe(SCALE_MAX);
  expect(nextScale(SCALE_MIN, -1)).toBe(SCALE_MIN);
  // approaching the max from just below clamps exactly
  expect(nextScale(2.45, 1)).toBe(SCALE_MAX);
});
