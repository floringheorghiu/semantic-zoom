#!/usr/bin/env node
// test-e2e-synthesis.mjs — T9's automated acceptance check: the FULL chain
// from an untagged fixture copy through a real embedded, on-disk payload,
// verified by both gates (validate.mjs AND the authoritative verify_payload
// Rust binary). This is what write_payload (T8) does inside the running
// app; here it's driven directly in JS so the check runs without a live
// Tauri process, exercising the exact same portable modules T8's Rust code
// and T6's retry loop both depend on.
//
// Usage: node scripts/test-e2e-synthesis.mjs [--provider ollama|cerebras]
//
// Never touches fixtures/zoom_test.md itself (CLAUDE.md: read-only oracle).

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { segment } from '../src/native/zoom-tools/segment.mjs';
import { buildLookupTable, AssembleError } from '../src/native/zoom-tools/assemble.mjs';
import { checkLayers } from '../src/native/zoom-tools/check-layers.mjs';
import { prePayloadSource, MARKER_HEAD, MARKER_TAIL } from '../src/native/zoom-tools/marker.mjs';
import { SYNTHESIS_SYSTEM_PROMPT, buildUserMessage } from '../src/native/zoom-tools/synthesis-prompt.mjs';
import { checkOutputContract, normalizeSynthesisOutput, stripMarkdownFence, toAssemblerLayers } from '../src/native/zoom-tools/output-contract.mjs';

const providerArg = process.argv.includes('--provider')
  ? process.argv[process.argv.indexOf('--provider') + 1]
  : 'ollama';

const PROVIDERS = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'gemma4:latest', needsKey: false },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', model: 'gemma-4-31b', needsKey: true },
};
const provider = PROVIDERS[providerArg];

function getKeyFromKeychain() {
  return execFileSync('security', [
    'find-generic-password', '-w', '-a', 'default', '-s', 'com.semantic-zoom.llm-api-key',
  ], { encoding: 'utf8' }).trim();
}

async function callProvider(systemPrompt, userMessage, temperature = 0) {
  const key = provider.needsKey ? getKeyFromKeychain() : null;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`provider returned HTTP ${res.status}: ${await res.text()}`);
  const parsed = await res.json();
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error('provider returned no choices');
  return content;
}

function correctiveMessage(baseUserMessage, violation) {
  return `${baseUserMessage}\n\n--- CORRECTION REQUIRED ---\n` +
    `Your previous response was rejected for this specific reason:\n${violation}\n\n` +
    `Fix exactly this issue and resend the complete JSON object, following all the ` +
    `rules above. Do not explain the fix — output only the corrected JSON.`;
}

const MAX_ATTEMPTS = 3;
// Mirrors engine-b-remote.ts: retries only happen when the temp-0 output was
// unusable, and temp-0 retries reproduce the mistake verbatim.
const TEMPERATURE_BY_ATTEMPT = [0.0, 0.3, 0.6];

/** Mirrors engine-b-remote.ts's synthesize() retry loop, minus the invoke() call. */
async function synthesize(source) {
  const { blocks } = segment(source);
  const inputIds = blocks.map((b) => b.id);
  const heading = blocks.find((b) => b.kind === 'heading');
  const title = heading ? heading.text.replace(/^#+\s*/, '').trim() : 'Untitled document';
  const baseUserMessage = buildUserMessage(title, blocks);

  let userMessage = baseUserMessage;
  let lastViolation = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const responseText = await callProvider(SYNTHESIS_SYSTEM_PROMPT, userMessage, TEMPERATURE_BY_ATTEMPT[attempt - 1] ?? 0.6);
    let parsed;
    try {
      parsed = JSON.parse(stripMarkdownFence(responseText));
    } catch (e) {
      lastViolation = `response was not valid JSON: ${e.message}`;
      userMessage = correctiveMessage(baseUserMessage, lastViolation);
      continue;
    }
    // Mirrors engine-b-remote.ts: collapse within-section id repeats (a
    // deterministic table-block model tic) before the contract check.
    parsed = normalizeSynthesisOutput(parsed);

    const contractResult = checkOutputContract(parsed, inputIds);
    if (!contractResult.ok) {
      lastViolation = contractResult.error;
      userMessage = correctiveMessage(baseUserMessage, lastViolation);
      continue;
    }
    const layers = toAssemblerLayers(parsed);
    const layersResult = checkLayers(layers);
    if (!layersResult.ok) {
      lastViolation = layersResult.errors[0];
      userMessage = correctiveMessage(baseUserMessage, lastViolation);
      continue;
    }
    try {
      return buildLookupTable(source, layers); // { table, docHash, prefix }
    } catch (e) {
      if (e instanceof AssembleError) {
        lastViolation = e.message;
        userMessage = correctiveMessage(baseUserMessage, lastViolation);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`synthesis failed after ${MAX_ATTEMPTS} attempts. Last rejection: ${lastViolation}`);
}

/** Mirrors write_payload.rs's escape_marker_collisions + marker wrap exactly. */
function embedPayload(prefix, table) {
  let payloadJson = JSON.stringify(table);
  payloadJson = payloadJson.split(MARKER_TAIL).join('--\\u003e');
  payloadJson = payloadJson.split(MARKER_HEAD).join(`\\u003c${MARKER_HEAD.slice(1)}`);
  return prefix + `${MARKER_HEAD}\n${payloadJson}\n${MARKER_TAIL}\n`;
}

async function main() {
  const fixtureRaw = readFileSync('fixtures/zoom_test.md', 'utf8');
  const source = prePayloadSource(fixtureRaw);

  const tmpDir = mkdtempSync(join(tmpdir(), 'szoom-e2e-'));
  const untaggedPath = join(tmpDir, 'untagged.md');
  writeFileSync(untaggedPath, source, 'utf8');
  console.log(`[1/4] untagged fixture copy: ${untaggedPath} (fixture itself untouched)`);

  console.log(`[2/4] synthesizing via ${providerArg} (${provider.model})...`);
  const { table, prefix } = await synthesize(source);
  console.log(`      paragraphs=${Object.keys(table.paragraphs).length} sections=${Object.keys(table.sections).length} meta=${Object.keys(table.meta).length}`);

  const embedded = embedPayload(prefix, table);
  writeFileSync(untaggedPath, embedded, 'utf8');
  console.log(`[3/4] embedded payload written to ${untaggedPath}`);

  execFileSync('node', ['tools/semantic-zoom-tools/scripts/validate.mjs', untaggedPath], { stdio: 'inherit' });
  console.log('      validate.mjs: PASS');

  execFileSync('cargo', [
    'run', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'verify_payload', '--', untaggedPath,
  ], { stdio: 'inherit' });
  console.log('[4/4] verify_payload: PASS');

  console.log(`\nT9 automated acceptance: PASS (${providerArg})`);
  console.log(`Generated file for human read: ${untaggedPath}`);
}

main().catch((e) => {
  console.error(`T9 automated acceptance: FAIL — ${e.message}`);
  process.exit(1);
});
