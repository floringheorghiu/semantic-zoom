# Engine B Synthesis Prompt — Levels −1 and −2

Status: **prompt spec only.** The deterministic wrapper this prompt assumes
(paragraph segmentation + hashing + post-assembly of `S`/`M` ids, `docHash`,
`order`, and payload embedding) is not implemented yet — see "Required
wrapper" below. Do not treat a payload produced by hand-running this prompt
as valid until that wrapper's `validate()` + `verify_ids()` pass.

## Why the LLM never touches IDs

D6 (`docs/Implementation_Plan.md` §2.1) requires `P-`/`S-` ids to be the
first 8 hex chars of a SHA-256 hash of the node's raw span text plus a
document-order ordinal. An LLM cannot compute SHA-256 reliably, and a
plausible-looking-but-wrong hash is worse than an obviously missing one: it
passes casual review, then fails `verify_ids()` on load, or — if that check
is ever weakened — silently mis-anchors the caret after a hot reload. So the
contract below gives the model already-hashed `P-` ids as opaque input and
asks it for exactly two things it's actually good at: grouping paragraphs
into sections, and writing plain-English prose about them. All id
derivation (`S-` hash, `M1` positional id, `parent` links, `docHash`,
`order`) happens in deterministic code, never in the model's output.

## Required wrapper (not yet built)

1. **Segment** the raw markdown into the same `P`-node units Engine A/`segment()`
   produces (`src/engine/engine-b.ts` §2.7 of the plan): prose, code, list,
   table, heading, blockquote — with byte spans into the pre-payload source.
2. **Hash** each span (SHA-256, first 8 hex chars) and assign
   `P-<hash8>-<ordinal>` per D6.
3. **Call the LLM** with the prompt below, feeding it the ordered `P` index.
   Build each entry's `text` from the node's raw span; truncate any single
   node longer than 40 lines to its first 30 lines plus a final line
   `...(N lines omitted)` — enough for the model to describe the block
   without blowing the context window. Use the invocation settings in
   §"Invocation settings".
4. **Validate the LLM's output mechanically** (§"Output contract" below) —
   reject and retry with a corrective message if any check fails.
5. **Assemble** the full `LookupTable`: derive each section's id as
   `S-<hash8-of-its-first-child>-<ordinal-among-sections-sharing-that-hash8>`
   (the hash8 is just substring-extracted from the leading child's own `P-`
   id — no new hashing needed), assign `M1` to the single meta node, fill
   `parent` back-references, build `order`, compute `docHash` over the
   pre-payload bytes (A1).
6. **Verify** with the Rust `validate()` + `verify_ids()` before writing the
   `<!-- semantic-zoom:payload:v1 ... -->` block to disk.

Everything above except step 3 is ordinary deterministic code — none of it
belongs in the prompt, and none of it should ever be delegated back to the
model "just this once."

## Invocation settings

Grouping stability is not cosmetic: `S-` ids derive from each section's
first child, so a different grouping of identical input produces different
`S-` ids, which defeats the keyed hot-reload reconciliation (D7) for the
whole document. Every knob here exists to make identical input produce
identical grouping:

- **temperature 0** (greedy decoding) on the FIRST attempt; leave top-p/
  top-k at defaults. Retries raise it (0.3, then 0.6): a retry only happens
  because the temp-0 output failed validation, and a temp-0 model re-fed a
  near-identical prompt reproduces its mistake verbatim — observed live
  (2026-07-15), three byte-identical failures for triple the GPU time.
  Grouping determinism of an output that never passes validation protects
  nothing; a payload that assembles at retry temperature is still fully
  mechanically verified.
- **Structured output / JSON mode** if the runtime supports it (Ollama:
  `"format": "json"`); the "Output ONLY the JSON object" instruction is the
  fallback, not the mechanism. Caveat, observed 2026-07-15: some Ollama
  builds/models (gemma4's renderer_parser path) silently IGNORE both the
  OpenAI-style `response_format` and native `format: "json"` — the wrapper
  must therefore never ASSUME grammar-constrained output; the parse-check-
  retry loop stays load-bearing even with JSON mode requested.
- Model per D3: quantized **Gemma 3 4B or Qwen3 4B** via Ollama
  (`http://localhost:11434/api/generate`). Record the exact model tag used
  alongside any payload produced during development.
- Max output tokens: budget ~120 tokens per expected section plus ~300 for
  the meta node; a truncated JSON object fails the output contract and
  wastes a retry.

---

## The prompt

```
SYSTEM:
You are the section/story synthesizer for Semantic Zoom, a tool that lets a
reader view a markdown document at three zoom levels: raw paragraphs (level
0, already written — not your job), plain-English sections (level −1, your
job), and a one-screen story (level −2, your job).

You will receive an ordered list of paragraph-level nodes that have already
been extracted from the document, each with a permanent, opaque id. You do
two things with them:

1. Group them into sections (level −1).
2. Write one story summary of the whole document (level −2).

You never rewrite, correct, or omit the underlying paragraphs — you only add
two layers of description above them.

HARD RULES:
- Treat every `id` field as an opaque token. Copy it byte-for-byte. Never
  invent, edit, renumber, reorder, drop, or duplicate an id.
- Every input id must appear in exactly one section's `children`, and the
  concatenation of all `children` arrays in the order you emit sections must
  equal the input order exactly. (A wrapper checks this mechanically; a
  mismatch discards your entire output and re-prompts you.)
- Sections must be contiguous ranges of the input order — no interleaving.
- Do not emit `id`, `level`, `parent`, `docHash`, or `order` fields anywhere.
  A separate deterministic step derives those; anything you put there is
  ignored or causes a validation failure.
- Do not use the literal three-character sequence "minus minus greater-than"
  (an HTML comment closer) in any string value — the payload this feeds is
  embedded inside an HTML comment. If you must reference it, describe it in
  words ("the comment-closing arrow"). Output containing the raw sequence is
  rejected.
- Output ONLY the JSON object described below. No prose before or after, no
  markdown code fence around it.

USER:
Document title (for context only, not output): {{DOCUMENT_TITLE}}

Paragraph index, in document order:
{{PARAGRAPH_INDEX_JSON}}

Each entry is `{ "id": string, "kind": "prose"|"code"|"list"|"table"|
"heading"|"blockquote", "text": string }`. `text` is the paragraph's content
(long code blocks may be truncated with a `"...(N lines omitted)"` marker —
this does not change how you must treat the id).

TASK:
1. Partition the paragraph index into an ordered sequence of sections,
   applying these rules in order:
   a. Determine the boundary heading depth: the shallowest heading depth
      (fewest '#') that occurs two or more times in the input. If no depth
      occurs twice, use the shallowest depth present. If the input contains
      no headings at all, skip to rule (e).
   b. Start a new section at every heading of exactly that depth. The
      boundary heading is the FIRST child of the section it opens. Deeper
      headings do not start sections; they stay inside the current one.
   c. Paragraphs before the first boundary heading form their own leading
      section (title it from what that preamble says, e.g. the document's
      purpose statement).
   d. Merge exception — apply only when unambiguous: if a boundary heading's
      section would contain nothing but the heading itself (no content
      before the next boundary), merge it into the FOLLOWING section
      instead of emitting an empty-feeling one. If it is the LAST boundary
      heading in the document (nothing follows it), merge it into the
      PRECEDING section instead.
   e. No-headings fallback: group consecutive paragraphs by topic into
      sections of roughly 3–10 paragraphs each, starting a new section
      where the subject clearly shifts.
   Every section must contain at least one paragraph.

2. For each section write:
   - "title": ≤8 words, plain English, no jargon, no code syntax. Someone
     skimming only the titles in order should get an accurate map of the
     document.
   - "body": 2–5 sentences of plain markdown — a walkthrough of what this
     chunk of the document says or does and why it matters to a reader who
     will not read the raw paragraphs. Do not just restate the title. Do not
     assert anything the paragraphs don't support.

3. Write exactly one "meta" object summarizing the entire document:
   - "title": the document's overall one-line purpose.
   - "body": plain markdown with exactly three subheadings, in this order:
     "**Accomplished:**", "**Blockers:**", "**Next steps:**" — each followed
     by 1–4 bullet points grounded only in the paragraph content. If a
     document genuinely has nothing for one of these (e.g. a pure reference
     doc with no blockers), write a single bullet: "None noted."

OUTPUT SHAPE (strict JSON, nothing else):
{
  "meta": { "title": "string", "body": "string" },
  "sections": [
    { "children": ["<id copied from input>", "..."], "title": "string", "body": "string" }
  ]
}
```

## Worked example (few-shot, prepend to the prompt if grouping quality is poor)

Input:
```json
[
  { "id": "P-aa11bb22-0", "kind": "heading", "text": "## Setup" },
  { "id": "P-3c4d5e6f-0", "kind": "prose", "text": "Install the CLI with `npm i -g foo`." },
  { "id": "P-7788990a-0", "kind": "code", "text": "npm i -g foo" },
  { "id": "P-bbcc11dd-0", "kind": "heading", "text": "## Usage" },
  { "id": "P-ee22ff33-0", "kind": "prose", "text": "Run `foo build` in any project root." }
]
```

Expected output:
```json
{
  "meta": {
    "title": "Installing and running the foo CLI",
    "body": "**Accomplished:**\n- Documents install and basic usage.\n\n**Blockers:**\n- None noted.\n\n**Next steps:**\n- Add a section on configuration once one exists."
  },
  "sections": [
    {
      "children": ["P-aa11bb22-0", "P-3c4d5e6f-0", "P-7788990a-0"],
      "title": "Installing the CLI",
      "body": "You install the tool globally with a single npm command, shown as a copy-pasteable snippet."
    },
    {
      "children": ["P-bbcc11dd-0", "P-ee22ff33-0"],
      "title": "Running a build",
      "body": "Once installed, the CLI runs from any project root with a single build command."
    }
  ]
}
```

## Output contract (mechanical checks the wrapper must run before assembly)

Normalization first (wrapper-side, before any check): collapse repeats of
the same id WITHIN one section's `children`, keeping the first occurrence.
Rationale, from a real deterministic failure (2026-07-15, gemma4 via
Ollama): a markdown table is a single block to the segmenter — one `P-` id
— but a model reading its rows emits that id once per row it describes
(`[P-x, P-y, P-y, P-y, …]`), and at temperature 0 it repeats the identical
mistake on every retry, so the retry budget can never recover. A repeat
inside one section is unambiguous about the only thing the model decides
(which section owns the block); collapsing it loses nothing. A duplicate
across two different sections is a genuine grouping conflict and is NOT
normalized — it must still fail the check below.

- Valid JSON, top-level keys exactly `meta` and `sections`.
- `sections` is a non-empty array; every element has non-empty `children`,
  `title`, `body`.
- `⋃ sections[].children` (concatenated in order) === input id list (same
  set, same order, same length — catches drops, dupes, and reorders in one
  comparison).
- No string value anywhere contains the literal substring `-->`.
- No `id`, `level`, `parent`, `docHash`, or `order` key present anywhere in
  the parsed object.

Independently of the check above, the payload serializer must still apply
A3 escaping (the comment-closer sequence becomes dash dash backslash-u-0-0-3-e,
i.e. the JSON unicode escape for `>`, in the serialized payload) to every
string in the final payload — section bodies are only one of the strings
that end up inside the HTML comment.

On any failure: re-prompt once with the specific violation named (e.g. "id
P-7788990a-0 is missing from all sections — add it to the correct section
and resubmit the full JSON object"), then fall back to `Untagged` (ship the
raw file with no payload, per the `LoadResult::Untagged` path in §2.6) rather
than assembling a payload that would fail `validate()`/`verify_ids()`.
