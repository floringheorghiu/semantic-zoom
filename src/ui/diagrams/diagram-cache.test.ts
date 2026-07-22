import { test, expect } from 'vitest';
import { fnv1a, cacheKey, DiagramCache } from './diagram-cache';

test('fnv1a is deterministic for the same input', () => {
  expect(fnv1a('graph TD; A-->B')).toBe(fnv1a('graph TD; A-->B'));
});

test('fnv1a differs for different input', () => {
  expect(fnv1a('graph TD; A-->B')).not.toBe(fnv1a('graph TD; A-->C'));
});

test('cacheKey differs when theme differs, same source', () => {
  const light = cacheKey('graph TD; A-->B', 'light', '10.9.0');
  const dark = cacheKey('graph TD; A-->B', 'dark', '10.9.0');
  expect(light).not.toBe(dark);
});

test('cacheKey differs when providerVersion differs, same source+theme', () => {
  const v1 = cacheKey('graph TD; A-->B', 'light', '10.9.0');
  const v2 = cacheKey('graph TD; A-->B', 'light', '10.9.1');
  expect(v1).not.toBe(v2);
});

test('DiagramCache: set then get returns the same value', () => {
  const cache = new DiagramCache();
  cache.set('k1', { svg: '<svg>1</svg>' });
  expect(cache.get('k1')).toEqual({ svg: '<svg>1</svg>' });
});

test('DiagramCache: miss returns undefined', () => {
  const cache = new DiagramCache();
  expect(cache.get('missing')).toBeUndefined();
});

test('DiagramCache: evicts the least-recently-used entry past its capacity', () => {
  const cache = new DiagramCache(2);
  cache.set('a', { svg: 'A' });
  cache.set('b', { svg: 'B' });
  cache.get('a'); // 'a' is now more recently used than 'b'
  cache.set('c', { svg: 'C' }); // over capacity → evict 'b', the least recently used
  expect(cache.get('a')).toEqual({ svg: 'A' });
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('c')).toEqual({ svg: 'C' });
});

test('DiagramCache: clear empties it', () => {
  const cache = new DiagramCache();
  cache.set('k1', { svg: '<svg>1</svg>' });
  cache.clear();
  expect(cache.get('k1')).toBeUndefined();
});
