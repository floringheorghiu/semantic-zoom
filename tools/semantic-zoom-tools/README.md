# semantic-zoom-tools

A Claude Code plugin for generating Semantic Zoom `.md` files: content at level 0, plain-English sections at level -1, story chunks at level -2, embedded as the `<!-- semantic-zoom:payload:v1 ... -->` block the app's Engine A reads (`Implementation_Plan.md` §2.6).

## Why a plugin instead of just asking Claude each time

Everything about this payload that's *supposed* to be boring — content-addressed IDs (D6), byte-accurate spans, the docHash over the exact pre-marker bytes (A1), `-->` escaping (A3), referential integrity — is exactly the kind of thing a model will get right most of the time and silently wrong occasionally, in ways that don't surface until the app tries to load the file. Those parts are scripts here, not prompt instructions. The model's job is confined to the one genuinely creative part: writing the -1/-2 prose and deciding how blocks group into sections.

## Location

Lives at `tools/semantic-zoom-tools/` in the `semantic-zoom` repo — a
self-contained plugin root (own `.claude-plugin/plugin.json`), but
positioned as a sibling of `src-tauri/` so its final verification step can
build and run the app's own Rust binary (`../../src-tauri` from here).

Two ways to load it:

- **Per-session, quick:** `claude --plugin-dir tools/semantic-zoom-tools`
  (from the repo root). Works immediately, only for that session.
- **Persistent, via the local marketplace at the repo root
  (`.claude-plugin/marketplace.json` — same `.claude-plugin/` convention a
  plugin itself uses; `claude plugin install` resolves each plugin's
  `source` relative to that directory's PARENT, so the manifest can't sit
  at the repo root directly — confirmed by hitting exactly that failure
  once):**
  ```
  claude plugin marketplace add ./.claude-plugin/marketplace.json
  claude plugin install semantic-zoom-tools
  ```
  Registers it so `/reload-plugins` and future sessions pick it up
  automatically, without needing `--plugin-dir` every time.

## Components

| Path | Role |
|---|---|
| `skills/embed-zoom-payload/SKILL.md` | Orchestrates the pipeline below. Triggers on requests like "embed zoom layers in this file." |
| `scripts/segment.mjs` | Deterministic segmentation via `unified`+`remark-parse`+`unist-util-visit` — the same parser family the app's Engine B specifies, not a bespoke regex splitter. Assigns D6 content-addressed IDs. |
| `scripts/assemble.mjs` | Merges `segments.json` + a model-authored `layers.json` into a full, validated `LookupTable`, writes it into the file. Idempotent — safe to re-run. |
| `scripts/validate.mjs` | Standalone extraction + full validation (referential integrity, D6 id↔hash agreement, A1 docHash agreement). Zero dependencies. Exports `validate(raw)` for reuse. |
| `scripts/hook-validate.mjs` | PostToolUse adapter. No-ops on non-`.md` files and files with no payload marker; on a payload-bearing file, validates and exits 2 (findings fed back to Claude) on failure. |
| `hooks/hooks.json` | Wires the above to every `Write`/`Edit`. |
| `../../src-tauri/src/bin/verify_payload.rs` | Not part of this plugin directory — a small binary added to the app's own Rust crate. Runs the app's REAL `validate()`/`verify_ids()` (the exact code `load_document` uses), as the skill's final gate. See "A real bug this caught" below for why this exists alongside `validate.mjs` rather than instead of it. |

## Setup

```bash
npm install   # run from the plugin root, where package.json lives
```
Only needed for `segment.mjs`/`assemble.mjs`. The hook itself has no dependencies and works immediately.

The skill's final verification step (5) also needs `cargo` on `PATH` — already
a requirement for this repo generally (Tauri). `cargo run --bin verify_payload`
compiles that binary on first use; subsequent runs are fast (incremental).

## Constraints worth knowing before you rely on this

- **Section groupings must be contiguous in document order.** The app wraps each section's children in one `.pgroup` DOM element (plan §4.1); a non-contiguous grouping can't be rendered as one wrapper. `assemble.mjs` rejects these — it's not a style preference, it's what the renderer can express.
- **Any hand-edit before the marker invalidates every downstream span**, not just the touched paragraph — byte offsets shift for everything after the edit. This is expected, not a bug in the validator; it's the reason the skill instructs "never hand-patch, always regenerate."
- **`segment.mjs`'s HTML rendering uses `marked`, independently of the `remark` AST used for offsets/kind.** Both are CommonMark-compliant; divergence is limited to GFM-extension edge cases (tables, strikethrough). If the shipping app's Engine A/B HTML rendering ever needs byte-for-byte parity with this tool's output, that's worth re-checking — this tool prioritizes correct *structure* (spans, IDs, referential integrity) over guaranteed-identical HTML bytes.
- **`${CLAUDE_PLUGIN_ROOT}` has a documented reliability gap for some hook events** (see anthropics/claude-code#66557, #42564) — not reported for `PostToolUse` specifically as of this writing, but if the hook silently stops firing, check whether the env var is reaching the process (`echo $CLAUDE_PLUGIN_ROOT` inside a hook command) before assuming validation logic is at fault.

## A real bug this caught (worth reading before you trust this tool)

`segment.mjs` originally used `node.position.offset` from `remark`/`unist`
directly as a byte span. That offset is actually a **JS string (UTF-16
code-unit) character index**, not a UTF-8 byte offset — identical to a byte
offset for pure ASCII, which is exactly why it passed every test against
the bundled synthetic `examples/sample.md` (all-ASCII) without incident.
Run against this repo's actual docs — full of em dashes, arrows, curly
quotes — the drift between "character index" and "byte index" compounds
with every non-ASCII character earlier in the file, and spans silently cut
mid-word/mid-character.

The dangerous part: this was **invisible to every mechanical check**,
including the Rust `verify_ids()` the app itself runs. The id and its
content hash are both derived from the *same* (wrong) byte range, so they
always agree with each other — `verify_ids()` was never checking "is this
span the right content," only "does the hash match the bytes actually at
this range," which it trivially did. Only reading the resulting paragraph
text (garbled, cut off mid-word) surfaced it. Fixed by converting every
remark offset through a proper UTF-16→UTF-8 byte-offset map before it's
used anywhere (see `buildByteOffsetMap` in `segment.mjs`).

Two things followed from this, on top of the fix itself:
- **Always test against real, typographically normal content**, not just
  a synthetic ASCII fixture, before trusting a change to this tool.
- **The Rust cross-check step (5) in the skill exists because of this
  exact failure mode.** `validate.mjs`'s JS reimplementation is fast and
  dependency-free, which is why it's what the PostToolUse hook runs on
  every edit — but a reimplementation can drift from what it mirrors in
  ways that are self-consistent and therefore invisible to itself. Running
  the app's actual compiled `validate()`/`verify_ids()` is what catches
  that class of bug, not a better JS reimplementation.

## A second real bug: marker detection matched its own documentation

Found while using this plugin to tag `docs/semantic-zoom-tools.md` — a
document that explains this exact payload format, and therefore quotes the
literal marker syntax in its own prose, once as a complete illustrative
`<!-- semantic-zoom:payload:v1 ... -->` snippet.

`assemble.mjs` and `validate.mjs` both located "the marker" with a bare
`indexOf`/`lastIndexOf(MARKER_HEAD)` — no check that what follows is an
actual payload, just that the marker TEXT appears somewhere. For a file
that merely *describes* the marker in prose, that text is the only
occurrence in the file, so even `lastIndexOf` alone still matched it and
`assemble.mjs` treated everything after it as an existing payload to strip
before regenerating — silently truncating the rest of the document.

Fixed in `assemble.mjs` with a `findExistingMarkerStart` helper that
requires the candidate content between head and tail to actually parse as
JSON before treating it as a real payload; a marker-shaped false positive
falls back to "nothing to strip," matching what the app's own Rust
extractor effectively guarantees (a marker whose content isn't valid JSON
was never a real payload in the first place — see `docs/payload-format.md`
addendum A3, `-->` escaping, for why the real extractor takes the same
skeptical stance and matches the LAST occurrence, not the first).
`validate.mjs` was left with the narrower `indexOf`→`lastIndexOf` fix only
(no JSON-parse fallback) — its job is to mirror what the shipping app would
actually do with a given file, and the app genuinely does report
`Corrupt` for marker-shaped-but-unparseable text; silently downgrading that
to "no marker" in the JS mirror would itself be a drift from the real app,
the opposite of what this validator exists to prevent.

## Tested

Every script above was run end-to-end against a synthetic fixture during development, including: duplicate-content ordinal disambiguation, non-contiguous grouping rejection, orphan-block detection, hand-edit drift detection (cascading span invalidation), idempotent re-assembly convergence, and the exact `PostToolUse` stdin contract. Additionally run end-to-end against two real files from this repo — `docs/packaging.md` (headings, code fences, a list, em dashes and arrows throughout) and `docs/semantic-zoom-tools.md` (this plugin's own architecture doc, which is what surfaced the marker-detection bug above) — with both resulting payloads verified against the app's own compiled `validate()`/`verify_ids()` via `verify_payload`, not just the JS mirror. Not a substitute for testing against your own real files, but the plumbing has been exercised on both synthetic and real content, not just written.
