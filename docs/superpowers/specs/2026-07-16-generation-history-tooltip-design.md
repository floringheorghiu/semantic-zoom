# Generation-history tooltip on the status label — design

<!-- Shipped untagged — the semantic-zoom tagging wrapper isn't built yet
     (CLAUDE.md "Zoom-ready authoring"); delivered via the normal Untagged path. -->

Date: 2026-07-16. Figma: tooltip card node `241:456` ("Tooltip-LLM-results");
in-context screengrabs show placement under the top-right status label.

## Purpose

The top-right status label becomes a permanent, glanceable entry point into
the document's Engine B generation history. Hovering it opens a card listing
past runs (newest first) with enough detail to review and compare results
afterwards — including which provider/model produced them, how long they
took, real token counts, and the sampling temperature that produced the
output.

## What is recorded

One history entry per completed generation **run** (a click of Generate →
success or failure). User-cancelled runs are **never** recorded. Entries are
keyed to the document's absolute file path and persist across app restarts.
A renamed/moved file starts with an empty history (accepted limitation).

Entry fields:

| Field | Source | Notes |
|---|---|---|
| outcome | run result | `succeeded` \| `failed` |
| provider kind + base URL host | provider config at run start | rendered "Ollama, local" / "Custom server, local" / "<host>, remote" |
| model | provider config at run start | e.g. `gemma4:latest` |
| duration (ms) | measured around the run | rendered "5 min 28 sec" |
| finished at (ISO timestamp) | run end | rendered "July 16, 2026 12:34 PM" as **Created** |
| version | count of prior successful runs for this doc (+1 on success) | failed runs show the version that existed at the time; 0 if never succeeded |
| attempts | retry-ladder attempts actually used (1–3) | rendered "Succeeded on attempt 1." / "Failed after 3 attempts." |
| temperature | of the FINAL attempt | the temp that actually produced the reviewed output (ladder: 0.0 → 0.35 → 0.6) |
| tokens in / out | `usage` block of the FINAL attempt's provider response | real counts, not estimates; absent (—) if the provider omits usage |
| output shape | successful runs only | "4 milestones · 12 sections" from the written table's `order` |
| error | failed runs only | the full error string, rendered as the quoted paragraph under Attempts |

## Storage (Rust owns disk truth)

`generation-history.json` in the app config dir, beside
`provider-config.json`, following `provider_config.rs`'s store pattern:
`{ "<absolute doc path>": [entries…] }`, capped at the **20 most recent
entries per document** (drop oldest). Corrupt/missing file → empty history,
never an error.

Two new Tauri commands (same crossing class as the existing
provider-config/llm commands — the three sacred crossings of document truth
are untouched):

- `get_generation_history(path) -> Vec<GenerationRun>`
- `append_generation_run(path, run) -> Vec<GenerationRun>` (returns the
  updated list so the frontend re-renders from disk truth)

## Token usage plumbing

`llm_client.rs`'s `ChatResponse` gains the optional OpenAI-compatible
`usage` field (`prompt_tokens`, `completion_tokens`). `llm_complete` returns
`{ content: String, usage: Option<{prompt_tokens, completion_tokens}> }`
instead of a bare `String`. `engine-b-remote.ts`'s `remoteSynthesizer`
adapts, and its result (and error path) reports `attemptsUsed`,
`temperature`, and `usage` of the final attempt so `main.ts` can assemble
the history entry. All providers speak this response shape (Ollama,
llama.cpp-style custom servers, Cerebras); `usage` stays optional because
the schema allows omission.

## Status label (always visible)

`status-badge.ts`'s note becomes a permanent pill with a leading status dot:

- green dot, "Zoomable" — document has summaries (currently: empty label)
- gray dot, "No summary layer" — untagged, no failed last run
- amber dot, "No summary layer" — untagged and the most recent recorded run
  failed (the screengrab's red-dot state)
- "Generating summary… m:ss" and corrupt states unchanged in content, but
  presented in the same pill shape

## Tooltip card (`src/ui/generation-tooltip.ts`, new)

- Pure DOM, no `@tauri-apps/*` (ui/ boundary). `mount()` returns teardown;
  main.ts owns the lifecycle and passes the history entries in.
- Anchored below the status label, right-aligned to it (per screengrabs),
  fixed width ~440px, max-height ~60vh with internal scroll; entries newest
  first, separated by hairlines. Styling per Figma node 241:456 (12px Inter,
  60px semibold label column at 50% ink, 20px row gap, white card, 8px
  radius, 20px padding, shadow + hairline border), themed via existing
  tokens.
- Opens after a ~300 ms hover delay on the label; stays open while the
  pointer is over label or card; closes on leave or Escape. Also opens on
  keyboard focus of the label (accessibility parity). Fades `opacity` only
  (D1).
- **No entries → no tooltip** (fresh raw file). The rule is simply
  "non-empty history ⇔ tooltip available", regardless of whether a
  generation is currently in flight.
- Not a modal: it never blocks input, consistent with status-badge.ts's
  non-modal rule — it's a hover disclosure of status detail.

## Wiring (main.ts)

- On document load: fetch history for the new path; render label state from
  (summariesAvailable, history).
- In `handleGenerate`: capture provider config + start time; on
  success/failure append the entry via `append_generation_run`, update the
  in-memory list from the command's return, refresh label/tooltip.
  `handleCancel` appends nothing.
- Document close / switch tears the tooltip down.

## Testing

- Rust: store round-trip, per-doc cap, corrupt-file tolerance, usage
  deserialization (with and without `usage` in the response).
- TS unit: tooltip renders success and failure entries per the mocks
  (field rows, quoted error, newest-first), hover open/close/Escape/focus
  behavior, no-entries → never mounts, teardown idempotence.
- Round-trip guard (task 1.2 test) unaffected — no payload changes.

## Out of scope

- History for documents generated outside this app (no payload inspection).
- Cross-file history migration on rename/move.
- Cost estimation from token counts.
