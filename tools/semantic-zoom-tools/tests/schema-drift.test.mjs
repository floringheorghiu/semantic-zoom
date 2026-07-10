// Drift guard: REQUIRED_TOP_LEVEL_KEYS in assemble.mjs is a deliberate
// hand-copy of the payload JSON Schema's `required` array (the plugin must
// stay standalone-installable, so it can't reach into src/engine at
// runtime). Nothing else would notice if a future schema revision moved
// the two lists apart — this test does, whenever it runs inside the repo
// where both files coexist. On a standalone plugin install (no ../../src),
// it skips rather than fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_TOP_LEVEL_KEYS } from '../scripts/validate.mjs';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'src', 'engine', 'payload.schema.json',
);

test('REQUIRED_TOP_LEVEL_KEYS matches the app schema\'s required list (in-repo only)', (t) => {
  if (!existsSync(SCHEMA_PATH)) {
    t.skip('app schema not present (standalone plugin install) — nothing to compare against');
    return;
  }
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  assert.deepEqual([...REQUIRED_TOP_LEVEL_KEYS].sort(), [...schema.required].sort());
});
