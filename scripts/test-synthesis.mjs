#!/usr/bin/env node
// test-synthesis.mjs — T6's live acceptance check for the Engine B
// prompt+retry loop, run OUTSIDE the app (no Tauri runtime available in a
// plain Node script) but against the SAME portable modules
// src/native/engine-b-remote.ts uses (src/native/zoom-tools/**) — the only
// thing this script does differently is call the provider directly over
// HTTP instead of through Rust's llm_complete, since that command only
// exists inside a running Tauri app. The retry-loop logic itself (prompt
// build, output-contract check, check-layers, buildLookupTable, corrective
// retry) is copied here deliberately close to engine-b-remote.ts's
// synthesize() so this script exercises the real algorithm, not a stand-in.
//
// Usage:
//   node scripts/test-synthesis.mjs --provider ollama [--runs 3]
//   node scripts/test-synthesis.mjs --provider cerebras [--runs 3]
//
// Never touches fixtures/zoom_test.md itself — copies its pre-payload body
// to a temp file first (CLAUDE.md: fixtures are read-only oracles).

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { segment } from '../src/native/zoom-tools/segment.mjs';
import { buildLookupTable, AssembleError } from '../src/native/zoom-tools/assemble.mjs';
import { checkLayers } from '../src/native/zoom-tools/check-layers.mjs';
import { prePayloadSource } from '../src/native/zoom-tools/marker.mjs';
import { SYNTHESIS_SYSTEM_PROMPT, buildUserMessage } from '../src/native/zoom-tools/synthesis-prompt.mjs';
import { checkOutputContract, normalizeSynthesisOutput, stripMarkdownFence, toAssemblerLayers } from '../src/native/zoom-tools/output-contract.mjs';

const args = process.argv.slice(2);
const providerArg = args[args.indexOf('--provider') + 1] ?? 'ollama';
const runs = Number(args[args.indexOf('--runs') + 1] ?? 3);

const PROVIDERS = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'gemma4:latest', needsKey: false },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', model: 'gemma-4-31b', needsKey: true },
};

const provider = PROVIDERS[providerArg];
if (!provider) {
  console.error(`unknown --provider "${providerArg}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(1);
}

function getKeyFromKeychain() {
  // Read the key into a JS variable only — never console.log it, never
  // let it appear in this process's own stdout/stderr.
  const out = execFileSync('security', [
    'find-generic-password', '-w', '-a', 'default', '-s', 'com.semantic-zoom.llm-api-key',
  ], { encoding: 'utf8' });
  return out.trim();
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
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`provider returned HTTP ${res.status}: ${await res.text()}`);
  }
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

/** Mirrors engine-b-remote.ts's synthesize() retry loop exactly, minus the invoke() call. */
async function synthesizeOnce(source) {
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
      const { table } = buildLookupTable(source, layers);
      return { table, layers, attempts: attempt };
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

async function main() {
  const fixtureRaw = readFileSync('fixtures/zoom_test.md', 'utf8');
  const source = prePayloadSource(fixtureRaw);

  const tmpDir = mkdtempSync(join(tmpdir(), 'szoom-synthesis-'));
  writeFileSync(join(tmpDir, 'source.md'), source, 'utf8');
  console.log(`provider=${providerArg} model=${provider.model} runs=${runs}`);
  console.log(`temp copy: ${join(tmpDir, 'source.md')} (fixture itself untouched)`);

  let successes = 0;
  const retryLog = [];

  for (let run = 1; run <= runs; run++) {
    const start = Date.now();
    try {
      const { layers, attempts } = await synthesizeOnce(source);
      const layersPath = join(tmpDir, `layers-run${run}.json`);
      writeFileSync(layersPath, JSON.stringify(layers, null, 2));

      // Final gate, exactly as the Check specifies: check-layers.mjs on the result.
      execFileSync('node', ['tools/semantic-zoom-tools/scripts/check-layers.mjs', layersPath], { stdio: 'inherit' });

      successes++;
      retryLog.push(attempts);
      console.log(`run ${run}/${runs}: SUCCESS in ${attempts} attempt(s), ${Date.now() - start}ms`);
    } catch (e) {
      retryLog.push(null);
      console.log(`run ${run}/${runs}: FAILED (${Date.now() - start}ms) — ${e.message}`);
    }
  }

  console.log(`\n${successes}/${runs} runs succeeded within the ${MAX_ATTEMPTS}-retry budget.`);
  console.log(`retries per run: ${retryLog.map((a) => a ?? 'FAIL').join(', ')}`);
  process.exit(successes === runs ? 0 : 1);
}

main();
