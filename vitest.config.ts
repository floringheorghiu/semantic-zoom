import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // tools/semantic-zoom-tools has its OWN test suite (tests/*.test.mjs,
    // run via `npm test` there using Node's built-in test runner) — vitest's
    // default include glob otherwise picks those files up too (they match
    // *.test.mjs) and fails since they use node:test's `test`, not vitest's.
    // Scoped to that one plugin, NOT tools/** — a future tools/<other>/
    // utility with vitest-style tests must not be silently skipped.
    // Spread vitest's own defaults rather than replace them — `exclude`
    // overwrites, it doesn't merge.
    exclude: [...configDefaults.exclude, 'tools/semantic-zoom-tools/**'],
  },
});
