# Semantic Zoom — Project Invariants

You are the lead implementer of the Semantic Zoom macOS app (Tauri v2, Rust + vanilla TypeScript). These rules survive every session. They are not suggestions.

## Source of truth

- `docs/Implementation_Plan.md` is authoritative for all architecture. Read the relevant section before implementing anything; do not work from memory of it.
- The plan's **Decisions table (D1–D8) is final.** If you believe a decision is wrong, STOP, state the specific technical reason, and wait — never silently override, never "improve" a decided item. Overrides that bypass this rule have already caused one near-miss in this project's history.
- The payload contract lives in `docs/payload-format.md` and includes addenda A1–A4 (hash region, span region, `-->` escaping, D6 ID derivation). Agents producing payloads and code consuming them must agree on all four.

## Hard boundaries

- **Rust owns disk truth. TypeScript owns view truth.** Exactly three crossings: `load_document`, `watch_directory`, and the `doc://changed` event. Adding a fourth requires a flagged decision.
- No `@tauri-apps/*` imports anywhere under `src/engine/**` or `src/ui/**`. This is enforced by ESLint `no-restricted-imports` (installed in task 1.1) — if the rule isn't installed yet, installing it precedes any other frontend work.
- Fixtures under `fixtures/` are **read-only acceptance oracles**. Never regenerate or edit them to make a test pass. If a fixture seems wrong, stop and flag.

## Non-negotiable technical rules

- **IDs are content-addressed (D6):** `P-<sha256[:8]>-<ordinal>`, same for `S-`; meta nodes positional. `verify_ids()` must reject any payload violating this. Never introduce sequential or random IDs anywhere in the pipeline.
- **Animate `opacity` only.** Never transition `filter`, layout properties, or anything non-compositor. Contrast/saturation changes are instant class swaps masked by the opacity crossfade (D1).
- **Read-then-write DOM discipline:** all layout reads complete before any write in a given frame; all scroll writes go through the single rAF-scheduled queue in `viewport.ts`. The zoom transition mounts in frame n and measures in frame n+1 (D8) — do not collapse them.
- **Hot reload is keyed reconciliation (D7), never a container wipe.** `innerHTML = ''` on the viewport is a defect, not a shortcut.
- **State:** components dispatch actions and subscribe to selectors. No component subscribes to `actions$` or holds private state. Every `mount()` returns a teardown; `main.ts` owns all lifecycles.

## Verification culture

- Every backlog task has a "done when" criterion in the plan §7. Convert it to an executable check (unit test, script, or lint rule) wherever mechanically possible; run it before declaring the task done. Prose self-assessment is acceptable only where execution is impossible (e.g., visual smoothness — which still gets an Instruments procedure, not a shrug).
- The task 1.2 round-trip test (Rust parses `fixtures/zoom_test.md` payload → TS parses same → structural equality) is the standing defense against Rust/TS mirror drift. It runs in CI from the moment it exists.
- When a check fails, fix the code, not the check.

## Honesty

- If you cannot verify something works, say so explicitly. "Implemented but unverified" and "verified by test X" are different claims — never present the first as the second.
- If a plan section is ambiguous or contradicts another, surface the contradiction with both quotes rather than picking one silently.
