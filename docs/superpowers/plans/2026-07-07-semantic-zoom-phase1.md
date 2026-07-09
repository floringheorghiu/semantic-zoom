# Semantic Zoom — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native macOS Tauri v2 app that renders AI-generated markdown at three discrete semantic zoom levels (k = 0, −1, −2) with spatial anchoring, focus masking, and silent hot-reload.

**Architecture:** Rust owns *disk truth* (file read, payload byte-extraction, directory watching); TypeScript owns *view truth* (in-memory lookup table, anchoring math, DOM rendering, RxJS state). The two halves communicate through exactly three Tauri crossings — `load_document`, `watch_directory`, and the `doc://changed` event — and mirror the same `LookupTable` schema so `serde_json` rejects malformed payloads at the boundary.

**Tech Stack:** Tauri v2, Rust (serde, serde_json, sha2, hex, notify, notify-debouncer-mini, tauri-plugin-dialog), TypeScript (vanilla), Vite, RxJS, unified + remark-parse + unist-util-visit, ESLint, Vitest (frontend tests), `cargo test` (Rust tests).

---

## How to use this plan (read before Task 1)

**The spec (`docs/Implementation_Plan.md`) is the single source of truth for architecture and for all authoritative Rust/TS code.** CLAUDE.md mandates reading the relevant spec section before implementing, and warns specifically against Rust/TS *mirror drift*. Therefore:

- Where a task says **"transcribe from spec §X"**, open `docs/Implementation_Plan.md` §X and copy that code **verbatim** into the named file. Do **not** reconstruct it from memory, and do **not** "improve" it. If the spec code looks wrong, STOP and flag (per CLAUDE.md) — do not silently deviate.
- Everything the spec does *not* contain — the tests, the exact shell commands, expected outputs, ESLint config, task sequencing, CI wiring — is written out **in full** in this plan. Those are yours to type as-is.
- This split is deliberate: duplicating the spec's mirror structs into the plan would create two copies that can drift, which is the exact failure the round-trip test (Task 1.7) exists to prevent.

**Decisions D1–D8 (spec §0) are final.** Never override them. If you believe one is wrong: STOP, state the specific technical reason, wait.

**Fixtures under `fixtures/` are read-only acceptance oracles.** `fixtures/zoom_test.md` already exists and already carries an appended v1 payload (last ~2 lines of the file). Never regenerate or edit it to make a test pass. If it seems wrong, stop and flag.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec / CLAUDE.md.

- **Three crossings only.** The Rust↔TS boundary is exactly `load_document`, `watch_directory`, and the `doc://changed` event. Adding a fourth requires a flagged decision — do not add one in Phase 1.
- **No `@tauri-apps/*` imports** anywhere under `src/engine/**` or `src/ui/**`. Enforced by ESLint `no-restricted-imports`, which is **installed in Task 1.3 before any other frontend work**. Tauri imports live only in `src/main.ts` and `src/state/**` glue.
- **IDs are content-addressed (D6):** `P-<sha256[:8]>-<ordinal>`, `S-<sha256[:8]>-<ordinal>`; meta nodes positional (`M1`, `M2`, …). Never introduce sequential or random IDs anywhere in the pipeline. `verify_ids()` must reject any payload whose paragraph IDs don't embed the recomputed content hash.
- **Animate `opacity` only (D1).** Never transition `filter`, layout properties, or anything non-compositor. Contrast/saturation are instant class swaps masked by the opacity crossfade.
- **Read-then-write DOM discipline.** All layout reads complete before any write in a frame; all scroll writes go through the single rAF-scheduled queue in `viewport.ts`. The zoom transition mounts in frame n and measures in frame n+1 (D8) — never collapse them.
- **Hot reload is keyed reconciliation (D7)**, never a container wipe. `innerHTML = ''` on the viewport is a defect.
- **State discipline.** One `BehaviorSubject<AppState>`. Components dispatch actions and subscribe to `distinctUntilChanged` selectors; no component subscribes to `actions$` or holds private state. Every `mount()` returns a teardown; `main.ts` owns all lifecycles.
- **Payload marker (D2):** `<!-- semantic-zoom:payload:v1` … `-->`, placed at EOF. Extraction is a byte scan (`rfind`), not a markdown parse.
- **Contract addenda A1–A4** (live in `docs/payload-format.md`): A1 `docHash` covers bytes *preceding* the marker; A2 all `span` offsets reference that same pre-payload region; A3 producers escape `-->` inside JSON strings and the extractor matches the *last* `-->`; A4 IDs follow D6 and `verify_ids()` enforces it.
- **Platform:** macOS 12.0+ target, `titleBarStyle: "Overlay"`, `hiddenTitle: true`, bundle target `dmg`.
- **Sequencing rule:** nothing in a later milestone starts until the previous milestone's acceptance criteria pass.
- **When a check fails, fix the code, not the check.**
- **Honesty:** "implemented but unverified" ≠ "verified by test X". Never present the first as the second.

---

## File Structure

Follows spec §1 exactly. One responsibility per file.

**Rust backend (`src-tauri/`):**
- `src/main.rs` — thin entry; calls `lib::run()`.
- `src/lib.rs` — Tauri builder, plugin + command registration, managed state.
- `src/state.rs` — `AppState` (watched path, last-loaded doc hash).
- `src/commands/mod.rs`, `src/commands/document.rs` — `load_document` command + `LoadResult` enum.
- `src/parser/mod.rs` — Rust mirror structs, `validate()`, `verify_ids()`.
- `src/parser/payload.rs` — Engine A: marker byte-scan + `serde_json` (`extract_payload`).
- `src/watcher/mod.rs`, `src/watcher/debounced.rs` — `watch_directory` command, debounced parent-dir watch, `doc://changed` emit.
- `tests/` — Rust integration tests (round-trip, extraction, validation).

**TypeScript frontend (`src/`):**
- `main.ts` — wires store ⇄ Tauri events ⇄ UI; owns all `mount()` lifecycles. **Only** place (with `state/`) allowed to import `@tauri-apps/*`.
- `state/store.ts` — single `BehaviorSubject<AppState>` + `actions$` bus + `select()`.
- `state/actions.ts` — typed action creators.
- `state/selectors.ts` — memoized `distinctUntilChanged` selectors.
- `engine/schema.ts` — `LookupTable` types + `buildIndex()`.
- `engine/anchor.ts` — anchor resolution, cross-level mapping, `centerScrollTop`, transition sequence.
- `engine/engine-a.ts` — thin frontend payload/LoadResult DTO types.
- `engine/engine-b.ts` — Phase-1 stub `Synthesizer` + `segment()` (remark).
- `ui/viewport.ts` — renders active level, owns the single rAF scroll queue, keyed reconciliation.
- `ui/slider.ts` — 3-detent physical slider, disabled-state handling.
- `ui/focus-mask.ts` — toggles `data-dimmed` on sibling groups.
- `ui/caret.ts` — read-only caret placement + arrow traversal.
- `styles/base.css`, `styles/slider.css`, `styles/focus-mask.css`.
- `tests/` (Vitest) — colocated `*.test.ts` next to modules or under `src/**/__tests__`.

**Docs / fixtures:**
- `docs/payload-format.md` — versioned agent↔app contract (JSON Schema + addenda A1–A4). **Created in Task 1.6.**
- `docs/perf-baseline.md` — perf numbers (Task 3.4).
- `fixtures/zoom_test.md` — **exists, read-only.** Realistic plan + appended v1 payload.

---

## Milestone map (spec §7 → tasks)

- **Week 1 (Skeleton, contract, happy path):** Tasks 1.1–1.9 ⇐ backlog 1.1–1.5
- **Week 2 (Anchoring, caret, spotlight):** Tasks 2.1–2.6 ⇐ backlog 2.1–2.5
- **Week 3 (Watcher, hot reload, hardening):** Tasks 3.1–3.6 ⇐ backlog 3.1–3.6

---

# Week 1 — Skeleton, contract, and the happy path

## Task 1.1: Scaffold Tauri v2 + vanilla-TS workspace

**Files:**
- Create: whole tree per spec §1 (scaffolder generates most; you add empty module dirs).
- Modify: `src-tauri/tauri.conf.json`, `package.json`.

**Interfaces:**
- Produces: a runnable `npm run tauri dev` window; the directory skeleton every later task fills in.

- [ ] **Step 1: Scaffold the app** (spec §1 "Bootstrap commands")

Run from `/Users/floringheorghiu/Coding/Active-code/`:
```bash
npm create tauri-app@latest semantic-zoom -- --template vanilla-ts
```
The directory already exists with `docs/`, `fixtures/`, `CLAUDE.md`, `.git/`. If the scaffolder refuses a non-empty dir, scaffold into a temp dir and copy `src/`, `src-tauri/`, `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` over — **never overwrite `docs/`, `fixtures/`, or `CLAUDE.md`.**

- [ ] **Step 2: Install frontend + Rust deps** (spec §1)

```bash
cd /Users/floringheorghiu/Coding/Active-code/semantic-zoom
npm i rxjs unified remark-parse unist-util-visit
cd src-tauri
cargo add notify notify-debouncer-mini serde serde_json sha2 hex --features serde/derive
cargo add tauri-plugin-dialog
cd ..
```

- [ ] **Step 3: Configure `tauri.conf.json` for macOS-native feel** (transcribe the `app.windows` + `bundle` blocks from spec §1 "tauri.conf.json essentials")

Set window `title`, `width: 980`, `height: 760`, `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `transparent: false`; bundle `targets: ["dmg"]`, `macOS.minimumSystemVersion: "12.0"`.

- [ ] **Step 4: Create the empty module directories** so later tasks have their homes

```bash
mkdir -p src/state src/engine src/ui src/styles
mkdir -p src-tauri/src/commands src-tauri/src/parser src-tauri/src/watcher src-tauri/tests
```

- [ ] **Step 5: Run the dev build**

Run: `npm run tauri dev`
Expected: a styled empty window titled "Semantic Zoom" opens with an overlay title bar (traffic lights over content). Close it.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold Tauri v2 + vanilla-TS workspace"
```

**Done when:** `npm run tauri dev` opens a styled empty window (backlog 1.1).

---

## Task 1.2: Test tooling — Vitest + `cargo test` green on a trivial test

**Files:**
- Modify: `package.json` (add `vitest`, `test` script).
- Create: `src/engine/__smoke__.test.ts`, `src-tauri/tests/smoke.rs`.

**Interfaces:**
- Produces: `npm test` and `cargo test` commands every later task uses.

- [ ] **Step 1: Add Vitest**

```bash
npm i -D vitest
```
Add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 2: Write a trivial frontend test**

`src/engine/__smoke__.test.ts`:
```ts
import { test, expect } from 'vitest';
test('vitest runs', () => { expect(1 + 1).toBe(2); });
```

- [ ] **Step 3: Run it**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 4: Write a trivial Rust test**

`src-tauri/tests/smoke.rs`:
```rust
#[test]
fn cargo_test_runs() { assert_eq!(1 + 1, 2); }
```

- [ ] **Step 5: Run it**

Run: `cd src-tauri && cargo test && cd ..`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: add vitest + cargo test harness"
```

**Done when:** both test runners execute a passing test.

---

## Task 1.3: ESLint boundary rule — no `@tauri-apps/*` under engine/ui

> **This precedes all other frontend work** (CLAUDE.md hard boundary). Install it now even though the guarded dirs are nearly empty.

**Files:**
- Create: `eslint.config.js`.
- Modify: `package.json` (`lint` script).

**Interfaces:**
- Produces: `npm run lint` failing on any `@tauri-apps/*` import inside `src/engine/**` or `src/ui/**`.

- [ ] **Step 1: Install ESLint + TS parser**

```bash
npm i -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

- [ ] **Step 2: Write the config with the restricted-import override**

Flat config `eslint.config.js`:
```js
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/engine/**/*.ts', 'src/ui/**/*.ts'],
    languageOptions: { parser: tsParser },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@tauri-apps/*'],
          message: 'engine/ and ui/ must stay Tauri-free for the Phase 2 HTML export (spec §6). Route Tauri access through main.ts / state/.',
        }],
      }],
    },
  },
];
```
Add script: `"lint": "eslint 'src/**/*.ts'"`.

- [ ] **Step 3: Prove the rule bites (failing check)**

Temporarily add to `src/engine/schema.ts` (create the file with just this line for now):
```ts
import { invoke } from '@tauri-apps/api/core';
```
Run: `npm run lint`
Expected: FAIL — `no-restricted-imports` error on `schema.ts`.

- [ ] **Step 4: Remove the offending import**

Delete that line (leave `schema.ts` with `export {}` for now).
Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: enforce Tauri-free engine/ui via eslint no-restricted-imports"
```

**Done when:** `npm run lint` errors on a `@tauri-apps/*` import under `src/engine/**` and passes without one.

---

## Task 1.4: Frontend schema + `buildIndex` (contract, TS half)

**Files:**
- Create/replace: `src/engine/schema.ts`
- Test: `src/engine/schema.test.ts`

**Interfaces:**
- Produces: `ZoomLevel`, `ParagraphNode`, `SectionNode`, `MetaNode`, `LookupTable`, `ResolvedIndex`, `buildIndex(t: LookupTable): ResolvedIndex`. These names/types are consumed by anchor, store, viewport, focus-mask, and the round-trip test — keep signatures exact.

- [ ] **Step 1: Write the failing test for `buildIndex`**

`src/engine/schema.test.ts`:
```ts
import { test, expect } from 'vitest';
import { buildIndex, type LookupTable } from './schema';

export const sampleTable: LookupTable = {
  version: 1,
  docHash: 'a'.repeat(64),
  meta: { M1: { id: 'M1', level: -2, children: ['S-00000000-0'], title: 'm', body: 'b' } },
  sections: {
    'S-00000000-0': { id: 'S-00000000-0', level: -1, parent: 'M1',
      children: ['P-11111111-0', 'P-22222222-0'], title: 's', body: 'b' },
  },
  paragraphs: {
    'P-11111111-0': { id: 'P-11111111-0', level: 0, parent: 'S-00000000-0',
      kind: 'prose', span: { start: 0, end: 3 }, html: '<p>a</p>' },
    'P-22222222-0': { id: 'P-22222222-0', level: 0, parent: 'S-00000000-0',
      kind: 'code', span: { start: 3, end: 6 }, html: '<pre></pre>', lang: 'rs' },
  },
  order: { meta: ['M1'], sections: ['S-00000000-0'], paragraphs: ['P-11111111-0', 'P-22222222-0'] },
};

test('buildIndex resolves both directions and sibling groups', () => {
  const idx = buildIndex(sampleTable);
  expect(idx.parentOfParagraph.get('P-11111111-0')).toBe('S-00000000-0');
  expect(idx.parentOfSection.get('S-00000000-0')).toBe('M1');
  expect(idx.siblingGroup.get('P-11111111-0')).toEqual(['P-11111111-0', 'P-22222222-0']);
  expect(idx.siblingGroup.get('P-22222222-0')).toEqual(['P-11111111-0', 'P-22222222-0']);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npm test -- schema`
Expected: FAIL (module has no `buildIndex` / types).

- [ ] **Step 3: Implement `schema.ts`** by transcribing spec §2.2 verbatim

Copy the entire TypeScript block from spec §2.2 (types `ZoomLevel`, `ParagraphNode`, `SectionNode`, `MetaNode`, `LookupTable`, `ResolvedIndex`, and the `buildIndex` function) into `src/engine/schema.ts`.

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- schema`
Expected: PASS.

- [ ] **Step 5: Lint (boundary still clean)**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: TS LookupTable schema + buildIndex (spec §2.2)"
```

**Done when:** `buildIndex` builds both parent maps and sibling groups for a sample table.

---

## Task 1.5: Rust mirror structs + `validate()` + `verify_ids()` (contract, Rust half)

**Files:**
- Create: `src-tauri/src/parser/mod.rs`
- Modify: `src-tauri/src/lib.rs` (declare `pub mod parser;`)
- Test: `src-tauri/tests/parser.rs`

**Interfaces:**
- Produces: `parser::{LookupTable, MetaNode, SectionNode, ParagraphNode, Span, Order}`; `LookupTable::validate() -> Result<(), String>`; `LookupTable::verify_ids(&self, source: &str) -> Result<(), String>`. Consumed by `payload.rs` (Task 1.8) and the round-trip test (1.7).

- [ ] **Step 1: Write failing tests for validate + verify_ids**

`src-tauri/tests/parser.rs`:
```rust
use app_lib::parser::LookupTable; // adjust crate name to Cargo.toml [lib] name

#[test]
fn validate_rejects_dangling_parent() {
    let json = r#"{
      "version":1,"doc_hash":"aaaa","meta":{},
      "sections":{},
      "paragraphs":{"P-00000000-0":{"id":"P-00000000-0","level":0,"parent":"S-nope-0","kind":"prose","span":{"start":0,"end":3},"html":"x"}},
      "order":{"meta":[],"sections":[],"paragraphs":["P-00000000-0"]}
    }"#;
    let t: LookupTable = serde_json::from_str(json).unwrap();
    assert!(t.validate().is_err());
}

#[test]
fn verify_ids_rejects_wrong_hash() {
    let src = "hello world paragraph one";
    let json = r#"{
      "version":1,"doc_hash":"aaaa",
      "meta":{"M1":{"id":"M1","level":-2,"children":["S-00000000-0"],"title":"m","body":"b"}},
      "sections":{"S-00000000-0":{"id":"S-00000000-0","level":-1,"parent":"M1","children":["P-deadbeef-0"],"title":"s","body":"b"}},
      "paragraphs":{"P-deadbeef-0":{"id":"P-deadbeef-0","level":0,"parent":"S-00000000-0","kind":"prose","span":{"start":0,"end":5},"html":"x"}},
      "order":{"meta":["M1"],"sections":["S-00000000-0"],"paragraphs":["P-deadbeef-0"]}
    }"#;
    let t: LookupTable = serde_json::from_str(json).unwrap();
    assert!(t.validate().is_ok(), "referential integrity should hold");
    assert!(t.verify_ids(src).is_err(), "deadbeef is not the real hash of bytes 0..5");
}
```
> The `[lib]` crate name is whatever `src-tauri/Cargo.toml` declares (commonly `app_lib` for Tauri v2 templates). Fix the `use` path to match before running.

- [ ] **Step 2: Run — expect fail (won't compile: no parser module)**

Run: `cd src-tauri && cargo test --test parser; cd ..`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `parser/mod.rs`** by transcribing spec §2.3 verbatim

Copy the full Rust block from spec §2.3 into `src-tauri/src/parser/mod.rs`: `Span`, `ParagraphNode`, `SectionNode`, `MetaNode`, `Order`, `LookupTable`, and the `impl LookupTable { validate, verify_ids }`. Add `pub mod parser;` to `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run — expect pass**

Run: `cd src-tauri && cargo test --test parser; cd ..`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Rust mirror structs + validate + verify_ids (spec §2.3)"
```

**Done when:** `validate()` rejects dangling parents; `verify_ids()` rejects a hash that doesn't match the span slice.

---

## Task 1.6: `docs/payload-format.md` — the versioned contract

**Files:**
- Create: `docs/payload-format.md`, `src/engine/payload.schema.json`
- Test: `src/engine/payload-schema.test.ts` (schema-validates the fixture's embedded payload)

**Interfaces:**
- Produces: the human+machine contract (JSON Schema + addenda A1–A4). Consumed by Engine A authors and by validation tests.

- [ ] **Step 1: Author `docs/payload-format.md`**

Contents, in order: (a) a one-paragraph intro naming this the versioned agent↔app contract; (b) the marker convention from spec §2.6 (`<!-- semantic-zoom:payload:v1` … `-->`, EOF-placed); (c) the **JSON Schema transcribed verbatim from spec §2.4**; (d) the four addenda **transcribed verbatim from spec §2.6** (A1 docHash region, A2 span region, A3 `-->` escaping, A4 D6 ID derivation).

- [ ] **Step 2: Create the machine-readable schema copy**

`src/engine/payload.schema.json` = the exact JSON Schema object from spec §2.4. Add a note in `docs/payload-format.md` that this JSON file and the doc's fenced block must stay identical.

- [ ] **Step 3: Install a JSON Schema validator (dev only)**

```bash
npm i -D ajv
```

- [ ] **Step 4: Write the failing test that validates the fixture payload against the schema**

`src/engine/payload-schema.test.ts`:
```ts
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

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
```

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- payload-schema`
Expected: PASS — the existing fixture payload validates. If it does **not** validate, STOP and flag (the fixture is a read-only oracle; do not edit it).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: payload-format.md contract + schema validation of fixture (spec §2.4/§2.6)"
```

**Done when:** `docs/payload-format.md` exists with schema + A1–A4, and the fixture's embedded payload passes JSON Schema validation (backlog 1.4).

---

## Task 1.7: Round-trip test — Rust parse ≡ TS parse (the anti-drift spine)

> CLAUDE.md: "the standing defense against Rust/TS mirror drift… runs in CI from the moment it exists." Get 1.4/1.5 reviewed before this; this task locks them together.

**Files:**
- Test: `src-tauri/tests/roundtrip.rs`, `src/engine/roundtrip.test.ts`
- Create: `fixtures/roundtrip-expected.json` (**derived**, NOT a fixture oracle — generated from the read-only fixture, may be regenerated; add to `.gitignore` or commit as generated — team choice).

**Interfaces:**
- Consumes: `parser::LookupTable` + `parser::payload::extract_payload` (Rust), `buildIndex` + `LookupTable` (TS), `fixtures/zoom_test.md`.
- Produces: proof that Rust `serde_json` parse of the fixture payload and TS `JSON.parse` produce structurally equal tables and pass `validate()` + `verify_ids()` + `buildIndex()`.

> Ordering note: this task uses `extract_payload` from Task 1.8. Either do Task 1.8 first, or inline the `rfind`-based extraction directly in this test. The plan lists 1.7 before 1.8 to emphasize it is the review gate; do them together.

- [ ] **Step 1: Rust side — parse fixture payload, validate, verify_ids, dump canonical JSON**

`src-tauri/tests/roundtrip.rs`:
```rust
use app_lib::parser::LookupTable;
use app_lib::parser::payload::extract_payload;
use std::fs;

fn fixture() -> String {
    fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/zoom_test.md")).unwrap()
}

// pre-payload region = bytes before the marker (A1/A2)
fn pre_payload(src: &str) -> &str {
    let head = "<!-- semantic-zoom:payload:v1";
    &src[..src.rfind(head).unwrap()]
}

#[test]
fn fixture_payload_parses_validates_and_verifies() {
    let src = fixture();
    let parsed: LookupTable = extract_payload(&src).expect("payload present").expect("payload valid");
    parsed.validate().expect("referential integrity");
    parsed.verify_ids(pre_payload(&src)).expect("D6 content hashes");
    let canon = serde_json::to_string(&parsed).unwrap();
    fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/roundtrip-expected.json"), canon).unwrap();
}
```

- [ ] **Step 2: Run the Rust side**

Run: `cd src-tauri && cargo test --test roundtrip; cd ..`
Expected: PASS (also writes `fixtures/roundtrip-expected.json`). If `verify_ids` fails, STOP and flag — do not touch the fixture.

- [ ] **Step 3: TS side — parse same payload, structural-equal to Rust's canonical form**

`src/engine/roundtrip.test.ts`:
```ts
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildIndex, type LookupTable } from './schema';

const HEAD = '<!-- semantic-zoom:payload:v1';
const TAIL = '-->';
function extract(src: string): string {
  const start = src.lastIndexOf(HEAD);
  const jsonStart = start + HEAD.length;
  const end = src.slice(jsonStart).lastIndexOf(TAIL) + jsonStart;
  return src.slice(jsonStart, end).trim();
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, normalize(val)]));
  }
  return v;
}

test('TS parse of fixture payload structurally equals Rust canonical parse', () => {
  const src = readFileSync(new URL('../../fixtures/zoom_test.md', import.meta.url), 'utf8');
  const tsTable = JSON.parse(extract(src)) as LookupTable;
  const rustCanon = JSON.parse(readFileSync(new URL('../../fixtures/roundtrip-expected.json', import.meta.url), 'utf8'));
  // Rust serializes snake_case (doc_hash) by default; TS uses camelCase (docHash).
  // Compare the fields both agree on structurally; docHash asserted separately.
  expect(normalize({ ...tsTable, docHash: undefined }))
    .toEqual(normalize({ ...rustCanon, doc_hash: undefined }));
  expect(tsTable.docHash).toBe(rustCanon.doc_hash);
  expect(() => buildIndex(tsTable)).not.toThrow();
});
```
> If Rust's serde is configured with `rename_all = "camelCase"` to emit `docHash`, simplify to a single `normalize` equality. Decide the serialization casing when transcribing §2.3 and keep the test consistent — this casing choice is exactly the kind of mirror drift the test guards.

- [ ] **Step 4: Run the TS side**

Run: `npm test -- roundtrip`
Expected: PASS.

- [ ] **Step 5: Wire both into a single CI script**

Add to `package.json`: `"ci": "npm run lint && npm test && (cd src-tauri && cargo test)"`.
Run: `npm run ci`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test: Rust≡TS round-trip on fixture payload (anti-drift spine)"
```

**Done when:** sample payload → Rust parse → `validate()` + `verify_ids()` → frontend `buildIndex()` all pass, and Rust/TS structures match (backlog 1.2).

---

## Task 1.8: `load_document` command + Engine A extraction + `LoadResult`

**Files:**
- Create: `src-tauri/src/parser/payload.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/document.rs`, `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs` (register command + managed state)
- Test: `src-tauri/tests/extract.rs`

**Interfaces:**
- Consumes: `parser::LookupTable`.
- Produces: `payload::extract_payload(source: &str) -> Option<Result<LookupTable, String>>`; `commands::document::load_document(...) -> Result<LoadResult, String>`; `LoadResult` enum `{ Native{table,raw}, Untagged{raw}, Corrupt{raw,error} }` (serde tag `"kind"`, camelCase). Consumed by `main.ts` bridge (Task 1.9) and the store DTO (Task 2.1).

- [ ] **Step 1: Write failing tests for the three extraction outcomes**

`src-tauri/tests/extract.rs`:
```rust
use app_lib::parser::payload::extract_payload;
use sha2::{Digest, Sha256};

#[test]
fn untagged_returns_none() {
    assert!(extract_payload("# just markdown\n\nno payload here").is_none());
}

#[test]
fn corrupt_json_returns_some_err() {
    let src = "text\n<!-- semantic-zoom:payload:v1\n{ not json }\n-->";
    match extract_payload(src) {
        Some(Err(_)) => {}
        other => panic!("expected Some(Err), got {other:?}"),
    }
}

#[test]
fn valid_payload_returns_some_ok() {
    let body = "the one paragraph";
    let h = &hex::encode(Sha256::digest(body.as_bytes()))[..8];
    let dh = hex::encode(Sha256::digest(body.as_bytes()));
    let json = format!(r#"{{
      "version":1,"doc_hash":"{dh}",
      "meta":{{"M1":{{"id":"M1","level":-2,"children":["S-00000000-0"],"title":"m","body":"b"}}}},
      "sections":{{"S-00000000-0":{{"id":"S-00000000-0","level":-1,"parent":"M1","children":["P-{h}-0"],"title":"s","body":"b"}}}},
      "paragraphs":{{"P-{h}-0":{{"id":"P-{h}-0","level":0,"parent":"S-00000000-0","kind":"prose","span":{{"start":0,"end":{end}}},"html":"x"}}}},
      "order":{{"meta":["M1"],"sections":["S-00000000-0"],"paragraphs":["P-{h}-0"]}}
    }}"#, h = h, end = body.len(), dh = dh);
    let src = format!("{body}\n<!-- semantic-zoom:payload:v1\n{json}\n-->");
    let table = extract_payload(&src).expect("some").expect("ok");
    assert_eq!(table.version, 1);
}
```

- [ ] **Step 2: Run — expect fail (no payload module)**

Run: `cd src-tauri && cargo test --test extract; cd ..`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `payload.rs`** by transcribing spec §2.6 verbatim

Copy the `extract_payload` function (with `HEAD`/`TAIL` consts) from spec §2.6 into `src-tauri/src/parser/payload.rs`; add `pub mod payload;` to `parser/mod.rs`.
> Note: spec §2.6 `extract_payload` calls `validate()` but **not** `verify_ids()` — `verify_ids` needs the *pre-payload source region* (A1/A2), which `extract_payload` doesn't receive. Keep it that way; the command layer (Step 4) calls `verify_ids` with the correct region. Do not "improve" §2.6 to add verify_ids inside it.

- [ ] **Step 4: Implement the `load_document` command + `LoadResult`**

`src-tauri/src/state.rs`: define `AppState { watched: Mutex<Option<PathBuf>>, doc_hash: Mutex<Option<String>> }` with `Default`.
`src-tauri/src/commands/document.rs`: transcribe the `LoadResult` enum from spec §2.6, then implement:
```rust
use crate::parser::payload::extract_payload;

#[tauri::command]
pub fn load_document(path: String) -> Result<LoadResult, String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match extract_payload(&raw) {
        None => Ok(LoadResult::Untagged { raw }),
        Some(Err(error)) => Ok(LoadResult::Corrupt { raw, error }),
        Some(Ok(table)) => {
            // A1/A2: verify against the pre-payload region only.
            let head = "<!-- semantic-zoom:payload:v1";
            let pre = &raw[..raw.rfind(head).unwrap()];
            match table.verify_ids(pre) {
                Ok(()) => Ok(LoadResult::Native { table, raw }),
                Err(error) => Ok(LoadResult::Corrupt { raw, error }),
            }
        }
    }
}
```
Add `pub mod commands;` and `pub mod state;` to `lib.rs`; register `load_document` in `invoke_handler!` and `.manage(state::AppState::default())`.

- [ ] **Step 5: Run all Rust tests**

Run: `cd src-tauri && cargo test; cd ..`
Expected: PASS (smoke, parser, roundtrip, extract).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: load_document + Engine A extraction + LoadResult (spec §2.6)"
```

**Done when:** tagged file → `Native`; untagged → `Untagged`; broken JSON → `Corrupt`; unit tests for all three (backlog 1.3).

---

## Task 1.9: Static three-level rendering + 3-detent slider (no transitions)

**Files:**
- Create: `src/engine/engine-a.ts`, `src/ui/viewport.ts` (static render only), `src/ui/slider.ts`, `src/styles/base.css`, `src/styles/slider.css`, `src/styles/focus-mask.css` (transcribe §4.2 in full now), `src/main.ts`, `index.html` body.
- Test: `src/ui/viewport.test.ts`, `src/ui/slider.test.ts` (jsdom).

**Interfaces:**
- Consumes: `LookupTable`, `buildIndex`, `load_document` result.
- Produces: `renderLevel(container: HTMLElement, table: LookupTable, index: ResolvedIndex, level: ZoomLevel): void`; `mountSlider(el, opts): () => void`; `engine-a.ts` `LoadResultDTO` type mirroring the Rust enum. Consumed by main.ts and Week 2.

- [ ] **Step 1: Set Vitest to jsdom for UI tests**

`vitest.config.ts`: `test: { environment: 'jsdom' }`. Install: `npm i -D jsdom`.

- [ ] **Step 2: Write failing test — viewport renders k=0 group structure (spec §4.1)**

`src/ui/viewport.test.ts`:
```ts
import { test, expect } from 'vitest';
import { renderLevel } from './viewport';
import { buildIndex } from '../engine/schema';
import { sampleTable } from '../engine/schema.test';

test('renderLevel(0) wraps each section in a .pgroup with data-sid and .pnode children', () => {
  const root = document.createElement('main');
  renderLevel(root, sampleTable, buildIndex(sampleTable), 0);
  const groups = root.querySelectorAll('.pgroup');
  expect(groups.length).toBe(1);
  expect(groups[0].getAttribute('data-sid')).toBe('S-00000000-0');
  const nodes = groups[0].querySelectorAll('.pnode');
  expect(nodes.length).toBe(2);
  expect(nodes[0].getAttribute('data-pid')).toBe('P-11111111-0');
  expect(nodes[0].getAttribute('data-kind')).toBe('prose');
});

test('renderLevel(-1) renders section titles; (-2) renders meta titles', () => {
  const root = document.createElement('main');
  renderLevel(root, sampleTable, buildIndex(sampleTable), -1);
  expect(root.textContent).toContain('s');
  renderLevel(root, sampleTable, buildIndex(sampleTable), -2);
  expect(root.textContent).toContain('m');
});
```

- [ ] **Step 3: Run — expect fail**

Run: `npm test -- viewport`
Expected: FAIL.

- [ ] **Step 4: Implement `renderLevel`** — iterate `order` arrays (never `Object.keys`), build the §4.1 DOM

k=0: for each `sid` in `order.sections`, create `<section class="pgroup" data-sid=sid>`; for each child `pid`, `<div class="pnode" data-pid data-kind>` with `innerHTML = paragraph.html`. k=−1: render each section's `title` + `body`. k=−2: each meta `title` + `body`. Always iterate `order.*`, never `Object.keys` (spec §2.2 comment). Clear the container per-render for now with keyed removal (not `innerHTML=''` on the shared viewport — build into a fresh child container), since keyed reconciliation arrives in Task 3.2.

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- viewport`
Expected: PASS.

- [ ] **Step 6: Write failing test — slider has 3 detents, disables unavailable levels**

`src/ui/slider.test.ts`:
```ts
import { test, expect, vi } from 'vitest';
import { mountSlider } from './slider';

test('slider emits ZoomLevel on detent change and disables levels', () => {
  const el = document.createElement('div');
  const onChange = vi.fn();
  const teardown = mountSlider(el, { onChange, disabledLevels: [-1, -2] });
  const detents = el.querySelectorAll('[data-detent]');
  expect(detents.length).toBe(3);
  expect(el.querySelector('[data-detent="-1"]')?.hasAttribute('data-disabled')).toBe(true);
  (el.querySelector('[data-detent="0"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledWith(0);
  (el.querySelector('[data-detent="-1"]') as HTMLElement).click();
  expect(onChange).toHaveBeenCalledTimes(1);
  teardown();
});
```

- [ ] **Step 7: Run — fail — implement `mountSlider` — pass**

Three detents mapped to levels `[0, -1, -2]`; `data-disabled` + tooltip ("Generating summary…" / "No summary available") on `disabledLevels`; `onChange` on click of enabled detents; return teardown removing listeners.
Run: `npm test -- slider`
Expected: PASS.

- [ ] **Step 8: Wire `main.ts` end-to-end for manual check** (Tauri imports allowed here only)

Transcribe the bridge from spec §3.3 (`listen('doc://changed', …)`, `openFile`, `invoke('load_document')`, `invoke('watch_directory')`). On `Native`: `buildIndex` + `renderLevel(viewport, table, index, currentLevel)`; slider `onChange` re-renders instantly (no transition yet). On `Untagged`/`Corrupt`: render k=0 raw, pass `disabledLevels: [-1, -2]`. Add a native file-open via `tauri-plugin-dialog`.

- [ ] **Step 9: Manual acceptance against the fixture**

Run: `npm run tauri dev`, open `fixtures/zoom_test.md`.
Expected: all three levels render correct content; slider switches instantly; a plain README (no payload) disables −1/−2 with tooltips.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: static 3-level render + 3-detent slider (backlog 1.5)"
```

**Done when:** all three levels render correct content for the fixture; slider disabled states work for `Untagged` (backlog 1.5). **Week 1 milestone gate — do not start Week 2 until this passes.**

---

# Week 2 — Spatial anchoring, caret, spotlight

## Task 2.1: RxJS store, actions, selectors, subscription hygiene

**Files:**
- Create: `src/state/store.ts`, `src/state/actions.ts`, `src/state/selectors.ts`
- Test: `src/state/store.test.ts`

**Interfaces:**
- Consumes: `LookupTable`, `ResolvedIndex`, `ZoomLevel`, `LoadResultDTO`.
- Produces: `state$` (private), `actions$`, `select<T>(fn)`, `AppState`, `Action`, `DocStatus`, and a pure `reduce(state, action)`. Consumed by every UI module in Week 2/3.

- [ ] **Step 1: Failing test — reducer + selector distinctness**

`src/state/store.test.ts`:
```ts
import { test, expect, vi } from 'vitest';
import { select, actions$, type AppState } from './store';

test('ZOOM_SET changes zoom; unrelated CARET_PLACED does not re-emit zoom selector', () => {
  const zoomSpy = vi.fn();
  const sub = select((s: AppState) => s.zoom).subscribe(zoomSpy);
  actions$.next({ type: 'ZOOM_SET', level: -1 });
  actions$.next({ type: 'CARET_PLACED', paragraphId: 'P-x-0', offset: 3 });
  actions$.next({ type: 'CARET_PLACED', paragraphId: 'P-x-0', offset: 4 });
  // zoom selector emits: initial(0) + set(-1) = 2, NOT 4
  expect(zoomSpy).toHaveBeenCalledTimes(2);
  sub.unsubscribe();
});
```

- [ ] **Step 2: Run — fail. Implement `store.ts`** by transcribing spec §3.1 verbatim (`AppState`, `Action`, `initial`, `state$`, `actions$`, `select`), plus a pure `export function reduce(s: AppState, a: Action): AppState`.

Reducer rules (spec §3.2): `ZOOM_SET` sets `zoom`. `CARET_PLACED` sets `caret` and recomputes `activeGroupHead` = `index.siblingGroup.get(paragraphId)?.[0] ?? null`, returning the *same* `activeGroupHead` reference when unchanged so the selector's `distinctUntilChanged` suppresses re-emission. `DOC_LOADED` swaps `doc`/`index`/`raw`/`status`. `DOC_CHANGED_ON_DISK` sets `status:'reloading'` (effect handles the reload in Week 3).

- [ ] **Step 3: Run — expect pass.**

Run: `npm test -- store`
Expected: PASS.

- [ ] **Step 4: Add a dev render-counter harness** so backlog 2.1 is checkable: a `window.__renders` counter incremented in the slider's zoom subscription; document how to read it.

- [ ] **Step 5: Commit** `git commit -am "feat: RxJS single store + selectors + reducer (spec §3.1/§3.2)"`

**Done when:** caret moves don't re-render the slider (render counter proves it) — backlog 2.1.

---

## Task 2.2: Read-only caret — click-to-place + arrow traversal

**Files:**
- Create: `src/ui/caret.ts`
- Test: `src/ui/caret.test.ts`

**Interfaces:**
- Consumes: `.pnode[data-pid]` DOM, an injected `dispatch` fn.
- Produces: `mountCaret(viewport, dispatch): () => void` (dispatches `CARET_PLACED`, `auditTime(16)`-throttled per spec §3.2) and a pure `nextParagraph(pids, current, dir): string` helper for unit testing. Consumed by focus-mask + anchor.

- [ ] **Step 1: Failing test** — click on a `.pnode` calls `dispatch({type:'CARET_PLACED', paragraphId})`; `nextParagraph(['a','b','c'],'a',+1)==='b'`; clamps at ends.

- [ ] **Step 2: Run — fail. Implement `caret.ts`:** click handler resolves nearest ancestor `.pnode`, reads `data-pid`, dispatches `CARET_PLACED`; arrow keys move a `data-caret` marker across `.pnode`s in document order (read-only — no text editing) via `nextParagraph`. Apply `auditTime(16)` on the outgoing stream inside `mount`, keeping `nextParagraph` pure.

- [ ] **Step 3: Run — pass.** `npm test -- caret`

- [ ] **Step 4: Dev HUD** — show `caret.paragraphId` + `offset` in a corner element behind a `?dev` flag (backlog 2.2).

- [ ] **Step 5: Commit** `git commit -am "feat: read-only caret place + arrow traversal (backlog 2.2)"`

**Done when:** caret id/offset visible in a dev HUD (backlog 2.2).

---

## Task 2.3: Anchor engine — resolution, cross-level mapping, place memory

**Files:**
- Create: `src/engine/anchor.ts`
- Test: `src/engine/anchor.test.ts`

**Interfaces:**
- Consumes: `ResolvedIndex`, `LookupTable`, `lastCaretIn`/`lastAnchorIn` maps.
- Produces: `resolveAnchor(ctx): string`, `mapAcrossLevels(from: ZoomLevel, to: ZoomLevel, anchor: string, ctx): string`, `centerScrollTop(el, viewport): number`. Consumed by the zoom transition (Task 2.4).

- [ ] **Step 1: Failing tests for all 6 level-pair mappings** (spec §2.5 table), incl. the two-hop −2↔0

`src/engine/anchor.test.ts` covers: `0→−1` = `parentOfParagraph`; `0→−2` = `parentOfSection(parentOfParagraph)`; `−1→0` = `lastCaretIn[S] ?? section.children[0]` (test both branches); `−1→−2` = `parentOfSection`; `−2→−1` = `lastAnchorIn[M] ?? meta.children[0]` (both branches); `−2→0` = two-hop.

- [ ] **Step 2: Run — fail. Implement `anchor.ts`:** transcribe `centerScrollTop` verbatim from spec §2.5; implement `resolveAnchor` (caret pid, else nearest-to-viewport-center via cached `offsetTop`/`offsetHeight` — no `getBoundingClientRect` in a loop, spec §2.5) and `mapAcrossLevels` following the §2.5 table exactly.

- [ ] **Step 3: Run — pass.** `npm test -- anchor`

- [ ] **Step 4: Commit** `git commit -am "feat: anchor engine + cross-level mapping + centerScrollTop (spec §2.5)"`

**Done when:** unit tests for all 6 level-pair mappings incl. two-hop −2↔0 (backlog 2.3).

---

## Task 2.4: Two-layer zoom transition (mount → pre-scroll → 200ms crossfade → unmount)

**Files:**
- Modify: `src/ui/viewport.ts` (add layered transition + single rAF scroll queue)
- Confirm: `src/styles/focus-mask.css` `.level-layer` blocks present (from §4.2)
- Test: `src/ui/transition.test.ts`

**Interfaces:**
- Consumes: `renderLevel`, `anchor.ts`, `select(s=>s.zoom)`.
- Produces: `mountZoomTransitions(viewport, getState): () => void`; `scrollCommands$` single rAF queue (spec §3.2). Consumed by main.ts.

- [ ] **Step 1: Failing test — transition ordering (D8: two frames, opacity-only)**

Stub rAF / fake timers: on `ZOOM_SET`, (a) new `.level-layer[data-entering]` appended `visibility:hidden` in frame n with **no** scroll read/write; (b) in frame n+1 `scrollTop` set from `centerScrollTop`, then `data-entering` removed to start the fade; (c) on `transitionend` old layer removed. Assert no `scrollTop` write in frame n; assert only `opacity` is animated (no inline `filter` transition).

- [ ] **Step 2: Run — fail. Implement** exactly per spec §2.5 "Transition sequence" steps 1–4; route every scroll write through `scrollCommands$.pipe(observeOn(animationFrameScheduler))` (spec §3.2); key the effect by zoom with `switchMap` so slider spam aborts in-flight transitions (spec §3.2 row 1); set `[data-transitioning]` on `#viewport` only during the 200ms window (§4.2 `will-change` gating).

- [ ] **Step 3: Run — pass.** `npm test -- transition`

- [ ] **Step 4: Manual acceptance** — `npm run tauri dev`, fixture: caret in a P deep in section 2 → slide to −1 → parent S arrives **already centered**, zero visible scroll motion; slide back → caret's P restored. Verify `prefers-reduced-motion` still disables the transition.

- [ ] **Step 5: Commit** `git commit -am "feat: two-frame opacity zoom transition + rAF scroll queue (spec §2.5, D8)"`

**Done when:** caret in P → slide to −1 → parent S arrives centered, zero visible scroll motion; reverse restores P (backlog 2.4).

---

## Task 2.5: Focus mask — group dimming + token remap

**Files:**
- Create: `src/ui/focus-mask.ts`
- Confirm: `src/styles/focus-mask.css` fully transcribed from spec §4.2
- Test: `src/ui/focus-mask.test.ts`

**Interfaces:**
- Consumes: `select`, `ResolvedIndex`, `.pgroup[data-sid]` DOM.
- Produces: `mountFocusMask(viewport): () => void`. Consumed by main.ts.

- [ ] **Step 1: Failing test** — initial spotlight dims all-but-active; each subsequent active-group change touches exactly the two groups whose state flipped (spy on `setAttribute`/`removeAttribute`).

- [ ] **Step 2: Run — fail. Implement `focus-mask.ts`** by transcribing spec §4.3 verbatim (track `prevSid`, toggle ≤2 elements, set/clear `[data-transitioning]` on `transitionend`). Confirm `focus-mask.css` from §4.2 is present verbatim (opacity-only transition, instant filter class swap, `content-visibility:auto`, token-remap block, `prefers-reduced-motion`).

- [ ] **Step 3: Run — pass.** `npm test -- focus-mask`

- [ ] **Step 4: Instruments acceptance (spec §4.3)** — a 5,000-line log with ~40 code blocks *for perf only* (put in `perf/`, not `fixtures/`), hold ⌥ + arrow the caret across group boundaries 10s. Instruments → Core Animation: no main-thread frame >8ms attributable to the mask, no memory growth from layer promotion. If it fails, fall back to token-remap-only (spec §4.2 "Cheaper alternative" — explicitly sanctioned, not an override).

- [ ] **Step 5: Commit** `git commit -am "feat: focus mask group dimming + token remap (spec §4, backlog 2.5)"`

**Done when:** Instruments acceptance test in §4.3 passes on the 5,000-line stress fixture (backlog 2.5). **Week 2 milestone gate.**

---

## Task 2.6: Engine B stub + `segment()` (seam only)

**Files:**
- Create: `src/engine/engine-b.ts`
- Test: `src/engine/engine-b.test.ts`

**Interfaces:**
- Produces: `Synthesizer` interface, `stubSynthesizer` (rejects `ENGINE_B_NOT_IMPLEMENTED`), `segment(raw): {kind,start,end}[]`. Consumed by degraded-state UX (Task 3.3).

- [ ] **Step 1: Failing test** — `stubSynthesizer.synthesize(raw, new AbortController().signal)` rejects with `ENGINE_B_NOT_IMPLEMENTED`; `segment('# H\n\npara\n\n```js\nx\n```')` returns heading/paragraph/code spans with byte offsets, not descending into block children.

- [ ] **Step 2: Run — fail. Implement `engine-b.ts`** by transcribing the stub + `segment()` from spec §2.7 verbatim. (Phase-1: interface + stub only; no Ollama, no synthesis.)

- [ ] **Step 3: Run — pass.** `npm test -- engine-b`

- [ ] **Step 4: Commit** `git commit -am "feat: Engine B stub + remark segment() seam (spec §2.7)"`

**Done when:** stub rejects and `segment()` returns block spans. (Supports backlog 3.3.)

---

# Week 3 — Watcher, hot reload, hardening

## Task 3.1: Rust file watcher — parent-dir, debounced, `doc://changed`

**Files:**
- Create: `src-tauri/src/watcher/mod.rs`, `src-tauri/src/watcher/debounced.rs`
- Modify: `src-tauri/src/lib.rs` (manage `WatcherState`, register `watch_directory`)
- Test: `src-tauri/tests/watcher.rs`

**Interfaces:**
- Produces: `watcher::debounced::{WatcherState, watch_directory, is_atomic_sibling}`; emits `doc://changed`. Crossing #2 and event #3 — no others.

- [ ] **Step 1: Failing unit test for `is_atomic_sibling`**

`src-tauri/tests/watcher.rs`:
```rust
use app_lib::watcher::debounced::is_atomic_sibling;
use std::path::Path;

#[test]
fn atomic_siblings_match_target_stem() {
    assert!(is_atomic_sibling(Path::new("/d/file.md.tmp"), Path::new("/d/file.md")));
    assert!(is_atomic_sibling(Path::new("/d/.file.md.swp"), Path::new("/d/file.md")));
    assert!(!is_atomic_sibling(Path::new("/d/other.md"), Path::new("/d/file.md")));
}
```
> `is_atomic_sibling` is `fn` in spec §5.2; make it `pub fn` so the test can reach it.

- [ ] **Step 2: Run — fail. Implement `debounced.rs`** by transcribing spec §5.2 verbatim (`WatcherState`, `watch_directory` 500ms debounce, parent-dir `NonRecursive` watch, `is_atomic_sibling` as `pub`, drop-old-debouncer-to-release). Register in `lib.rs` per spec §5.2 "Registration". Add `pub mod watcher;` and `pub mod debounced;`.

- [ ] **Step 3: Run — pass.** `cd src-tauri && cargo test --test watcher; cd ..`

- [ ] **Step 4: Manual acceptance (backlog 3.1)** — copy the fixture to a scratch dir (never edit the real fixture), `npm run tauri dev`, open the copy. Edit via VS Code (atomic save) and via `echo >> scratch.md` (append); confirm **exactly one** `doc://changed` per burst (temporary counter log). Both fire once.

- [ ] **Step 5: Commit** `git commit -am "feat: debounced parent-dir watcher → doc://changed (spec §5, backlog 3.1)"`

**Done when:** atomic save and append both fire exactly one event per burst (backlog 3.1).

---

## Task 3.2: Silent hot-reload state sync — hash short-circuit, keyed reuse, tiered caret restore

**Files:**
- Modify: `src/main.ts` (reload effect on `doc://changed`), `src/ui/viewport.ts` (keyed reconciliation)
- Create: `src/state/reload.ts` (pure caret-restoration + reconciliation-diff logic)
- Test: `src/state/reload.test.ts`, `src/ui/reconcile.test.ts`

**Interfaces:**
- Consumes: `load_document`, `LookupTable`, previous render's `Map<sid, HTMLElement>`.
- Produces: `restoreCaret(oldCaret, oldTable, newTable): {paragraphId: string, offset: number} | null` (tiered a/b/c per spec §5.3); `reconcile(container, newTable, index, prevNodes): Map<sid, HTMLElement>` (keyed by sid + child-id list, D7).

- [ ] **Step 1: Failing tests for tiered restoration (spec §5.3 step 5)** —
  (a) exact old `P-<h>-<k>` exists → keep caret;
  (b) hash exists but occurrence count changed → disambiguate by prev/next sibling-hash context, else nearest by document-position ratio;
  (c) hash gone → parent S's first surviving child; parent gone → `null`.

- [ ] **Step 2: Failing test for keyed reconciliation (D7)** — a group whose sid **and** full child-ID list are unchanged keeps its exact DOM node (`===`); appended groups newly built; removed groups unmounted; `innerHTML=''` **never** called (spy on container).

- [ ] **Step 3: Run — fail. Implement `reload.ts` + `reconcile`** per spec §5.3 steps 1–5. The effect: on `DOC_CHANGED_ON_DISK` → `invoke('load_document')` → compare `docHash`; identical ⇒ drop silently (no store emission); different ⇒ single `DOC_LOADED` → `reconcile` (keeps unchanged DOM nodes) → `restoreCaret`.

- [ ] **Step 4: Run — pass.** `npm test -- reload reconcile`

- [ ] **Step 5: Manual acceptance (backlog 3.2)** — mid-session, append 50 paragraphs AND insert 5 at the top of the scratch doc. Dev HUD asserts unchanged groups kept DOM node identity; caret stays on the same *content*; only the 1.5s non-modal "Updated" pill appears — no modal, no flicker, no full rebuild.

- [ ] **Step 6: Commit** `git commit -am "feat: silent hot-reload — hash short-circuit, keyed reuse, tiered caret restore (spec §5.3, D7)"`

**Done when:** append-50 + insert-5 mid-session keeps DOM identity for unchanged groups, caret stays on same content, no modal (backlog 3.2).

---

## Task 3.3: Degraded-state UX — disabled detents, "no summary", Corrupt badge, "Updated" pill

**Files:**
- Modify: `src/ui/slider.ts` (tooltips), `src/main.ts` (status→UI), `src/styles/base.css`
- Create: `src/ui/status-badge.ts`
- Test: `src/ui/status-badge.test.ts`

**Interfaces:**
- Consumes: `select(s=>s.status)`, `DocStatus`.
- Produces: `mountStatusBadge(root): () => void` — non-modal Corrupt warning badge + 1.5s "Updated" pill.

- [ ] **Step 1: Failing test** — status `corrupt` shows a non-modal warning badge with the error text; a reload success shows a pill auto-dismissing after 1.5s (fake timers); `untagged` disables −1/−2 detents with "No summary available"; a generating state shows "Generating summary…".

- [ ] **Step 2: Run — fail. Implement `status-badge.ts` + slider tooltips.** No modals, no diff view (spec §5.3 step 6). Corrupt → k=0 + badge (spec §2.6 `LoadResult::Corrupt`).

- [ ] **Step 3: Run — pass.** `npm test -- status-badge`

- [ ] **Step 4: Manual acceptance (backlog 3.3)** — open a random README: calm, non-broken (k=0, disabled higher detents, no errors). Open a file with deliberately broken payload JSON: k=0 + warning badge, still usable.

- [ ] **Step 5: Commit** `git commit -am "feat: degraded-state UX — disabled detents, corrupt badge, updated pill (backlog 3.3)"`

**Done when:** loading any random README is a calm, non-broken experience (backlog 3.3).

---

## Task 3.4: Perf pass — 1 MB / 10k-paragraph synthetic doc

**Files:**
- Create: `perf/gen-synthetic.mjs` (generates a 1 MB / 10k-paragraph .md **with a valid D6-hashed payload** — perf harness, NOT a `fixtures/` oracle), `docs/perf-baseline.md`

**Interfaces:**
- Produces: recorded budgets: ≤10 ms extract, ≤16 ms mask frame, ≤250 ms level swap end-to-end.

- [ ] **Step 1: Generate the synthetic doc** with correctly D6-hashed IDs (Node sha256 so `verify_ids` passes).
- [ ] **Step 2: Measure extraction** — `debug_assert!` timing log in `extract_payload` (spec §2.6: add a timing log, not an optimization). Record ms.
- [ ] **Step 3: Measure mask frame + level swap** via Instruments / `performance.now()` around transition + mask toggles.
- [ ] **Step 4: Write `docs/perf-baseline.md`** with the three numbers + machine spec. If any budget is blown, STOP and flag (fix the code, don't loosen the budget).
- [ ] **Step 5: Commit** `git commit -am "perf: record 1MB/10k-para baselines (backlog 3.4)"`

**Done when:** numbers recorded in `docs/perf-baseline.md`, all within budget (backlog 3.4).

---

## Task 3.5: Packaging — signed `.dmg`, clean-machine smoke test

**Files:**
- Modify: `src-tauri/tauri.conf.json` (confirm dmg + signing from 1.1)

- [ ] **Step 1:** `npm run tauri build` → `.dmg` (ad-hoc signing acceptable for Phase 1).
- [ ] **Step 2:** Install on a clean machine / fresh user; open the fixture. Expected: opens correctly, all three levels render.
- [ ] **Step 3: Commit** any config changes `git commit -am "chore: dmg packaging + ad-hoc signing (backlog 3.5)"`

**Done when:** fresh install opens the fixture correctly (backlog 3.5).

---

## Task 3.6: Buffer / bug-fix — drive P0/P1 to zero

- [ ] **Step 1:** Full gate: `npm run ci` (lint + vitest + cargo test) — all green.
- [ ] **Step 2:** Re-run Week-1/2/3 manual acceptance checks end-to-end against the fixture; fix regressions (fix the code, not the check).
- [ ] **Step 3:** Confirm the three-crossings invariant: grep that `@tauri-apps/*` appears only in `src/main.ts` and `src/state/**` (`npm run lint` enforces engine/ui; eyeball the rest). Confirm no `innerHTML=''` on the viewport.
- [ ] **Step 4: Commit** fixes.

**Done when:** issue tracker at zero P0/P1 (backlog 3.6). **Phase 1 complete.**

---

## Self-Review (performed against spec §0–§7)

**Spec coverage:** Every backlog row maps to a task — 1.1→T1.1; 1.2→T1.4/1.5/1.7; 1.3→T1.8; 1.4→T1.6; 1.5→T1.9; 2.1→T2.1; 2.2→T2.2; 2.3→T2.3; 2.4→T2.4; 2.5→T2.5; 3.1→T3.1; 3.2→T3.2; 3.3→T3.3 (+T2.6 seam); 3.4→T3.4; 3.5→T3.5; 3.6→T3.6. Decisions D1–D8 each land in a task and are flagged non-overridable. Hard boundaries (three crossings; no-Tauri-in-engine/ui via ESLint installed *first* in T1.3; read-only fixtures) are Global Constraints. Addenda A1–A4 authored in T1.6, enforced in T1.8 (`verify_ids` on pre-payload region) + T3.2 (docHash short-circuit on same region). System E (export) correctly deferred — only its import-hygiene lint rule (T1.3) is built, per spec §6.

**Placeholder scan:** Large authoritative code blocks are intentionally referenced-by-section (not duplicated) to prevent mirror drift, per CLAUDE.md — documented in "How to use this plan". All *new* content (tests, commands, ESLint config, reducer rules, `load_document` body, `is_atomic_sibling` test) is written in full.

**Type consistency:** `LookupTable`/`buildIndex`/`ResolvedIndex` (T1.4) reused unchanged downstream. `sampleTable` is exported from `schema.test.ts` and imported by `viewport.test.ts` (no re-paste drift). `LoadResult`(Rust)/`LoadResultDTO`(TS) named consistently. `renderLevel`, `mountSlider`, `mountCaret`, `nextParagraph`, `mountFocusMask`, `mountZoomTransitions`, `restoreCaret`, `reconcile`, `centerScrollTop`, `mapAcrossLevels`, `resolveAnchor`, `is_atomic_sibling` — each defined once, consumed by name. The snake_case/camelCase (`doc_hash`/`docHash`) drift risk is explicitly pinned in the round-trip test (T1.7).
