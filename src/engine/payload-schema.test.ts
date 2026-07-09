// @vitest-environment node
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// Schema declares "$schema": draft 2020-12, which the default `ajv` build's
// meta-schema doesn't know. Use the 2020 build so Ajv understands it.
// (Per Task 1.6 CRITICAL note; strict:false is kept as specified.)
import Ajv from 'ajv/dist/2020';

const HEAD = '<!-- semantic-zoom:payload:v1';
const TAIL = '-->';

function extractPayload(src: string): string {
  const start = src.lastIndexOf(HEAD);
  expect(start).toBeGreaterThan(-1);
  const jsonStart = start + HEAD.length;
  const end = src.slice(jsonStart).lastIndexOf(TAIL) + jsonStart;
  return src.slice(jsonStart, end).trim();
}

test('fixture payload conforms to the v1 JSON Schema', () => {
  const src = readFileSync(new URL('../../fixtures/zoom_test.md', import.meta.url), 'utf8');
  const payload = JSON.parse(extractPayload(src));
  const schema = JSON.parse(readFileSync(new URL('./payload.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const ok = validate(payload);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
});
