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

## Running under MiMo Code (or any non-Claude-Code harness)

`SKILL.md` doesn't reference `${CLAUDE_PLUGIN_ROOT}` — it resolves a `<PLUGIN_ROOT>` placeholder itself (see the "PLUGIN_ROOT" line at the top of the Pipeline section): Claude Code's env var if set, otherwise the repo-relative path `tools/semantic-zoom-tools`. That repo-relative fallback is always correct here because this plugin is developed in-repo, not installed as a standalone package elsewhere — step 5 already assumes a fixed `../../src-tauri` relationship to this directory regardless of engine.

MiMo Code (a fork of OpenCode) discovers project skills at `.mimocode/skills/**/SKILL.md`, using the same frontmatter format as Claude Code. `.mimocode/skills/embed-zoom-payload` is a relative symlink to `skills/embed-zoom-payload` in this directory — one source of truth, discoverable from both engines. A `.mimocode/commands/embed-zoom-payload.md` command is also provided for `/embed-zoom-payload <file>` in MiMo's TUI.

**Not ported:** the `PostToolUse` hook (`hooks/hooks.json` → `hook-validate.mjs`) that auto-validates every edit to a payload-bearing `.md` file. MiMo Code's plugin system uses a different mechanism (a JS/TS `file.edited` or `tool.execute.after` hook in `.mimocode/plugins/`, not a hooks.json config) — porting it is possible but wasn't done here since the skill's own steps 4–5 already run the same validation explicitly before declaring the task done; the hook is a convenience safety net for edits made *outside* the skill, not the only check.

**Unverified:** none of the above has been run inside an actual MiMo Code session — it's built from MiMo Code's public docs (symlink-following for skill discovery in particular is assumed, not confirmed). If it doesn't discover the skill, check `.mimocode/skills/embed-zoom-payload/SKILL.md` resolves through the symlink, or fall back to pointing MiMo Code at `tools/semantic-zoom-tools/skills/embed-zoom-payload/SKILL.md` directly.

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
npm test      # runs tests/ via node --test — no extra setup needed
```
`npm install` is only needed for `segment.mjs`/`assemble.mjs`. The hook itself has no dependencies and works immediately.

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

Fixed with a detection helper (today: `findExistingPayload` in
`validate.mjs` — see "Review hardening" below for how it evolved) that
requires the candidate content between head and tail to actually parse as
JSON before treating it as a real payload; a marker-shaped false positive
falls back to "nothing to strip," matching what the app's own Rust
extractor effectively guarantees (a marker whose content isn't valid JSON
was never a real payload in the first place — see
`docs/prompts/payload-format.md` addendum A3, `-->` escaping, for why the
real extractor takes the same skeptical stance).
`validate.mjs` was left with the narrower `indexOf`→`lastIndexOf` fix only
(no JSON-parse fallback) — its job is to mirror what the shipping app would
actually do with a given file, and the app genuinely does report
`Corrupt` for marker-shaped-but-unparseable text; silently downgrading that
to "no marker" in the JS mirror would itself be a drift from the real app,
the opposite of what this validator exists to prevent.

**Follow-up hardening, thinking one step further than the minimal fix:** a
bare `JSON.parse` check alone still has a gap — a short illustrative example
that happens to be syntactically valid JSON (say, a tiny sample object
shown to demonstrate "the shape," with none of a real payload's actual
content) would still pass. The app's real Rust extractor doesn't just check
"is this JSON," it deserializes straight into the typed `LookupTable`
struct, which requires specific top-level keys. Detection now checks for
that shape too (`looksLikeLookupTable`: has `version`, `docHash`, `meta`,
`sections`, `paragraphs`, `order`) before trusting a candidate marker,
closing that remaining gap rather than leaving it for a fourth incident to
find.

## Review hardening (v1.3.0)

A recall-oriented multi-agent code review of the changes above surfaced —
and fixed — a further batch of real defects, several confirmed by actually
executing the failure scenario, plus one pre-existing workflow bug the new
tests exposed on their first run:

- **The CLI entry guard silently failed open.** All three scripts guarded
  their CLI block with `import.meta.url === 'file://' + process.argv[1]`,
  which evaluates false for relative invocations, paths containing spaces
  or non-ASCII characters (URLs percent-encode), symlinked paths (Node
  realpaths the main module — even `/tmp` vs `/private/tmp` broke it), and
  Windows drive paths — the script would exit 0 having done NOTHING, which
  callers read as success. Replaced with `isCliInvocation()` in
  `validate.mjs` (realpath + `pathToFileURL`), used by all three; covered
  by an integration test that invokes `assemble.mjs` through a symlink in a
  directory with a space in its name.
- **Detection now bounds the payload with the FIRST `-->` after the head**,
  not the file's last: A3 guarantees a real payload contains no literal
  `-->`, and the old whole-file `lastIndexOf` let any stray `-->` in
  content after the payload corrupt the candidate and un-detect a tagged
  file. Heads are scanned backward, so a quoted example before a real
  payload can't shadow it.
- **Content appended after the payload is preserved, not deleted.** The old
  `slice(0, markerAt)` silently discarded anything after the marker — the
  natural EOF append point. Stripping now splices trailing content back
  into the body.
- **A damaged payload at EOF fails loudly with recovery instructions**
  instead of being silently re-embedded as document content (which is what
  "treat unparseable as absent" alone would do — the corrupt block would
  become prose and validate would then pass forever).
- **The payload writer now escapes quoted marker-HEAD text inside JSON
  strings** (the head's `<` becomes its JSON unicode escape), symmetric with
  A3's tail escaping. Without it, a section body quoting the marker syntax
  would put the literal head text inside the payload — where the app's own
  `rfind(HEAD)` would land and report the whole file Corrupt.
- **`segment.mjs` now segments the same canonical pre-payload source
  `assemble.mjs` derives spans against** (shared `prePayloadSource()` in
  `validate.mjs`). Previously it segmented the raw file verbatim, payload
  comment included — which made the documented refresh flow structurally
  broken for already-tagged files (step-1 ids could never resolve in step
  3). The new trailing-content test caught this on its first run.
- The detection/strip primitives moved to `validate.mjs` — the
  dependency-free base of the plugin's import graph — resolving the
  reviewers' duplication finding (marker constants + locate-and-parse
  mechanics previously copy-pasted across two files) without an import
  cycle, and making the marker-detection tests runnable before
  `npm install`.
- Smaller fixes from the same review: `tests/schema-drift.test.mjs` pins
  `REQUIRED_TOP_LEVEL_KEYS` to `src/engine/payload.schema.json`'s
  `required` array whenever the repo copy is present (skips on standalone
  installs); the npm `test` script is plain `node --test` (the previous
  shell glob didn't expand on Windows cmd.exe); `runExpectFailure` in the
  integration tests no longer swallows its own assertion; the
  recognized-payload test asserts hardcoded offsets instead of recomputing
  them with the same string search the implementation uses; and the app's
  `vitest.config.ts` exclude is scoped to `tools/semantic-zoom-tools/**`
  rather than all of `tools/**`.

## Automated regression coverage

`tests/` (`npm test`, Node's built-in test runner — no new dependency,
matching `validate.mjs`'s own zero-dependency stance) turns the manual
testing below into something that can't silently regress:

- `segment.test.mjs` — the UTF-16/UTF-8 offset bug: a code block and a
  prose paragraph downstream of dense non-ASCII text must have exact,
  unmangled spans; duplicate-content ordinal disambiguation.
- `marker-detection.test.mjs` — the marker-detection bug family: a non-JSON
  illustrative example AND a syntactically-valid-but-wrong-shape one must
  both be treated as absent; a real payload must be found at exact
  (hardcoded) offsets, must win over an earlier prose mention, and must
  survive a stray `-->` in content after it (first-tail rule).
- `assemble-integration.test.mjs` — end-to-end CLI behavior: idempotent
  re-assembly (byte-identical on a second run), non-contiguous grouping
  rejection, a freshly assembled file always passing `validate.mjs`, the
  prose-describing-the-marker scenario end-to-end, content appended after
  the payload surviving re-assembly, quoted marker-head text being escaped
  in the payload, a damaged EOF payload failing loudly, and the CLI running
  through a symlinked path with spaces (entry-guard regression).
- `schema-drift.test.mjs` — pins `REQUIRED_TOP_LEVEL_KEYS` to the app
  schema's `required` array when running in-repo; skips standalone.

The original shape-check test in `marker-detection.test.mjs` was confirmed
to actually fail when its fix was temporarily reverted (a real mutation
check, not just "the test happens to be green") before being committed
alongside the fix; the trailing-content integration test earned the same
credential the honest way — it FAILED on its first run, against a bug
nobody knew was there (the segment-CLI/assemble divergence described under
"Review hardening").

## Tested

Every script above was run end-to-end against a synthetic fixture during development, including: duplicate-content ordinal disambiguation, non-contiguous grouping rejection, orphan-block detection, hand-edit drift detection (cascading span invalidation), idempotent re-assembly convergence, and the exact `PostToolUse` stdin contract — see "Automated regression coverage" above for which of these are now enforced by `npm test` rather than only exercised manually. Additionally run end-to-end against two real files from this repo — `docs/packaging.md` (headings, code fences, a list, em dashes and arrows throughout) and `docs/semantic-zoom-tools.md` (this plugin's own architecture doc, which is what surfaced the marker-detection bug above) — with both resulting payloads verified against the app's own compiled `validate()`/`verify_ids()` via `verify_payload`, not just the JS mirror. Not a substitute for testing against your own real files, but the plumbing has been exercised on both synthetic and real content, not just written.
