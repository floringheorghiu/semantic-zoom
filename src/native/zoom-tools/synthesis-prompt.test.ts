// synthesis-prompt.test.ts
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_HEADER, CONTRACT_FOOTER, DEFAULT_EDITORIAL,
  buildSystemPrompt, BUILTIN_TEMPLATES,
} from './synthesis-prompt.mjs';

describe('buildSystemPrompt', () => {
  it('default assembly reproduces the ratified prompt byte-for-byte', () => {
    // Pinned against the spec doc's prompt (docs/prompts/engine-b-synthesis.md).
    // If this fails after an intentional contract edit, update the snapshot AND the spec together.
    expect(buildSystemPrompt()).toMatchSnapshot();
  });
  it('contract wraps any editorial text', () => {
    const p = buildSystemPrompt('Write everything as pirate speech.');
    expect(p.startsWith(CONTRACT_HEADER)).toBe(true);
    expect(p.endsWith(CONTRACT_FOOTER)).toBe(true);
    expect(p).toContain('pirate speech');
    expect(p).toContain('HARD RULES');
    expect(p).toContain('OUTPUT SHAPE');
  });
  it('every builtin template assembles with the full contract', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const p = buildSystemPrompt(t.text);
      expect(p).toContain('Sections must be contiguous ranges');
      expect(p).toContain('"meta": { "title": "string", "body": "string" }');
    }
  });
});
