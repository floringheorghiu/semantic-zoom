// engine-b-remote.ts — the real Synthesizer implementation (§2.7's
// interface, §8.5's flow). main.ts is the only place that chooses this over
// engine-b.ts's stubSynthesizer; engine-b.ts's interface never changes.
//
// Segmentation/assembly reuse the portable zoom-tools/** modules (T4) —
// the same code the CLI plugin runs — so a payload this module produces is
// held to the identical mechanical bar as a hand-tagged file. The LLM call
// itself goes through Rust's `llm_complete` (T5): this file never sees the
// API key, only the completion text.

import { invoke } from '@tauri-apps/api/core';
import type { Synthesizer } from '../engine/engine-b';
import type { LookupTable } from '../engine/schema';
import { segment } from './zoom-tools/segment.mjs';
import { buildLookupTable, AssembleError } from './zoom-tools/assemble.mjs';
import { checkLayers } from './zoom-tools/check-layers.mjs';
import { prePayloadSource } from './zoom-tools/marker.mjs';
import { buildSystemPrompt, buildUserMessage } from './zoom-tools/synthesis-prompt.mjs';
import { checkOutputContract, normalizeSynthesisOutput, stripMarkdownFence, toAssemblerLayers } from './zoom-tools/output-contract.mjs';
import type { SegmentBlock } from './zoom-tools/types';
import { resolveTemplate, type PromptTemplatesConfig } from './template-resolve';

const MAX_ATTEMPTS = 3;

/**
 * Attempt 1 runs at 0.0 — the synthesis contract mandates greedy decoding
 * for grouping stability (S- ids derive from grouping). Retries raise it:
 * a retry only ever happens because the temp-0 output was UNUSABLE, and a
 * temp-0 model re-fed a near-identical prompt reproduces its mistake
 * verbatim — three identical failures for triple the GPU time (observed
 * live, 2026-07-15: retries 2 and 3 byte-identical to attempt 1). Grouping
 * determinism of an output that never passes validation protects nothing.
 */
const TEMPERATURE_BY_ATTEMPT = [0.0, 0.3, 0.6];

export class SynthesisAbortedError extends Error {}

/** Mirrors llm_client.rs's `Completion` (camelCase over the bridge). */
interface LlmCompletion {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * Metadata about the most recent synthesis run — the generation-history
 * tooltip's raw material. A side channel rather than a Synthesizer interface
 * change (that interface is the stable seam engine-b.ts owns); safe because
 * the app has exactly ONE synthesis in flight at a time (switchMap
 * semantics, LlmCancelState's supersede rule).
 */
export interface SynthesisRunMeta {
  /** Retry-ladder attempts actually used (1–3). */
  attempts: number;
  /** Temperature of the FINAL attempt — the one whose output (or final
      rejection) the run's outcome describes. */
  temperature: number;
  /** Provider-reported usage of the final attempt, if it sent any. */
  usage: { promptTokens?: number; completionTokens?: number } | null;
  /** Display name of the resolved summarization template this run used
      (Task 8). Recorded into generation history starting PR 3; harmless
      extra field on the meta object until then. */
  template: string;
}

let lastRunMeta: SynthesisRunMeta | null = null;

/** Meta of the last remoteSynthesizer run, success or failure. Null when no
    provider call was ever made (pre-flight refusal, empty document). */
export function lastSynthesisRunMeta(): SynthesisRunMeta | null {
  return lastRunMeta;
}

/**
 * Token/cost ceiling (D10, plan §8.6): v1 refuses documents over the model's
 * context limit with a clear message — no silent truncation or chunking.
 * ProviderConfig carries no per-model context size, so v1 uses a fixed
 * conservative ceiling instead of a true per-model limit: 32k input tokens
 * covers every provider in the current matrix (a ~100-block document
 * measured ~20k — see llm_client.rs's timeout note) while still refusing
 * before a genuinely oversized prompt reaches — and fails opaquely at — the
 * provider. A per-model limit would arrive as a ProviderConfig field.
 */
export const MAX_INPUT_TOKENS = 32_000;

/** ~4 chars/token, rounded UP — the refusal must err conservative. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Model-facing document title: first heading's text, else a generic label. */
function deriveTitle(blocks: SegmentBlock[]): string {
  const heading = blocks.find((b) => b.kind === 'heading');
  return heading ? heading.text.replace(/^#+\s*/, '').trim() : 'Untitled document';
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SynthesisAbortedError('synthesis aborted');
}

export const remoteSynthesizer: Synthesizer = {
  async synthesize(raw: string, signal: AbortSignal): Promise<LookupTable> {
    lastRunMeta = null;
    checkAborted(signal);

    const source = prePayloadSource(raw);
    const { blocks } = segment(source);
    if (blocks.length === 0) {
      throw new Error('Document has no paragraph-level content to synthesize.');
    }
    const inputIds = blocks.map((b) => b.id);
    const title = deriveTitle(blocks);
    const baseUserMessage = buildUserMessage(title, blocks);

    // Template resolution (Task 8): fetch the user's saved template config
    // and resolve it to one editorial text, used for BOTH the token estimate
    // below and every llm_complete call this run makes. `.catch(() => null)`
    // means a config read failure degrades to the 'general' default rather
    // than failing the whole run — resolveTemplate(null) never throws.
    const templatesConfig = await invoke<PromptTemplatesConfig | null>('get_prompt_templates').catch(() => null);
    const tpl = resolveTemplate(templatesConfig);
    const systemPrompt = buildSystemPrompt(tpl.text);

    // Refuse BEFORE the first provider call — the whole model input (system
    // prompt + document-bearing user message), not just the raw source, is
    // what has to fit. Corrective retries only append a short violation note,
    // so the pre-flight estimate stands for all attempts.
    const inputTokens = estimateTokens(systemPrompt + baseUserMessage);
    if (inputTokens > MAX_INPUT_TOKENS) {
      throw new Error(
        `Document is too large to generate a summary: ~${inputTokens.toLocaleString()} tokens ` +
        `exceeds the model context limit of ${MAX_INPUT_TOKENS.toLocaleString()}. ` +
        `Nothing was sent to the provider (v1 refuses rather than truncating).`,
      );
    }

    let userMessage = baseUserMessage;
    let lastViolation = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      checkAborted(signal);

      // jsonMode: grammar-constrained JSON decoding (Ollama format:json /
      // OpenAI response_format), per the synthesis contract's invocation
      // settings — the prompt's "Output ONLY JSON" line is the fallback,
      // not the mechanism. A wild-document run broke JSON syntax on all 3
      // attempts before this was wired in.
      const temperature = TEMPERATURE_BY_ATTEMPT[attempt - 1] ?? 0.6;
      const completion = await invoke<LlmCompletion>('llm_complete', {
        systemPrompt,
        userMessage,
        jsonMode: true,
        temperature,
      });
      const responseText = completion.content;
      lastRunMeta = { attempts: attempt, temperature, usage: completion.usage ?? null, template: tpl.name };

      checkAborted(signal);

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripMarkdownFence(responseText));
      } catch (e) {
        lastViolation = `response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
        userMessage = correctiveMessage(baseUserMessage, lastViolation);
        continue;
      }

      // Collapse within-section id repeats before the contract check — a
      // deterministic model tic (one table = one block, but the model emits
      // its id once per row) that no retry can fix at temperature 0. See
      // normalizeSynthesisOutput's doc comment for the incident.
      parsed = normalizeSynthesisOutput(parsed);

      const contractResult = checkOutputContract(parsed, inputIds);
      if (!contractResult.ok) {
        lastViolation = contractResult.error;
        userMessage = correctiveMessage(baseUserMessage, lastViolation);
        continue;
      }

      // toAssemblerLayers only runs once checkOutputContract confirms the
      // {meta, sections[].children} shape — safe to assume it here.
      const layers = toAssemblerLayers(parsed as Parameters<typeof toAssemblerLayers>[0]);

      const layersResult = checkLayers(layers);
      if (!layersResult.ok) {
        lastViolation = layersResult.errors[0];
        userMessage = correctiveMessage(baseUserMessage, lastViolation);
        continue;
      }

      try {
        const { table } = buildLookupTable(source, layers);
        return table;
      } catch (e) {
        if (e instanceof AssembleError) {
          lastViolation = e.message;
          userMessage = correctiveMessage(baseUserMessage, lastViolation);
          continue;
        }
        throw e;
      }
    }

    throw new Error(
      `Engine B synthesis failed after ${MAX_ATTEMPTS} attempts. Last rejection: ${lastViolation}`,
    );
  },
};

function correctiveMessage(baseUserMessage: string, violation: string): string {
  return (
    `${baseUserMessage}\n\n` +
    `--- CORRECTION REQUIRED ---\n` +
    `Your previous response was rejected for this specific reason:\n${violation}\n\n` +
    `Fix exactly this issue and resend the complete JSON object, following all the ` +
    `rules above. Do not explain the fix — output only the corrected JSON.`
  );
}
