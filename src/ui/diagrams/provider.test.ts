import { test, expect, beforeEach } from 'vitest';
import {
  registerDiagramProvider,
  getDiagramProvider,
  clearDiagramProviders,
  type DiagramProvider,
} from './provider';

beforeEach(() => clearDiagramProviders());

function stubProvider(language: string): DiagramProvider {
  return {
    language,
    validate: () => ({ ok: true }),
    render: async () => '<svg></svg>',
    extractGraph: () => ({ nodes: [], edges: [] }),
  };
}

test('getDiagramProvider returns undefined for an unregistered language', () => {
  expect(getDiagramProvider('mermaid')).toBeUndefined();
});

test('registerDiagramProvider makes a provider retrievable by its language', () => {
  const provider = stubProvider('mermaid');
  registerDiagramProvider(provider);
  expect(getDiagramProvider('mermaid')).toBe(provider);
});

test('registering a second provider for a different language does not clobber the first', () => {
  const mermaid = stubProvider('mermaid');
  const d2 = stubProvider('d2');
  registerDiagramProvider(mermaid);
  registerDiagramProvider(d2);
  expect(getDiagramProvider('mermaid')).toBe(mermaid);
  expect(getDiagramProvider('d2')).toBe(d2);
});

test('clearDiagramProviders empties the registry', () => {
  registerDiagramProvider(stubProvider('mermaid'));
  clearDiagramProviders();
  expect(getDiagramProvider('mermaid')).toBeUndefined();
});
