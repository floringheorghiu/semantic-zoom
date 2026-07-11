---
description: Embed a Semantic Zoom LookupTable payload (levels -2/-1/0) into a markdown file, or refresh an existing one after the source content changed. Use when the user asks to "add zoom layers", "embed the semantic zoom payload", "generate a semantic zoom fixture/test file", "make this doc work with Semantic Zoom", or references the app's payload format for a .md file.
---

# Embed Zoom Payload

Produces a markdown file with a valid `<!-- semantic-zoom:payload:v1 ... -->` block per `docs/payload-format.md` and `Implementation_Plan.md` (decisions D1–D8, addenda A1–A4).

**Governing rule of this skill: you never author the LookupTable JSON, IDs, hashes, or spans by hand, and you never hand-patch an existing payload.** Those are exactly the properties (content-addressed IDs, byte-accurate spans, docHash) that are cheap for a script to get right and expensive for a model to get right by inference — that split is the entire reason this skill exists instead of a prompt saying "please remember the ID rules." Your job is the one part that's genuinely a language task: writing the plain-English section (-1) and story (-2) content, and deciding how paragraph blocks group into sections.

## Pipeline

Target file: `$ARGUMENTS` if given, otherwise ask which file (don't guess between multiple candidates).

**PLUGIN_ROOT.** All commands below reference `<PLUGIN_ROOT>` — the plugin's own directory. Resolve it once, in this order:
1. If the environment variable `CLAUDE_PLUGIN_ROOT` is set (Claude Code plugin install), use its value.
2. Otherwise (any other harness — MiMo Code, Pi, a bare checkout), use the path relative to the repository root: `tools/semantic-zoom-tools`. This plugin is developed in-repo alongside the app it validates against (step 5 shells out to `src-tauri/` two directories up from here), so the repo-relative path is always correct when running from a checkout of this repository.

**0. One-time setup.** If `<PLUGIN_ROOT>/node_modules` doesn't exist, run `npm install` inside `<PLUGIN_ROOT>` before continuing. `validate.mjs` and `hook-validate.mjs` have zero dependencies and always work; only `segment.mjs`/`assemble.mjs` need this.

**1. Segment.**
```
node "<PLUGIN_ROOT>/scripts/segment.mjs" <file.md> > /tmp/segments.json
```
This parses with `unified` + `remark-parse` + `unist-util-visit` — the same parser family the app's own Engine B specifies (plan §2.7) — and assigns every block a content-addressed ID: `P-<sha256(text)[:8]>-<ordinal>` (D6). Read `/tmp/segments.json` to see every block's id, kind, and text.

**2. Author `layers.json`.** For each block in segments.json, decide which section it belongs to, then which meta node each section belongs to. Write:
```json
{
  "meta": [ { "title": "...", "body": "...", "sections": ["<sectionKey>", ...] } ],
  "sections": [
    { "key": "<any-string-you-choose>", "title": "...", "body": "...",
      "paragraphs": ["<P-id>", "<P-id>", ...] }
  ]
}
```
Hard constraints the assembler enforces (it will reject the file, with a specific reason, if violated — fix `layers.json` and re-run rather than arguing with the error):
- Every ID in `paragraphs`/`sections` must be a real ID from segments.json — never invent one.
- A section's `paragraphs` must be a **contiguous run in document order**. This isn't arbitrary: the app wraps each section's children in one `.pgroup` DOM element (plan §4.1) that the focus-mask spotlight dims/lights as a unit — a non-contiguous grouping can't be expressed as one wrapper.
- Every block must end up in exactly one section; every section in exactly one meta node.

**Tip for large files (100+ blocks):** hand-authoring every block ID gets tedious past a certain size. `<PLUGIN_ROOT>/scripts/build-layers.mjs` is a starting-point helper: it groups blocks under `##` headings into sections automatically, then maps sections into meta groups by keyword-matching their titles. It is NOT a generic zero-config tool — you must edit its `META_GROUPS` and `classify()` for the document at hand (the same grouping judgment call this step asks of you by hand, just expressed as code when there's too much to reason about one block at a time). Run `node <PLUGIN_ROOT>/scripts/segment.mjs <file.md> | node <PLUGIN_ROOT>/scripts/build-layers.mjs > layers.json`, then run `<PLUGIN_ROOT>/scripts/check-layers.mjs` (step 2.5 below) before assembling — it prints its own coverage/contiguity warnings to stderr, but check-layers.mjs is the authoritative gate.

**Voice, matching the plan's existing convention** (see `Implementation_Plan.md`'s own embedded payload for the calibration point):
- **Level -1 (section) body:** a conceptual, jargon-free walkthrough of what that chunk of content does or means — write for someone who wants the gist without the technical vocabulary, not a summary that just shortens the same sentences.
- **Level -2 (meta) body:** plain-language "what was accomplished / prerequisites or blockers / next step" — the narrative arc, not a table of contents.
- Titles are short and human ("How the view knows where to land"), not restated headings.

**2.5. Self-check `layers.json` before assembling.**
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-layers.mjs" layers.json
```
Zero-dependency structural check: every section key assigned to exactly one meta node, no unknown keys, no duplicates, no section left with an empty paragraph list. `assemble.mjs` enforces the same constraints and will refuse a bad file regardless — this step exists to catch an incomplete `layers.json` (e.g. a section drafted but never added to any meta node's `sections` array) one step earlier, before the parser/hash work in step 3 runs. Fix `layers.json` and re-run until this prints `OK`.

**3. Assemble.**
```
node "<PLUGIN_ROOT>/scripts/assemble.mjs" <file.md> layers.json
```
Re-derives the whole payload from `<file.md>`'s pre-payload content + `layers.json` every run — safe to re-run after editing either input, including on a file that already has a **valid** payload (it strips the old one first, and any content that was appended after the old payload is preserved as trailing body content, not deleted). If the existing payload is **damaged** (truncated JSON, mangled merge), it refuses loudly with recovery instructions instead of guessing — delete the broken block per the error message and re-run. Computes `docHash` over the exact bytes that will precede the marker (A1), escapes any literal `-->` in the JSON (A3) plus any quoted marker-head text inside string values, and self-checks every ID against its own span before writing (mirrors the Rust `verify_ids()` the app runs). If it exits non-zero, the error names the exact block/section at fault — fix `layers.json` (or follow the error's recovery instructions), don't touch the output file.

**4. Verify (JS mirror — fast, runs everywhere).**
```
node "<PLUGIN_ROOT>/scripts/validate.mjs" <file.md>
```
Independent check, run standalone — this is the same logic the PostToolUse hook runs automatically on every future edit to this file.

**5. Verify against the app's own compiled Rust — the authoritative gate.**
```
cargo run --manifest-path "<PLUGIN_ROOT>/../../src-tauri/Cargo.toml" --bin verify_payload -- <file.md>
```
`validate.mjs` above is a faithful JS *reimplementation* of the app's `validate()`/`verify_ids()` — deliberately dependency-free so the PostToolUse hook can run on every edit without needing cargo. A reimplementation can still drift from what it mirrors, silently, in ways a self-consistent JS check wouldn't catch (this happened once during this tool's own development: a UTF-16-vs-UTF-8 offset bug in `segment.mjs` produced garbled paragraph content while still passing every mechanical check, because the id and its hash were both derived from the same wrong byte range — only reading the actual content caught it). This step runs the exact compiled code `load_document` runs, closing that gap. Only skip it if cargo genuinely isn't available; note that explicitly if so, don't silently treat step 4 alone as equivalent to "verified."

Only consider the task done once **both** step 4 and step 5 pass.

## Refreshing an existing payload

If the source content changed (new paragraphs, edited prose) and the file already has a payload: re-run step 1 to get fresh IDs (`segment.mjs` strips the existing payload itself before segmenting, using the same normalization `assemble.mjs` applies — so step-1 ids always resolve in step 3, including content that was appended after the old payload), diff `layers.json`'s old ID references against the new segments.json (edited paragraphs get new IDs — their old section slot needs the new ID), then re-run steps 3–5. Do not try to patch the embedded JSON in place.

## If validation fails on a file you didn't just build

That means something wrote to this file without going through this pipeline — most often a hand-edit. Do not try to reconcile the drift by hand. Regenerate: re-run step 1 against the current content, rebuild `layers.json` from scratch against the fresh IDs, re-run steps 3–5. If the existing payload block is so damaged it no longer parses, `segment.mjs`/`assemble.mjs` will refuse with instructions to delete the broken block first — follow them, then regenerate.
