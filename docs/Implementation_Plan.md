# Semantic Zoom — Phase 1 Implementation Plan

**Target:** Native macOS desktop app (Tauri v2) that renders AI-generated markdown at three discrete semantic zoom levels (k = −2, −1, 0) with spatial anchoring, focus masking, and silent hot-reload.

**Audience of this document:** A single developer of average experience. Every section is copy-paste-ready or annotated to the point where no architectural decisions remain open.

---

## 0. Architectural Decisions & Deviations (read first)

| # | Spec said | Plan does | Why |
|---|-----------|-----------|-----|
| D1 | Transition opacity **and** contrast over 200ms | Transition **opacity only**; contrast/saturation applied as an instant class swap hidden inside the opacity crossfade | `filter` is not GPU-composited in WebKit. Transitioning it repaints every dimmed code block per frame → dropped frames on large docs. Opacity is composited and free. |
| D2 | Payload "wrapped in custom comment tags (and)" | Concrete markers: `<!-- semantic-zoom:payload:v1` … `-->` | The tag names were missing from the spec. This convention is HTML-comment-safe (invisible in any markdown renderer) and versioned. |
| D3 | Engine B uses "Gemma 2" | Engine B is an **interface + stub** in Phase 1; model recommendation updated to Gemma 3 4B / Qwen3 4B (quantized, via Ollama) | Phase 1 scope explicitly excludes synthesis. Gemma 2 is superseded. |
| D4 | RxJS Subject for state | Kept, with strict rules (single store, `distinctUntilChanged` selectors, no ad-hoc subscriptions in components) | RxJS is heavier than needed for an app this size, but it is what the spec mandates and it handles the caret/scroll/slider stream coordination well. Rules below prevent the classic leak/re-render failure modes. |
| D5 | Watch "the project directory" | Watch the **parent directory** of the open file, filter events to `*.md` | VS Code/Cursor atomic saves are write-to-temp + rename. Watching a single file path breaks on rename; watching the parent dir is the only reliable pattern. |
| D6 | IDs "assigned in document order" (`P14`) | **Content-addressed IDs**: `P-<hash8>-<n>`, `S-<hash8>-<n>`; meta stays positional (`M1`) | Review finding: sequential IDs shift on mid-document insertion, silently re-anchoring the caret to *different content with the same name* after hot reload. Hash+ordinal survives insertions; the Rust validator recomputes hashes so agent payloads cannot lie. |
| D7 | Hot reload = "swap the doc… one render pass" | Keyed per-group DOM reconciliation | A full rebuild of a 5k-line doc blocks the main thread past the 250ms budget. With D6, "ID unchanged" means "bytes unchanged" — unchanged groups keep their DOM nodes by identity. |
| D8 | Mount hidden layer, read `offsetTop` synchronously | Two-frame mount (append in frame n, measure+scroll+fade in frame n+1) + `content-visibility:auto` on groups | One synchronous forced layout of a 10k-paragraph tree can exceed the frame budget alone. Reviewer's alternative (heights estimated from char counts) rejected: approximate positions break exact positioning, defeating the anchor engine. |
| D9 | (n/a — new request) Engine B was scoped to a **local** Ollama endpoint only (D3); this was changed to remote-LLM-API synthesis (§8) | Remote synthesis gets **two new Tauri crossings** (`save_api_key`, `synthesize_levels`) beyond the three the plan fixed in §1, plus a **new Rust-owned secret** (API key in OS Keychain) and a **new Rust disk write** (payload write-back). All three are confined to a new `src/native/**` directory, kept outside `src/engine/**`/`src/ui/**` so the `no-restricted-imports` rule and the System E export stay untouched. | Sending document content to a third-party API is a real trust-boundary change from the all-local Phase 1 design — it must be visible to the user (§8.5), not silent. The key must never enter the webview/JS heap past the moment it's saved, or it risks shipping inside the System E static export, which reuses `src/engine/**`/`src/ui/**` verbatim. |
| D10 | §8.4 sketched Engine B as one `synthesize_levels` command against a single remote endpoint; D3's local-Ollama-only spirit was left behind | Engine B synthesis goes through **one provider abstraction**: a single OpenAI-compatible chat client keyed by a config record (`kind: remote \| ollama \| custom-local`, `base_url`, `model`, `needs_key`) — Remote (MiMo-class), Ollama, and llama.cpp all speak the same chat-completions HTTP shape, so this is one client plus config, not three implementations. §8.4's single command sketch is split into two crossings: `llm_complete` (Rust: Keychain fetch + HTTP call — the key never enters JS) and `write_payload` (Rust: `validate()` + `verify_ids()` + hash-guarded atomic write). Segmentation/assembly reuses the proven remark-based JS from `tools/semantic-zoom-tools` (extracted into `src/native/**`), not a Rust port — the skill's own history records a silent byte-offset corruption bug in exactly that class of port. §8.6's open product calls are locked: v1 refuses documents over the model context limit with a clear message (no silent truncation); regenerate is allowed for `Untagged` docs only, never overwriting an existing `Native` payload's −1/−2. Ratified 2026-07-15, task-by-task build plan at `.claude/plans/tingly-munching-papert.md`. | Local providers reinstate D3's local-first option instead of committing the app to a remote-only trust boundary; splitting the network call from the disk write keeps the write-back gate (validate/verify_ids) as the single choke point regardless of which provider produced the layers. A Rust segmentation port would duplicate logic that has already broken once in a JS-only mirror, doubling that risk instead of removing it. |

---

## 1. Directory Structure & Boilerplate

```
semantic-zoom/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/                          # Frontend workspace (TypeScript)
│   ├── main.ts                   # Entry: wires store ⇄ Tauri events ⇄ UI
│   ├── state/
│   │   ├── store.ts              # Single BehaviorSubject<AppState> + action bus
│   │   ├── actions.ts            # Typed action creators
│   │   └── selectors.ts          # Memoized distinctUntilChanged selectors
│   ├── engine/
│   │   ├── schema.ts             # LookupTable types (§2)
│   │   ├── anchor.ts             # Bidirectional navigation math (§2.4)
│   │   ├── engine-a.ts           # Payload extraction (frontend side, thin)
│   │   └── engine-b.ts           # Phase-1 STUB: interface + "synthesis pending" state
│   ├── ui/
│   │   ├── viewport.ts           # Renders active level, owns scroll writes
│   │   ├── slider.ts             # Physical slider component (3 detents)
│   │   ├── focus-mask.ts         # Applies/removes [data-dimmed] on sibling groups
│   │   └── caret.ts              # Read-only caret placement + tracking
│   └── styles/
│       ├── base.css
│       ├── slider.css
│       └── focus-mask.css        # §4
├── src-tauri/                    # Rust backend workspace
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs               # Thin: calls lib
│       ├── lib.rs                # Builder, plugin registration, state
│       ├── state.rs              # AppState (watched path, doc hash)
│       ├── commands/
│       │   ├── mod.rs
│       │   └── document.rs       # load_document, extract_payload
│       ├── parser/
│       │   ├── mod.rs
│       │   └── payload.rs        # Engine A: marker scan + serde_json (§2.5)
│       └── watcher/
│           ├── mod.rs
│           └── debounced.rs      # §5 — notify-debouncer-mini
└── docs/
    └── payload-format.md         # The agents.md protocol contract, versioned
```

**Bootstrap commands:**

```bash
npm create tauri-app@latest semantic-zoom -- --template vanilla-ts
cd semantic-zoom
npm i rxjs unified remark-parse unist-util-visit
cd src-tauri
cargo add notify notify-debouncer-mini serde serde_json sha2 hex --features serde/derive
cargo add tauri-plugin-dialog   # native file-open dialog
```

**`tauri.conf.json` essentials (macOS-native feel):**

```jsonc
{
  "app": {
    "windows": [{
      "title": "Semantic Zoom",
      "width": 980, "height": 760,
      "titleBarStyle": "Overlay",       // traffic lights over content
      "hiddenTitle": true,
      "transparent": false
    }]
  },
  "bundle": { "targets": ["dmg"], "macOS": { "minimumSystemVersion": "12.0" } }
}
```

**Rule for the whole codebase:** Rust owns *disk truth* (reading, watching, payload extraction). TypeScript owns *view truth* (lookup table in memory, anchoring, rendering). The only crossings are three Tauri commands and one event channel (`doc://changed`).

---

## 2. The Relational Schema & Parser Engine (System A + C)

### 2.1 Conceptual model

The document is an inverted tree with strict parent/child binding:

```
M_1 (k=-2, "The Story")
 ├── S_1 (k=-1, plain-English section)
 │    ├── P_1 (k=0, raw paragraph)
 │    └── P_2
 └── S_2
      ├── P_3
      └── P_4 (code block)
```

Every node at level k = 0 has exactly one parent at k = −1; every k = −1 node has exactly one parent at k = −2. A "sibling group" (used by Focus Masking, §4) is *all P-nodes sharing the same S-parent*.

IDs are **content-addressed** (D6), never positional: `P-<hash8>-<n>`, where `hash8` is the first 8 hex chars of SHA-256 over the node's raw span text and `n` is the 0-based ordinal among nodes sharing that hash, in document order. Repeated blocks — identical code fences, standard log separators — get distinct, deterministic IDs: the third identical separator is `P-<h>-2` in every parse, on every machine. Section IDs apply the same scheme to the section's leading block (`S-<hash8>-<n>`). Meta nodes stay positional (`M1`, `M2`): story text is regenerated wholesale on every synthesis, so content identity is meaningless at that level, while narrative *slots* are stable.

Why not sequential: if an agent inserts a paragraph mid-document, `P3` becomes different content while the ID `P3` still "exists" — caret restoration (§5.3) would succeed while anchoring to the wrong paragraph, silently. Content addressing makes "same ID" mean "same bytes", which is exactly the guarantee restoration needs. The payload contract mandates this derivation, and the Rust side enforces it (`verify_ids`, §2.3) — an unenforced derivation rule is no rule, since Engine A agents author the IDs.

### 2.2 TypeScript schema (`src/engine/schema.ts`)

```ts
export type ZoomLevel = -2 | -1 | 0;

/** Raw paragraph — level 0. Immutable view of a slice of the source file. */
export interface ParagraphNode {
  id: string;                     // "P-1c9a2b3f-0" (D6)
  level: 0;
  parent: string;                 // S-node id
  kind: 'prose' | 'code' | 'list' | 'table' | 'heading' | 'blockquote';
  /** Byte offsets into the ORIGINAL markdown source. Enables copy-exact
      and cheap diffing on hot reload. */
  span: { start: number; end: number };
  /** Pre-rendered HTML (markdown → HTML at parse time, never at scroll time). */
  html: string;
  /** For kind === 'code' only. */
  lang?: string;
}

/** Plain-English section — level −1. */
export interface SectionNode {
  id: string;                     // "S-7e02d4aa-0" (D6)
  level: -1;
  parent: string;                 // M-node id
  children: string[];             // ordered P ids — THE sibling group
  title: string;
  body: string;                   // jargon-free walkthrough, plain markdown
}

/** Story meta-node — level −2. */
export interface MetaNode {
  id: string;                     // "M1" (positional — see §2.1)
  level: -2;
  children: string[];             // ordered S ids
  title: string;
  body: string;                   // accomplished / blockers / next steps
}

export interface LookupTable {
  version: 1;
  /** SHA-256 of all bytes PRECEDING the payload marker — a payload
      cannot hash a file that contains itself. The watcher's no-op
      short-circuit (§5.3) must hash the same region. */
  docHash: string;
  meta: Record<string, MetaNode>;
  sections: Record<string, SectionNode>;
  paragraphs: Record<string, ParagraphNode>;
  /** Document-order arrays. Rendering iterates these; never Object.keys(). */
  order: { meta: string[]; sections: string[]; paragraphs: string[] };
}

/** O(1) child→parent resolution both directions. Built once per load. */
export interface ResolvedIndex {
  parentOfParagraph: Map<string, string>;   // P → S
  parentOfSection: Map<string, string>;     // S → M
  siblingGroup: Map<string, string[]>;      // P → all P ids in its group
}

export function buildIndex(t: LookupTable): ResolvedIndex {
  const parentOfParagraph = new Map<string, string>();
  const parentOfSection = new Map<string, string>();
  const siblingGroup = new Map<string, string[]>();
  for (const s of Object.values(t.sections)) {
    parentOfSection.set(s.id, s.parent);
    for (const p of s.children) {
      parentOfParagraph.set(p, s.id);
      siblingGroup.set(p, s.children);
    }
  }
  return { parentOfParagraph, parentOfSection, siblingGroup };
}
```

### 2.3 Rust mirror (`src-tauri/src/parser/mod.rs`)

The Rust side never *interprets* the tree — it only validates and hands it over. Mirror structs exist so `serde_json` can reject malformed payloads at the boundary instead of poisoning the frontend.

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct Span { pub start: usize, pub end: usize }

#[derive(Debug, Serialize, Deserialize)]
pub struct ParagraphNode {
    pub id: String,
    pub level: i8,                 // always 0; validated below
    pub parent: String,
    pub kind: String,
    pub span: Span,
    pub html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SectionNode {
    pub id: String,
    pub level: i8,                 // always -1
    pub parent: String,
    pub children: Vec<String>,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MetaNode {
    pub id: String,
    pub level: i8,                 // always -2
    pub children: Vec<String>,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Order {
    pub meta: Vec<String>,
    pub sections: Vec<String>,
    pub paragraphs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LookupTable {
    pub version: u8,
    pub doc_hash: String,
    pub meta: HashMap<String, MetaNode>,
    pub sections: HashMap<String, SectionNode>,
    pub paragraphs: HashMap<String, ParagraphNode>,
    pub order: Order,
}

impl LookupTable {
    /// Referential-integrity check. Reject the payload rather than let the
    /// UI hit a missing parent mid-transition.
    pub fn validate(&self) -> Result<(), String> {
        for (id, p) in &self.paragraphs {
            if p.level != 0 { return Err(format!("{id}: level must be 0")); }
            if !self.sections.contains_key(&p.parent) {
                return Err(format!("{id}: dangling parent {}", p.parent));
            }
        }
        for (id, s) in &self.sections {
            if s.level != -1 { return Err(format!("{id}: level must be -1")); }
            if !self.meta.contains_key(&s.parent) {
                return Err(format!("{id}: dangling parent {}", s.parent));
            }
            for c in &s.children {
                if !self.paragraphs.contains_key(c) {
                    return Err(format!("{id}: missing child {c}"));
                }
            }
        }
        Ok(())
    }

    /// D6 enforcement: recompute each paragraph's content hash from its
    /// span slice of the pre-payload source and require the ID to embed
    /// it. Rejects payloads whose IDs weren't derived per contract —
    /// without this, content addressing is a convention, not a guarantee.
    /// (Cargo: add `sha2` and `hex`.)
    pub fn verify_ids(&self, source: &str) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        let bytes = source.as_bytes();
        for (id, p) in &self.paragraphs {
            let slice = bytes
                .get(p.span.start..p.span.end)
                .ok_or_else(|| format!("{id}: span out of bounds"))?;
            let h = &hex::encode(Sha256::digest(slice))[..8];
            if !id.starts_with(&format!("P-{h}-")) {
                return Err(format!("{id}: content hash mismatch (expected P-{h}-*)"));
            }
        }
        Ok(())
    }
}
```

### 2.4 Mapping matrix — JSON Schema (the on-disk / in-payload contract)

Store this at `docs/payload-format.md` and treat it as the versioned contract between agents and the app.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "semantic-zoom/lookup-table/v1",
  "type": "object",
  "required": ["version", "docHash", "meta", "sections", "paragraphs", "order"],
  "properties": {
    "version": { "const": 1 },
    "docHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "meta": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["id", "level", "children", "title", "body"],
        "properties": {
          "id": { "type": "string", "pattern": "^M\\d+$" },
          "level": { "const": -2 },
          "children": { "type": "array", "items": { "pattern": "^S-[a-f0-9]{8}-\\d+$" }, "minItems": 1 },
          "title": { "type": "string" },
          "body": { "type": "string" }
        }
      }
    },
    "sections": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["id", "level", "parent", "children", "title", "body"],
        "properties": {
          "id": { "type": "string", "pattern": "^S-[a-f0-9]{8}-\\d+$" },
          "level": { "const": -1 },
          "parent": { "type": "string", "pattern": "^M\\d+$" },
          "children": { "type": "array", "items": { "pattern": "^P-[a-f0-9]{8}-\\d+$" }, "minItems": 1 },
          "title": { "type": "string" },
          "body": { "type": "string" }
        }
      }
    },
    "paragraphs": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["id", "level", "parent", "kind", "span", "html"],
        "properties": {
          "id": { "type": "string", "pattern": "^P-[a-f0-9]{8}-\\d+$" },
          "level": { "const": 0 },
          "parent": { "type": "string", "pattern": "^S-[a-f0-9]{8}-\\d+$" },
          "kind": { "enum": ["prose", "code", "list", "table", "heading", "blockquote"] },
          "span": {
            "type": "object",
            "required": ["start", "end"],
            "properties": {
              "start": { "type": "integer", "minimum": 0 },
              "end": { "type": "integer", "minimum": 0 }
            }
          },
          "html": { "type": "string" },
          "lang": { "type": "string" }
        }
      }
    },
    "order": {
      "type": "object",
      "required": ["meta", "sections", "paragraphs"],
      "properties": {
        "meta": { "type": "array", "items": { "type": "string" } },
        "sections": { "type": "array", "items": { "type": "string" } },
        "paragraphs": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

### 2.5 Bidirectional navigation math (`src/engine/anchor.ts`)

**The invariant:** at any moment, exactly one node is the *anchor*. Zoom transitions never scroll to "where you were" in pixels — pixel positions are meaningless across levels. They scroll to *the semantic relative of the anchor at the target level*.

> **Amended 2026-07-18** (design: `docs/superpowers/specs/2026-07-18-top-edge-anchoring-design.md`): the anchor rule and the landing math both changed from centering to top-alignment, and the read-only caret no longer participates in anchor resolution. Rationale below supersedes the original centering design.

**Anchor resolution (source level → anchor node):**

The anchor is the **topmost actually-visible node**: the node whose box contains the viewport's top edge, or, if the top edge falls in a gap, the first node starting below it (single pass over currently mounted elements using cached `offsetTop`/`offsetHeight`; no `getBoundingClientRect` in a loop). Explicitly *not* "closest to the top edge" — a node whose bottom scrolled a few pixels above the edge is close but no longer being read.

Scroll position is the *only* anchor signal. The read-only caret (`data-caret` on the clicked `.pnode`) carries no visible CSS anywhere in the app — it is an invisible marker — so it must never steer navigation the user cannot see happening. It keeps its other jobs (click-to-spotlight via the focus mask, arrow-key traversal) unchanged.

**Cross-level mapping (anchor → target node):**

| From → To | Mapping |
|---|---|
| 0 → −1 | `target = parentOfParagraph.get(anchor)` — e.g. caret in P₃ → pan to S₂ |
| 0 → −2 | `parentOfSection.get(parentOfParagraph.get(anchor))` |
| −1 → 0 | `target = lastCaretIn[S_x] ?? sections[S_x].children[0]` — restore the caret's paragraph if we've been here before, else first child |
| −1 → −2 | `parentOfSection.get(anchor)` |
| −2 → −1 | `lastAnchorIn[M_y] ?? meta[M_y].children[0]` |
| −2 → 0 | resolve −2 → −1 first, then −1 → 0 (two table reads, still O(1)) |

`lastCaretIn` / `lastAnchorIn` are plain `Map<string,string>` kept in the store — this is what makes zooming out and back in feel like the app "remembered your place."

**Top-alignment math (target node → scrollTop):**

```ts
export const TOP_GAP = 24;

export function topAlignScrollTop(
  el: { offsetTop: number },
  viewport: { clientHeight: number; scrollHeight: number },
  gap: number = TOP_GAP,
): number {
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return Math.min(Math.max(el.offsetTop - gap, 0), max);
}
```

**Transition sequence (prevents the layout-jump the spec worries about):**

1. **Frame n:** append the target level's layer hidden (`visibility:hidden`, same container width) and return — no layout reads in this frame. Groups carry `content-visibility:auto` (§4.2), so WebKit lays out only near-viewport groups, not the whole tree.
2. **Frame n+1 (rAF):** read the mapped target node's `offsetTop` — one contained layout, not a read/write thrash loop — compute `topAlignScrollTop`, set `scrollTop` on the hidden layer.
3. Same frame: start the 200ms opacity crossfade (compositor-only, §4).
4. On `transitionend`: unmount the old layer, then briefly mark the landed node (`data-landed`) so the anchor is visibly acknowledged — a left accent bar fading over ~1s (opacity only, D1), self-clearing.

The one-frame delay (~16ms) is invisible inside the 200ms fade; a `switchMap`-aborted effect (§3.2) covers slider spam. Do **not** substitute measurement with estimated heights (character counts etc.): approximate positions break exact top-alignment, which is the entire point of the anchor engine (D8).

The user never sees an intermediate scroll position; the new level *arrives already top-aligned*, with the landed node just below the viewport's top edge.

### 2.6 Engine A — Native payload extraction (the ≤10ms happy path)

**Marker convention (D2):**

```markdown
<!-- semantic-zoom:payload:v1
{ ...LookupTable JSON... }
-->
```

Placed by the agent at the **end** of the .md file (invisible in GitHub/VS Code preview). Extraction is a byte scan, not a markdown parse:

```rust
// src-tauri/src/parser/payload.rs
const HEAD: &str = "<!-- semantic-zoom:payload:v1";
const TAIL: &str = "-->";

pub fn extract_payload(source: &str) -> Option<Result<LookupTable, String>> {
    let start = source.rfind(HEAD)?;               // rfind: payload lives at EOF
    let json_start = start + HEAD.len();
    let end = source[json_start..].rfind(TAIL)? + json_start; // last -->: hardens against unescaped occurrences
    let json = source[json_start..end].trim();
    Some(
        serde_json::from_str::<LookupTable>(json)
            .map_err(|e| e.to_string())
            .and_then(|t| t.validate().map(|_| t)),
    )
}
```

Budget check: `rfind` + `serde_json` on a 1 MB file with a ~200 KB payload parses in ~1–3 ms on Apple Silicon. The 10 ms budget is comfortable; add a `debug_assert!` timing log, not an optimization.

**Contract addenda (surfaced by fixture construction and review round 1) — these live in `docs/payload-format.md`:**

- **A1:** `docHash` covers all bytes *preceding* the payload marker. A payload cannot hash a file that contains itself; the hot-reload short-circuit must hash the same region.
- **A2:** all `span` offsets reference that same pre-payload byte region.
- **A3:** producers must escape any `-->` inside JSON strings as `--\u003e`; the extractor additionally matches the *last* `-->` as defense in depth.
- **A4:** IDs must follow the D6 derivation; `verify_ids()` rejects payloads that don't.

**Return contract of the `load_document` command:**

```rust
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoadResult {
    /// Engine A succeeded — render immediately.
    Native { table: LookupTable, raw: String },
    /// No payload found — frontend shows k=0 immediately and
    /// routes to Engine B (stub in Phase 1).
    Untagged { raw: String },
    /// Payload present but invalid — show k=0 + non-modal warning badge.
    Corrupt { raw: String, error: String },
}
```

### 2.7 Engine B — Fallback Synthesizer (Phase 1: interface only)

Phase 1 ships the *seam*, not the synthesis. The frontend must already handle the "levels −1/−2 unavailable" state gracefully (slider detents disabled with tooltip "Generating summary…" or "No summary available"), so that plugging in the real synthesizer later touches zero UI code.

```ts
// src/engine/engine-b.ts
export interface Synthesizer {
  /** Segments raw markdown (unified + remark-parse → AST → paragraph
      grouping) and generates S/M layers. Resolves with a full LookupTable. */
  synthesize(raw: string, signal: AbortSignal): Promise<LookupTable>;
}

/** Phase 1 stub: rejects immediately; UI stays at k=0. */
export const stubSynthesizer: Synthesizer = {
  synthesize: async () => { throw new Error('ENGINE_B_NOT_IMPLEMENTED'); },
};
```

Phase 2 notes (do not build yet): segmentation runs client-side with `unified().use(remarkParse)` + `unist-util-visit`, grouping top-level AST nodes under nearest heading; generation targets a local Ollama endpoint (`http://localhost:11434/api/generate`, model: quantized Gemma 3 4B or Qwen3 4B) with one prompt template per level; results must pass the same Rust-side `validate()` before activation.

**Parser configuration (used by Engine B segmentation and by any future re-chunking):**

```ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

const processor = unified().use(remarkParse);

export function segment(raw: string): { kind: string; start: number; end: number }[] {
  const tree = processor.parse(raw);
  const out: { kind: string; start: number; end: number }[] = [];
  visit(tree, (node: any) => {
    if (!node.position || node.type === 'root') return;
    if (['paragraph', 'code', 'list', 'table', 'heading', 'blockquote'].includes(node.type)) {
      out.push({ kind: node.type, start: node.position.start.offset, end: node.position.end.offset });
      return 'skip'; // don't descend into block children
    }
  });
  return out;
}
```
---

## 3. Reactive Subject State Management (System A/B glue)

### 3.1 The single-store rule

One `BehaviorSubject<AppState>` is the app. Nothing else holds state. Components subscribe to *selectors*, never to the raw store, and every selector pipes through `distinctUntilChanged` so a caret move never re-renders the slider.

```ts
// src/state/store.ts
import { BehaviorSubject, Subject, animationFrameScheduler } from 'rxjs';
import { map, distinctUntilChanged, observeOn, auditTime } from 'rxjs/operators';
import type { LookupTable, ZoomLevel, ResolvedIndex } from '../engine/schema';

export type DocStatus = 'empty' | 'ready' | 'untagged' | 'corrupt' | 'reloading';

export interface AppState {
  zoom: ZoomLevel;
  doc: LookupTable | null;
  index: ResolvedIndex | null;
  raw: string;
  status: DocStatus;
  caret: { paragraphId: string | null; offset: number };
  /** P-id whose sibling group is spotlit. Derived from caret, cached here
      so focus-mask doesn't recompute the group on every caret offset tick. */
  activeGroupHead: string | null;
  /** Per-container "remembered place" maps (§2.5). */
  lastCaretIn: Map<string, string>;   // S-id → P-id
  lastAnchorIn: Map<string, string>;  // M-id → S-id
}

export type Action =
  | { type: 'DOC_LOADED'; result: import('../engine/engine-a').LoadResultDTO }
  | { type: 'DOC_CHANGED_ON_DISK' }          // from watcher event
  | { type: 'ZOOM_SET'; level: ZoomLevel }
  | { type: 'CARET_PLACED'; paragraphId: string; offset: number };

const initial: AppState = {
  zoom: 0, doc: null, index: null, raw: '', status: 'empty',
  caret: { paragraphId: null, offset: 0 },
  activeGroupHead: null,
  lastCaretIn: new Map(), lastAnchorIn: new Map(),
};

const state$ = new BehaviorSubject<AppState>(initial);
export const actions$ = new Subject<Action>();

actions$.subscribe((a) => state$.next(reduce(state$.getValue(), a)));

export const select = <T>(fn: (s: AppState) => T) =>
  state$.pipe(map(fn), distinctUntilChanged());
```

### 3.2 The three streams that must not fight each other

| Stream | Source | Discipline |
|---|---|---|
| **Slider → zoom** | pointer events on slider detents | Emits `ZOOM_SET` only on detent snap, never per-pixel. The transition sequence (§2.5 step 1–4) runs as an async effect keyed by zoom; a new `ZOOM_SET` mid-flight aborts the previous via `switchMap`. |
| **Caret → focus mask** | click/keyboard in viewport | `CARET_PLACED` is `auditTime(16)`-throttled. `activeGroupHead` changes only when the caret crosses a sibling-group boundary — the reducer compares `siblingGroup.get(new)[0]` to the current head. Same group ⇒ no emission ⇒ zero DOM writes. |
| **Watcher → reload** | Tauri `doc://changed` event | Sets `status:'reloading'`, re-invokes `load_document`, and on success diffs `docHash`; identical hash ⇒ silently drop. State restore: if the old caret's `P`-id still exists in the new table, keep it; else fall back to its parent `S`'s first surviving child. |

**Scroll writes** are the one place layout is touched. All of them route through a single scheduler queue:

```ts
// src/ui/viewport.ts (excerpt)
import { observeOn } from 'rxjs/operators';
import { animationFrameScheduler } from 'rxjs';

scrollCommands$
  .pipe(observeOn(animationFrameScheduler))   // batch to rAF; never mid-layout
  .subscribe(({ el, top }) => { el.scrollTop = top; });
```

Reads (`offsetTop` etc.) happen *before* the effect enqueues a write. Read-then-write, never interleaved — this alone eliminates the "layout lag" class of bugs the spec calls out.

### 3.3 Tauri bridge

```ts
// src/main.ts (excerpt)
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { actions$ } from './state/store';

await listen('doc://changed', () => actions$.next({ type: 'DOC_CHANGED_ON_DISK' }));

export async function openFile(path: string) {
  const result = await invoke('load_document', { path });
  actions$.next({ type: 'DOC_LOADED', result });
  await invoke('watch_directory', { path }); // §5 — watches parent dir
}
```

**Subscription hygiene (non-negotiable):** every UI module exposes `mount(): () => void` and returns a teardown that unsubscribes everything it created. `main.ts` owns all lifecycles. No component calls `.subscribe` on `actions$` directly — components dispatch actions and subscribe to selectors, period.

---

## 4. UI & Focus Mask Stylesheet (System B)

### 4.1 DOM structure

The k = 0 renderer wraps each sibling group in one element. The group is the unit of dimming — never individual paragraphs.

```html
<main id="viewport" data-zoom="0">
  <!-- one .pgroup per SectionNode; data-sid links back to the lookup table -->
  <section class="pgroup" data-sid="S1">
    <div class="pnode" data-pid="P1" data-kind="prose">…</div>
    <div class="pnode" data-pid="P2" data-kind="code">…</div>
  </section>
  <section class="pgroup" data-sid="S2" data-dimmed>
    <div class="pnode" data-pid="P3" data-kind="prose">…</div>
  </section>
</main>
```

The focus-mask module does exactly one thing per activeGroupHead change: toggles `data-dimmed` on the groups that changed state (not on all groups — track the previous spotlit `sid` and touch at most two elements).

### 4.2 Stylesheet (`src/styles/focus-mask.css`)

```css
/* ---------- Focus masking: the spotlight ---------- */

.pgroup {
  opacity: 1;
  /* ONLY opacity transitions. It is compositor-driven in WebKit:
     no layout, no paint, runs off the main thread. */
  transition: opacity 200ms linear;
}

/* Promote to its own layer ONLY while a transition can occur.
   Applied via [data-transitioning] on #viewport during the 200ms window,
   removed on transitionend — permanent will-change wastes VRAM on long docs. */
#viewport[data-transitioning] .pgroup {
  will-change: opacity;
}

/* Layout containment (D8): permits WebKit to skip layout/paint of
   far-off-screen groups. This is what makes the two-frame zoom mount
   (§2.5) and keyed hot-reload (§5.3) cheap on 10k-paragraph documents. */
.pgroup {
  content-visibility: auto;
  contain-intrinsic-size: auto 480px;  /* placeholder; browser corrects after first render */
}

.pgroup[data-dimmed] {
  opacity: 0.35;
  /* Contrast/saturation is an INSTANT class swap, not a transition (D1).
     The 200ms opacity crossfade perceptually masks the step change.
     Transitioning filter would repaint every frame — visible jank on
     documents with many highlighted code blocks. */
  filter: contrast(0.8) saturate(0.55);
}

/* Cheaper alternative for syntax colors: token remap via custom properties.
   If profiling shows filter cost on very large docs, drop `filter` from
   .pgroup[data-dimmed] and rely on this block alone. */
.pgroup[data-dimmed] {
  --tok-keyword:  var(--dim-fg);
  --tok-string:   var(--dim-fg);
  --tok-function: var(--dim-fg);
  --tok-comment:  var(--dim-fg-faint);
  --tok-number:   var(--dim-fg);
}

/* ---------- Level crossfade (zoom transitions, §2.5) ---------- */

.level-layer {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  opacity: 1;
  transition: opacity 200ms linear;
}
.level-layer[data-entering] { opacity: 0; }   /* mounted hidden, then flipped */
.level-layer[data-leaving]  { opacity: 0; }

/* ---------- Tokens ---------- */
:root {
  --dim-fg: #8a8f98;
  --dim-fg-faint: #a6abb3;
  color-scheme: light dark;
}

@media (prefers-reduced-motion: reduce) {
  .pgroup, .level-layer { transition: none; }
}
```

### 4.3 Focus-mask module

```ts
// src/ui/focus-mask.ts
import { select } from '../state/store';

export function mountFocusMask(viewport: HTMLElement): () => void {
  let prevSid: string | null = null;

  const sub = select((s) => {
    if (!s.doc || !s.index || !s.activeGroupHead) return null;
    return s.index.parentOfParagraph.get(s.activeGroupHead) ?? null;
  }).subscribe((sid) => {
    if (sid === prevSid) return;
    viewport.setAttribute('data-transitioning', '');

    if (prevSid) {
      viewport.querySelector(`.pgroup[data-sid="${prevSid}"]`)
        ?.setAttribute('data-dimmed', '');
    }
    viewport.querySelector(`.pgroup[data-sid="${sid}"]`)
      ?.removeAttribute('data-dimmed');

    // Initial spotlight: dim everything except the active group, once.
    if (prevSid === null) {
      viewport.querySelectorAll(`.pgroup:not([data-sid="${sid}"])`)
        .forEach((g) => g.setAttribute('data-dimmed', ''));
    }
    prevSid = sid;

    viewport.addEventListener('transitionend',
      () => viewport.removeAttribute('data-transitioning'),
      { once: true });
  });

  return () => sub.unsubscribe();
}
```

**Acceptance test for this system:** open a 5,000-line agent log with ~40 code blocks, hold ⌥ and arrow the caret across group boundaries continuously for 10 s. Instruments → Core Animation must show no main-thread frame > 8 ms attributable to the mask, and no memory growth from layer promotion.
---

## 5. Rust File Watcher Module (System D)

### 5.1 Design notes before the code

- **Watch the parent directory, not the file** (D5). VS Code, Cursor, and most agents save atomically: write `file.md.tmp` → rename over `file.md`. A watch on the file path dies at the rename. A non-recursive watch on the parent dir survives it.
- **500 ms debounce** via `notify-debouncer-mini` collapses the tmp-write/rename/metadata burst — and multi-chunk agent appends — into one event.
- **Hash before you reload.** Editors touch mtimes without changing bytes. The command layer compares SHA-256 against the last loaded hash and drops no-ops, so the UI never flickers for nothing.
- **Never block the notify callback.** It runs on the watcher's own thread; do nothing there but filter and emit.

### 5.2 Implementation (`src-tauri/src/watcher/debounced.rs`)

```rust
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use notify_debouncer_mini::notify::RecommendedWatcher;
use tauri::{AppHandle, Emitter, Manager};

/// Held in Tauri managed state. Dropping the debouncer stops the watch,
/// so replacing the Option releases the previous directory automatically
/// when the user opens a file elsewhere.
pub struct WatcherState {
    pub debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// The single file we actually care about within the watched dir.
    pub target: Mutex<Option<PathBuf>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self { debouncer: Mutex::new(None), target: Mutex::new(None) }
    }
}

#[tauri::command]
pub fn watch_directory(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?
        .to_path_buf();

    let app_for_cb = app.clone();
    let target_for_cb = target.clone();

    // 500ms debounce window: rapid write bursts (atomic saves, partial
    // flushes, agent appends) collapse into a single DebounceEvent batch.
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                // Cheap filter ON the watcher thread; heavy work OFF it.
                let relevant = events.iter().any(|e| {
                    e.path == target_for_cb
                        || is_atomic_sibling(&e.path, &target_for_cb)
                });
                if relevant {
                    // Fire-and-forget notification; the frontend decides
                    // when/how to reload. No modal, no diff screen.
                    let _ = app_for_cb.emit("doc://changed", ());
                }
            }
            Err(e) => eprintln!("[watcher] error: {e:?}"),
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let state = app.state::<WatcherState>();
    *state.target.lock().unwrap() = Some(target);
    // Replacing the old debouncer drops it → previous watch is released.
    *state.debouncer.lock().unwrap() = Some(debouncer);
    Ok(())
}

/// Atomic saves surface as events on `file.md.tmp`, `.file.md.swp`, etc.
/// Treat any event whose file stem contains the target's file name as
/// belonging to the target.
fn is_atomic_sibling(event_path: &Path, target: &Path) -> bool {
    match (event_path.file_name(), target.file_name()) {
        (Some(ev), Some(t)) => ev.to_string_lossy().contains(&*t.to_string_lossy()),
        _ => false,
    }
}
```

Registration in `lib.rs`:

```rust
pub fn run() {
    tauri::Builder::default()
        .manage(crate::watcher::debounced::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::document::load_document,
            crate::watcher::debounced::watch_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 5.3 The silent hot-reload contract (frontend side)

On `doc://changed` the reducer/effect chain (§3.2, row 3) does, in order:

1. `invoke('load_document', { path })` — Rust re-reads and re-extracts.
2. Compare `docHash`; identical → drop silently. **No UI change at all.**
3. Different → swap `doc` + rebuilt `index` in a single `DOC_LOADED` action (one store emission ⇒ one render pass).
4. **Keyed reconciliation, not a rebuild (D7):** iterate the new `order.sections` against a `Map<sid, HTMLElement>` kept from the previous render. A group whose `S`-id *and* full child-ID list are unchanged keeps its DOM node untouched; only inserted/changed groups are built, only removed ones unmounted. Because IDs are content hashes (D6), "unchanged ID list" literally means "unchanged bytes" — an agent appending 50 paragraphs touches only the appended groups, and the full-document rebuild that would blow the 250ms budget never occurs.
5. Caret restoration, tiered:
   - **(a)** the exact old ID `P-<h>-<k>` exists in the new table → keep caret and spotlight (same bytes, same occurrence).
   - **(b)** hash `<h>` exists but its occurrence count changed (an identical block was inserted/removed among duplicates) → disambiguate by **context hash**: prefer the candidate whose prev/next sibling hashes match the old neighbors'; if still ambiguous, take the occurrence nearest the caret's old document-position ratio. (Identical block, identical context — the choices are semantically interchangeable.)
   - **(c)** hash gone (the paragraph was edited) → move caret to the parent `S`'s first surviving child; parent gone too → clear caret, preserve scroll by ratio (`scrollTop / scrollHeight`).
6. A 1.5 s non-modal "Updated" pill in the corner is the *only* permitted feedback. No modals, no diff view — per spec.

---

## 6. System E — Self-Contained HTML Export (design only; build in Phase 2)

Phase 1 must not implement this, but the Phase 1 architecture is shaped so Phase 2 is an afternoon, not a rewrite:

- The exporter is a pure function `(LookupTable, raw) → string`. Because *all* view logic reads only the lookup table (never the file system), the web export reuses `anchor.ts`, `focus-mask.ts`, and the CSS verbatim.
- Build step produces `export-template.html` with two placeholders: `/*__STYLES__*/` (minified CSS from `src/styles/`) and `window.__SZ_DATA__ = /*__DATA__*/` (the lookup table + raw text, JSON-embedded).
- A Vite library build target (`vite build --config vite.export.config.ts`) bundles a slimmed `main-export.ts` (no Tauri imports, no watcher, no Engine B) to a single IIFE inlined into the template.
- Zero network requests, zero external fonts (system font stack), works from `file://`.

**Phase-1 obligation only:** keep every module the exporter needs free of `@tauri-apps/*` imports. Enforce with an ESLint `no-restricted-imports` rule on `src/engine/**` and `src/ui/**`.

---

## 7. Phased 3-Week Developer Backlog

Sequencing rule: nothing in a later milestone starts until the previous milestone's acceptance criteria pass. Phase 1 = rendering the three levels, spatial anchoring, focus masking, file monitoring. Engines beyond the Engine B stub, export, and any settings UI are out of scope.

### Week 1 — Skeleton, contract, and the happy path

| # | Task | Done when |
|---|------|-----------|
| 1.1 | Scaffold Tauri v2 + vanilla-TS workspace, directory layout from §1, macOS overlay title bar | `npm run tauri dev` opens a styled empty window |
| 1.2 | Define `schema.ts`, Rust mirror structs, `validate()`, JSON Schema doc; commit `docs/payload-format.md` | Round-trip test: sample payload → Rust parse → `validate()` + `verify_ids()` → frontend `buildIndex()` passes |
| 1.3 | `load_document` command + Engine A extraction (§2.6) with `LoadResult` enum | Tagged file renders `Native`; untagged renders `Untagged`; broken JSON renders `Corrupt` — unit tests for all three |
| 1.4 | Hand-author one realistic fixture: a genuine AI implementation-plan .md (~300 lines, 10+ code blocks) with a hand-built payload | Fixture passes JSON Schema validation; lives in `fixtures/` |
| 1.5 | Static rendering of all three levels from the lookup table (no transitions yet); slider with three detents switching levels instantly | All three levels render correct content for the fixture; slider disabled states work for `Untagged` |

### Week 2 — Spatial anchoring, caret, spotlight

| # | Task | Done when |
|---|------|-----------|
| 2.1 | RxJS store, actions, selectors, subscription-hygiene pattern (§3) | Caret moves don't re-render slider (verify with a render counter in dev) |
| 2.2 | Read-only caret: click-to-place + arrow-key traversal across `.pnode`s | Caret id/offset visible in a dev HUD |
| 2.3 | Anchor engine (§2.5): resolution, cross-level mapping tables, `lastCaretIn`/`lastAnchorIn` memory | Unit tests for all 6 level-pair mappings incl. the two-hop −2 ↔ 0 |
| 2.4 | Two-layer zoom transition: off-screen mount → pre-scroll → 200ms crossfade → unmount | Reading in P₃ → slide to −1 → S₂ arrives top-aligned, zero visible scroll motion; reverse restores P₃ |
| 2.5 | Focus mask (§4): group DOM structure, `data-dimmed` toggling, token remap | Instruments acceptance test in §4.3 passes on the 5,000-line stress fixture |

### Week 3 — Watcher, hot reload, hardening

| # | Task | Done when |
|---|------|-----------|
| 3.1 | Watcher module (§5) wired to `doc://changed` | Editing the file in VS Code (atomic save) and via `echo >>` (append) both fire exactly one event per burst |
| 3.2 | Silent hot-reload state sync (§5.3): hash short-circuit, keyed group reuse, tiered caret restoration | Agent appends 50 paragraphs AND inserts 5 at the top mid-session: unchanged groups keep DOM node identity (assert in dev HUD), caret stays on the same *content*, no modal |
| 3.3 | Engine B stub + degraded-state UX: disabled detents, "no summary" affordance, `Corrupt` warning badge | Loading any random README from disk is a calm, non-broken experience |
| 3.4 | Perf pass: 1 MB / 10k-paragraph synthetic doc — startup, zoom transition, mask latency budgets (≤10 ms extract, ≤16 ms mask frame, ≤250 ms level swap end-to-end) | Numbers recorded in `docs/perf-baseline.md` |
| 3.5 | Packaging: `tauri build` → signed `.dmg` (ad-hoc signing acceptable for Phase 1), smoke test on a clean machine | Fresh install opens the fixture correctly |
| 3.6 | Buffer / bug-fix. Explicitly scheduled — Week 3 always overruns otherwise | Issue tracker at zero P0/P1 |

### Explicit non-goals for Phase 1 (defer without guilt)

Engine B synthesis, Ollama integration, prompt templates; HTML export (System E) beyond the import-hygiene lint rule; multi-document tabs; editing of any kind (the caret is read-only by design); Windows/Linux targets; theming/settings UI.

---

## 8. Engine B — Remote LLM Synthesis (Phase 2/3 addendum, D9)

**Status: architecture only, not started.** This section does not begin until the Phase 1 backlog (§7) is complete — Engine B ships as the stub in §2.7 until then. It documents the design for generating the missing k=−1/−2 levels via a remote LLM API (model TBD, e.g. a MiMo-v2.5-Pro-class endpoint — kept swappable, since D3 already shows model recommendations here have superseded each other once) plus the API-key settings dialog, and formalizes the deviation from D3/§2.7's local-Ollama-only design as **D9** (§0).

### 8.1 Why this doesn't slot into the existing three crossings

§1's rule — *"Rust owns disk truth, TypeScript owns view truth, exactly three crossings"* — held because Phase 1 has no secrets and no network egress. Remote synthesis introduces both. Two new Tauri commands are unavoidable, but everything that depends on Tauri for this feature is isolated into a **new top-level directory, `src/native/`**, which sits outside the `no-restricted-imports` glob (`src/engine/**`, `src/ui/**`). This means:

- The existing lint rule is **not modified or excepted** — it still means what it always meant.
- System E's static export (§6), which reuses `src/engine/**` + `src/ui/**` verbatim, is **structurally incapable** of pulling in the API-key or network code, because that code was never placed under those directories in the first place. No exception list to keep in sync, no risk of a future refactor accidentally dragging a secret into an exported HTML file.

```
src/
  engine/
    engine-b.ts            # UNCHANGED: Synthesizer interface + stubSynthesizer (§2.7)
  native/                  # NEW — Tauri-dependent, excluded from System E export
    engine-b-remote.ts      # real Synthesizer impl; invoke('synthesize_levels', ...)
    settings-window.ts      # opens/bootstraps the Settings window
    settings-form.ts        # form logic — never retains the raw key past Save
src-tauri/src/commands/
  secrets.rs                # NEW: save_api_key / get_api_key_status / delete_api_key
  synthesize.rs             # NEW: synthesize_levels — HTTP call + validate() + verify_ids() + write-back
```

`main.ts` (which already legitimately imports `@tauri-apps/*`) is the only place that chooses between `stubSynthesizer` and the real `src/native/engine-b-remote.ts` implementation — `engine-b.ts`'s interface contract doesn't change at all.

### 8.2 API key: Rust-owned secret, never in the webview

The key must never exist in JS state longer than the instant it's typed, or it inherits every risk of the untrusted webview context (inspectable, and structurally reusable by the System E exporter if the code ever moved).

```rust
// src-tauri/src/commands/secrets.rs
use keyring::Entry;

const SERVICE: &str = "com.semantic-zoom.llm-api-key";

#[tauri::command]
pub fn save_api_key(key: String) -> Result<(), String> {
    Entry::new(SERVICE, "default").and_then(|e| e.set_password(&key)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_api_key_status() -> bool {
    Entry::new(SERVICE, "default").and_then(|e| e.get_password()).is_ok()
}

#[tauri::command]
pub fn delete_api_key() -> Result<(), String> {
    Entry::new(SERVICE, "default").and_then(|e| e.delete_credential()).map_err(|e| e.to_string())
}
```

`get_api_key_status` returns a bool, never the key. `Cargo.toml`: `cargo add keyring`. Uses macOS Keychain Services under the hood — consistent with §1's macOS-only Phase 1 target, no cross-platform abstraction needed.

`src/native/settings-form.ts` (sketch): a text input, a Save button that calls `invoke('save_api_key', { key: input.value })` then immediately clears `input.value` and never assigns it to any variable that outlives the handler; a status line driven by `invoke('get_api_key_status')` on mount (`"API key saved ✓"` / `"No key set"`); a Remove button calling `delete_api_key`.

### 8.3 Settings window

A second native Tauri window (per the clarifying answer — not an in-app modal), opened from a menu item (`Semantic Zoom → Settings…`, ⌘,):

```rust
// src-tauri/src/commands/window.rs (or inline in a menu event handler)
#[tauri::command]
pub fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("settings").is_some() { return Ok(()); } // focus, don't duplicate
    tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(420.0, 220.0)
        .resizable(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
```

`settings.html` is a second Vite entry point bundling only `src/native/settings-form.ts` — it never loads the document viewport, store, or engine modules, so it has nothing to leak even by accident.

### 8.4 Generation command and disk write-back

```rust
// src-tauri/src/commands/synthesize.rs
#[tauri::command]
pub async fn synthesize_levels(path: String, raw: String, doc_hash: String) -> Result<LookupTable, String> {
    let key = Entry::new(SERVICE, "default")
        .and_then(|e| e.get_password())
        .map_err(|_| "No API key configured".to_string())?;

    let table = call_remote_llm(&key, &raw).await?;   // builds S/M layers only; P-nodes untouched
    table.validate()?;
    table.verify_ids(&raw)?;                          // same gate Engine A payloads pass through

    // Write-back is only safe if the file is unchanged since we read it —
    // otherwise we'd silently clobber an edit made while the request was in flight.
    let current = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if sha256_hex(&current) == doc_hash {
        std::fs::write(&path, append_payload_marker(&current, &table)).map_err(|e| e.to_string())?;
    }
    // Hash still matches → docHash covers only bytes preceding the marker (A1), so this
    // append doesn't change it. The watcher's own debounced `doc://changed` fires next,
    // load_document re-extracts as `Native`, and the existing hash short-circuit (§5.3
    // step 2) means the reload is a no-op from the user's point of view — no flicker.
    Ok(table)
}
```

If the hash doesn't match (user edited the file mid-request), the result is returned to the frontend for the current session only and *not* written to disk — silently overwriting a concurrent edit would violate the "fixtures/user files are never mutated behind their back" spirit even though this isn't a fixture.

### 8.5 Frontend flow and visible trust boundary

- `DocStatus` (§3.1) gains `'synthesizing'`. Slider's −1/−2 detents, when the doc is `Untagged` and `get_api_key_status()` is true, show a "Generate" affordance instead of being permanently disabled (§2.7's stub UX still applies verbatim when no key is set).
- Clicking it calls `invoke('synthesize_levels', ...)`; success merges the returned `meta`/`sections` into the existing table via the same `DOC_LOADED`-shaped action (paragraphs/spans are never touched by Engine B — k=0 truth stays Engine A's alone). Failure surfaces as the same calm, non-modal toast pattern as the existing `Corrupt` badge (§5.3 step 6) — no popups, no diff view, per the spec's UX tone.
- **Visible consent, not a buried network call:** the Generate affordance's tooltip states plainly that generating sends the document's text to the configured API. This is the one place Phase 1's "100% local, zero network egress" property changes, and it must be legible to the user at the point of action, not just in a settings screen they may never open.
- Mid-flight cancellation reuses the existing `switchMap`-abort pattern (§3.2 row 1): a hot reload or a new generation request aborts the in-flight one.

### 8.6 Product calls — locked by D10 (2026-07-15)

These were open questions at the time this section was first drafted; D10 (§0) resolves all three, so the build plan at `.claude/plans/tingly-munching-papert.md` proceeds without re-litigating them:

- **Token/cost ceiling:** v1 refuses documents over the model's context limit with a clear message. No silent truncation or chunking.
- **Regenerate affordance:** allowed only for `Untagged` documents. Re-running Engine B to overwrite an existing `Native` payload's −1/−2 layers is explicitly out of scope for v1.
- **Provider abstraction:** built as a small config record (`kind`, `base_url`, `model`, `needs_key`) against one OpenAI-compatible HTTP client, exactly the recommended option — covers Remote, Ollama, and llama.cpp without a code change per provider.

---

*End of Phase 1 plan. The contract files (`schema.ts`, Rust mirrors, `docs/payload-format.md`) are the spine — get 1.2 reviewed before anything downstream is written. §8 is a Phase 2/3 addendum and does not gate any Phase 1 task.*

<!-- semantic-zoom:payload:v1
{"version":1,"docHash":"58f56264b24a0c4a0a210cd3d01a00f695f5803b8d2c77ee161ad72a5f170e3a","meta":{"M1":{"id":"M1","level":-2,"title":"Laying the groundwork","body":"The plan opens with its non-negotiable trade-offs, then scaffolds the project and pins down the data contract every later module depends on. Everything here is \"decide once, build on top\" — the directory layout, the content-addressed ID scheme, and the JSON Schema that agents and the Rust validator both enforce.","children":["S-ab80d77b-0","S-02a9a62b-0","S-10c7677d-0","S-247821b0-0","S-d31de407-0"]},"M2":{"id":"M2","level":-2,"title":"Reading, reacting, and rendering","body":"With the data contract settled, the plan builds the runtime: a single RxJS store that every component subscribes to via selectors, three event streams (slider, caret, watcher) that must not fight each other, and the focus-mask spotlight that dims everything except the active sibling group. The Rust watcher and hot-reload contract close the loop — edits on disk reach the UI without flicker or modals.","children":["S-ee486a4c-0","S-a58b0af4-0","S-107a589f-0","S-728d4905-0","S-3008a382-0","S-1b3f5ebf-0","S-49b7e81c-0","S-300b2309-0"]},"M3":{"id":"M3","level":-2,"title":"Shipping and what comes after","body":"Phase 1 ends with a concrete three-week backlog, explicit non-goals, and an architecture-only addendum for remote LLM synthesis. The export design and Engine B's API-key isolation are shaped now so they become afternoon tasks later, not rewrites.","children":["S-1c2f51c0-0","S-d35e24c6-0","S-22785af6-0"]}},"sections":{"S-ab80d77b-0":{"id":"S-ab80d77b-0","level":-1,"parent":"M1","children":["P-ab80d77b-0","P-9968bd92-0","P-8ae20742-0"],"title":"What this plan is for","body":"A native macOS app that renders markdown at three semantic zoom levels — this is the target, and the audience is a single developer who needs every decision spelled out."},"S-02a9a62b-0":{"id":"S-02a9a62b-0","level":-1,"parent":"M1","children":["P-02a9a62b-0","P-37dbe0aa-0"],"title":"The nine deviations that shape everything","body":"Nine deliberate departures from the original spec, each with its own reasoning: how zoom transitions animate, how the payload is marked, where AI synthesis fits, how state is managed, what gets watched for changes, how content gets its permanent identity, how hot reload avoids full rebuilds, how the two-frame mount avoids layout stalls, and — newest — how remote/local synthesis is architected as one swappable provider instead of a single hard-coded endpoint."},"S-10c7677d-0":{"id":"S-10c7677d-0","level":-1,"parent":"M1","children":["P-10c7677d-0","P-1884396f-0","P-7f848a7c-0","P-426c826a-0","P-214c21cd-0","P-ab96a5d5-0","P-efe43533-0"],"title":"Project structure and the Rust/TypeScript boundary","body":"The file tree, bootstrap commands, and one hard rule: Rust owns disk truth, TypeScript owns view truth, and exactly three Tauri commands cross between them."},"S-247821b0-0":{"id":"S-247821b0-0","level":-1,"parent":"M1","children":["P-247821b0-0","P-6544cffb-0","P-b6964e17-0","P-e9ef5093-0","P-0ca10484-0","P-dce65e70-0","P-4f526662-0","P-7399460d-0","P-51791ee0-0","P-48146d99-0","P-a11c9145-0","P-06f1b7f0-0","P-25303dcb-0","P-12c11aa4-0","P-d5b53fc4-0"],"title":"The data contract — types, mirrors, and the JSON Schema","body":"TypeScript interfaces, Rust mirror structs, and the on-disk JSON Schema all describe the same three-level tree. Content-addressed IDs make \"same ID\" mean \"same bytes\", which is the guarantee hot-reload and caret restoration both depend on."},"S-d31de407-0":{"id":"S-d31de407-0","level":-1,"parent":"M1","children":["P-d31de407-0","P-00d5fbab-0","P-008ca03f-0","P-ca109407-0","P-70dd8e4a-0","P-502f0f91-0","P-77118bee-0","P-660d40ea-0","P-5b6c485e-0","P-91fae7d2-0","P-d4f59cdc-0","P-576ba68c-0","P-c9814357-0","P-8843e0bc-0","P-b54687e6-0"],"title":"How the view knows where to land","body":"Zoom transitions don't scroll to pixel positions — they scroll to the semantic relative of the current anchor at the target level. A two-frame mount-and-measure sequence keeps the new level invisible until it's centered, then crossfades in."},"S-ee486a4c-0":{"id":"S-ee486a4c-0","level":-1,"parent":"M2","children":["P-ee486a4c-0","P-33c457d3-0","P-b2935767-0","P-77c00e38-0","P-93aa020a-0","P-e2c39228-0","P-94fdc8ab-0","P-81549238-0","P-1c46255b-0","P-4dbc906d-0","P-85ec2bf4-0","P-578ab58e-0","P-dc27c7b0-0","P-0985edd1-0","P-5c319197-0","P-fdc99993-0"],"title":"Extracting payloads and the synthesis seam","body":"Engine A scans for the marker comment and parses the JSON in under 10ms. Engine B is just an interface in Phase 1 — the stub rejects immediately so the UI can show \"no summary\" gracefully, but the seam is ready for a real synthesizer later."},"S-a58b0af4-0":{"id":"S-a58b0af4-0","level":-1,"parent":"M2","children":["P-a58b0af4-0","P-e37870b4-0","P-d441390a-0","P-e87fc865-0"],"title":"One store, no shortcuts","body":"A single BehaviorSubject holds the entire app state. Components subscribe to memoized selectors, never the raw store — this is what prevents a caret move from re-rendering the slider."},"S-107a589f-0":{"id":"S-107a589f-0","level":-1,"parent":"M2","children":["P-107a589f-0","P-b0470403-0","P-55039efb-0","P-48949622-0","P-7d11bea5-0"],"title":"Three streams that must not fight each other","body":"Slider zoom, caret focus-mask updates, and watcher reloads each have their own discipline. All scroll writes route through a single rAF-scheduled queue — reads before writes, never interleaved."},"S-728d4905-0":{"id":"S-728d4905-0","level":-1,"parent":"M2","children":["P-728d4905-0","P-e8361244-0","P-09995cd8-0"],"title":"Wiring the native bridge","body":"Three lines of glue connect the Rust watcher to the TypeScript store. The non-negotiable rule: every UI module returns a teardown function, and main.ts owns all lifecycles."},"S-3008a382-0":{"id":"S-3008a382-0","level":-1,"parent":"M2","children":["P-3008a382-0","P-dfb24bce-0","P-e109335c-0","P-4e9d6a14-0","P-33ae0b38-0"],"title":"The spotlight's DOM structure","body":"Each section's paragraphs get wrapped in one .pgroup element — that wrapper is the unit of dimming. The focus-mask module toggles data-dimmed on at most two elements per caret move."},"S-1b3f5ebf-0":{"id":"S-1b3f5ebf-0","level":-1,"parent":"M2","children":["P-1b3f5ebf-0","P-db75d70f-0","P-1ca32305-0","P-42dcfa1c-0","P-2f654324-0"],"title":"Making the spotlight look right","body":"Opacity is the only transitioning property — filter and saturation change instantly behind the crossfade. content-visibility:auto lets WebKit skip layout for off-screen groups, keeping large documents fast."},"S-49b7e81c-0":{"id":"S-49b7e81c-0","level":-1,"parent":"M2","children":["P-49b7e81c-0","P-0d78d56e-0","P-8a9c5517-0","P-5ca35b4b-0","P-a9a0d31a-0","P-09db431d-0","P-73805a32-0"],"title":"Watching the file without blocking the UI","body":"The Rust watcher monitors the parent directory (not the file) with a 500ms debounce, filtering on the watcher thread before emitting. SHA-256 comparison drops no-ops so the UI never flickers for nothing."},"S-300b2309-0":{"id":"S-300b2309-0","level":-1,"parent":"M2","children":["P-300b2309-0","P-8ec877b8-0","P-e354f354-0"],"title":"The silent hot-reload contract","body":"Six steps from file change to screen update: re-read, hash-check, swap state, keyed reconciliation, tiered caret restoration, and a 1.5s toast. Unchanged groups keep their DOM nodes; the caret follows content, not position."},"S-1c2f51c0-0":{"id":"S-1c2f51c0-0","level":-1,"parent":"M3","children":["P-1c2f51c0-0","P-fef728d7-0","P-64fbfe58-0","P-9a0c5f90-0"],"title":"Self-contained HTML export — shaped now, built later","body":"A pure function from lookup table to single HTML file, reusing the same CSS and view logic. The only Phase 1 obligation is an ESLint rule keeping Tauri imports out of engine and UI directories."},"S-d35e24c6-0":{"id":"S-d35e24c6-0","level":-1,"parent":"M3","children":["P-d35e24c6-0","P-3cca7974-0","P-c7a54935-0","P-bfc3553c-0","P-9348b695-0","P-114fe72e-0","P-fba350b0-0","P-c328902b-0","P-e572cd25-0","P-8410502b-0"],"title":"The three-week plan and what's deliberately left out","body":"Week-by-week milestones with hard sequencing rules and explicit non-goals. Nothing in a later week starts until the previous one's acceptance criteria pass."},"S-22785af6-0":{"id":"S-22785af6-0","level":-1,"parent":"M3","children":["P-22785af6-0","P-f146a17d-0","P-f1c59594-0","P-de1a9533-0","P-afd46b82-0","P-9a0daf15-0","P-a4cc4027-0","P-74cbda9d-0","P-69a485a5-0","P-2d662b23-0","P-b0067727-0","P-3da22a9b-0","P-fd1140ed-0","P-b6f6515d-0","P-b10bbbf6-0","P-08cc871f-0","P-20f79806-0","P-211a1bf0-0","P-1a010a77-0","P-ab2f8705-0","P-571e5b5b-0","P-17199162-0","P-3a4e7368-0","P-afa7b29a-0","P-bc6ea6a1-0"],"title":"Remote LLM synthesis — the Phase 2/3 addendum","body":"Architecture for generating the missing summary levels via a remote API. The API key lives in Rust (macOS Keychain), the settings window is a separate Tauri webview, and the generation command validates before writing back to disk."}},"paragraphs":{"P-ab80d77b-0":{"id":"P-ab80d77b-0","level":0,"parent":"S-ab80d77b-0","kind":"heading","span":{"start":0,"end":47},"html":"<h1>Semantic Zoom — Phase 1 Implementation Plan</h1>"},"P-9968bd92-0":{"id":"P-9968bd92-0","level":0,"parent":"S-ab80d77b-0","kind":"prose","span":{"start":49,"end":252},"html":"<p><strong>Target:</strong> Native macOS desktop app (Tauri v2) that renders AI-generated markdown at three discrete semantic zoom levels (k = −2, −1, 0) with spatial anchoring, focus masking, and silent hot-reload.</p>"},"P-8ae20742-0":{"id":"P-8ae20742-0","level":0,"parent":"S-ab80d77b-0","kind":"prose","span":{"start":254,"end":432},"html":"<p><strong>Audience of this document:</strong> A single developer of average experience. Every section is copy-paste-ready or annotated to the point where no architectural decisions remain open.</p>"},"P-02a9a62b-0":{"id":"P-02a9a62b-0","level":0,"parent":"S-02a9a62b-0","kind":"heading","span":{"start":439,"end":494},"html":"<h2>0. Architectural Decisions &amp; Deviations (read first)</h2>"},"P-37dbe0aa-0":{"id":"P-37dbe0aa-0","level":0,"parent":"S-02a9a62b-0","kind":"prose","span":{"start":496,"end":5755},"html":"<table>\n<thead>\n<tr>\n<th>#</th>\n<th>Spec said</th>\n<th>Plan does</th>\n<th>Why</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>D1</td>\n<td>Transition opacity <strong>and</strong> contrast over 200ms</td>\n<td>Transition <strong>opacity only</strong>; contrast/saturation applied as an instant class swap hidden inside the opacity crossfade</td>\n<td><code>filter</code> is not GPU-composited in WebKit. Transitioning it repaints every dimmed code block per frame → dropped frames on large docs. Opacity is composited and free.</td>\n</tr>\n<tr>\n<td>D2</td>\n<td>Payload &quot;wrapped in custom comment tags (and)&quot;</td>\n<td>Concrete markers: <code>&lt;!-- semantic-zoom:payload:v1</code> … <code>--&gt;</code></td>\n<td>The tag names were missing from the spec. This convention is HTML-comment-safe (invisible in any markdown renderer) and versioned.</td>\n</tr>\n<tr>\n<td>D3</td>\n<td>Engine B uses &quot;Gemma 2&quot;</td>\n<td>Engine B is an <strong>interface + stub</strong> in Phase 1; model recommendation updated to Gemma 3 4B / Qwen3 4B (quantized, via Ollama)</td>\n<td>Phase 1 scope explicitly excludes synthesis. Gemma 2 is superseded.</td>\n</tr>\n<tr>\n<td>D4</td>\n<td>RxJS Subject for state</td>\n<td>Kept, with strict rules (single store, <code>distinctUntilChanged</code> selectors, no ad-hoc subscriptions in components)</td>\n<td>RxJS is heavier than needed for an app this size, but it is what the spec mandates and it handles the caret/scroll/slider stream coordination well. Rules below prevent the classic leak/re-render failure modes.</td>\n</tr>\n<tr>\n<td>D5</td>\n<td>Watch &quot;the project directory&quot;</td>\n<td>Watch the <strong>parent directory</strong> of the open file, filter events to <code>*.md</code></td>\n<td>VS Code/Cursor atomic saves are write-to-temp + rename. Watching a single file path breaks on rename; watching the parent dir is the only reliable pattern.</td>\n</tr>\n<tr>\n<td>D6</td>\n<td>IDs &quot;assigned in document order&quot; (<code>P14</code>)</td>\n<td><strong>Content-addressed IDs</strong>: <code>P-&lt;hash8&gt;-&lt;n&gt;</code>, <code>S-&lt;hash8&gt;-&lt;n&gt;</code>; meta stays positional (<code>M1</code>)</td>\n<td>Review finding: sequential IDs shift on mid-document insertion, silently re-anchoring the caret to <em>different content with the same name</em> after hot reload. Hash+ordinal survives insertions; the Rust validator recomputes hashes so agent payloads cannot lie.</td>\n</tr>\n<tr>\n<td>D7</td>\n<td>Hot reload = &quot;swap the doc… one render pass&quot;</td>\n<td>Keyed per-group DOM reconciliation</td>\n<td>A full rebuild of a 5k-line doc blocks the main thread past the 250ms budget. With D6, &quot;ID unchanged&quot; means &quot;bytes unchanged&quot; — unchanged groups keep their DOM nodes by identity.</td>\n</tr>\n<tr>\n<td>D8</td>\n<td>Mount hidden layer, read <code>offsetTop</code> synchronously</td>\n<td>Two-frame mount (append in frame n, measure+scroll+fade in frame n+1) + <code>content-visibility:auto</code> on groups</td>\n<td>One synchronous forced layout of a 10k-paragraph tree can exceed the frame budget alone. Reviewer&#39;s alternative (heights estimated from char counts) rejected: approximate positions break exact positioning, defeating the anchor engine.</td>\n</tr>\n<tr>\n<td>D9</td>\n<td>(n/a — new request) Engine B was scoped to a <strong>local</strong> Ollama endpoint only (D3); this was changed to remote-LLM-API synthesis (§8)</td>\n<td>Remote synthesis gets <strong>two new Tauri crossings</strong> (<code>save_api_key</code>, <code>synthesize_levels</code>) beyond the three the plan fixed in §1, plus a <strong>new Rust-owned secret</strong> (API key in OS Keychain) and a <strong>new Rust disk write</strong> (payload write-back). All three are confined to a new <code>src/native/**</code> directory, kept outside <code>src/engine/**</code>/<code>src/ui/**</code> so the <code>no-restricted-imports</code> rule and the System E export stay untouched.</td>\n<td>Sending document content to a third-party API is a real trust-boundary change from the all-local Phase 1 design — it must be visible to the user (§8.5), not silent. The key must never enter the webview/JS heap past the moment it&#39;s saved, or it risks shipping inside the System E static export, which reuses <code>src/engine/**</code>/<code>src/ui/**</code> verbatim.</td>\n</tr>\n<tr>\n<td>D10</td>\n<td>§8.4 sketched Engine B as one <code>synthesize_levels</code> command against a single remote endpoint; D3&#39;s local-Ollama-only spirit was left behind</td>\n<td>Engine B synthesis goes through <strong>one provider abstraction</strong>: a single OpenAI-compatible chat client keyed by a config record (<code>kind: remote | ollama | custom-local</code>, <code>base_url</code>, <code>model</code>, <code>needs_key</code>) — Remote (MiMo-class), Ollama, and llama.cpp all speak the same chat-completions HTTP shape, so this is one client plus config, not three implementations. §8.4&#39;s single command sketch is split into two crossings: <code>llm_complete</code> (Rust: Keychain fetch + HTTP call — the key never enters JS) and <code>write_payload</code> (Rust: <code>validate()</code> + <code>verify_ids()</code> + hash-guarded atomic write). Segmentation/assembly reuses the proven remark-based JS from <code>tools/semantic-zoom-tools</code> (extracted into <code>src/native/**</code>), not a Rust port — the skill&#39;s own history records a silent byte-offset corruption bug in exactly that class of port. §8.6&#39;s open product calls are locked: v1 refuses documents over the model context limit with a clear message (no silent truncation); regenerate is allowed for <code>Untagged</code> docs only, never overwriting an existing <code>Native</code> payload&#39;s −1/−2. Ratified 2026-07-15, task-by-task build plan at <code>.claude/plans/tingly-munching-papert.md</code>.</td>\n<td>Local providers reinstate D3&#39;s local-first option instead of committing the app to a remote-only trust boundary; splitting the network call from the disk write keeps the write-back gate (validate/verify_ids) as the single choke point regardless of which provider produced the layers. A Rust segmentation port would duplicate logic that has already broken once in a JS-only mirror, doubling that risk instead of removing it.</td>\n</tr>\n</tbody></table>"},"P-10c7677d-0":{"id":"P-10c7677d-0","level":0,"parent":"S-10c7677d-0","kind":"heading","span":{"start":5762,"end":5801},"html":"<h2>1. Directory Structure &amp; Boilerplate</h2>"},"P-1884396f-0":{"id":"P-1884396f-0","level":0,"parent":"S-10c7677d-0","kind":"code","span":{"start":5803,"end":8141},"html":"<pre><code>semantic-zoom/\n├── package.json\n├── tsconfig.json\n├── vite.config.ts\n├── index.html\n├── src/                          # Frontend workspace (TypeScript)\n│   ├── main.ts                   # Entry: wires store ⇄ Tauri events ⇄ UI\n│   ├── state/\n│   │   ├── store.ts              # Single BehaviorSubject&lt;AppState&gt; + action bus\n│   │   ├── actions.ts            # Typed action creators\n│   │   └── selectors.ts          # Memoized distinctUntilChanged selectors\n│   ├── engine/\n│   │   ├── schema.ts             # LookupTable types (§2)\n│   │   ├── anchor.ts             # Bidirectional navigation math (§2.4)\n│   │   ├── engine-a.ts           # Payload extraction (frontend side, thin)\n│   │   └── engine-b.ts           # Phase-1 STUB: interface + &quot;synthesis pending&quot; state\n│   ├── ui/\n│   │   ├── viewport.ts           # Renders active level, owns scroll writes\n│   │   ├── slider.ts             # Physical slider component (3 detents)\n│   │   ├── focus-mask.ts         # Applies/removes [data-dimmed] on sibling groups\n│   │   └── caret.ts              # Read-only caret placement + tracking\n│   └── styles/\n│       ├── base.css\n│       ├── slider.css\n│       └── focus-mask.css        # §4\n├── src-tauri/                    # Rust backend workspace\n│   ├── Cargo.toml\n│   ├── tauri.conf.json\n│   ├── capabilities/default.json\n│   └── src/\n│       ├── main.rs               # Thin: calls lib\n│       ├── lib.rs                # Builder, plugin registration, state\n│       ├── state.rs              # AppState (watched path, doc hash)\n│       ├── commands/\n│       │   ├── mod.rs\n│       │   └── document.rs       # load_document, extract_payload\n│       ├── parser/\n│       │   ├── mod.rs\n│       │   └── payload.rs        # Engine A: marker scan + serde_json (§2.5)\n│       └── watcher/\n│           ├── mod.rs\n│           └── debounced.rs      # §5 — notify-debouncer-mini\n└── docs/\n    └── payload-format.md         # The agents.md protocol contract, versioned\n</code></pre>"},"P-7f848a7c-0":{"id":"P-7f848a7c-0","level":0,"parent":"S-10c7677d-0","kind":"prose","span":{"start":8143,"end":8166},"html":"<p><strong>Bootstrap commands:</strong></p>"},"P-426c826a-0":{"id":"P-426c826a-0","level":0,"parent":"S-10c7677d-0","kind":"code","span":{"start":8168,"end":8472},"html":"<pre><code class=\"language-bash\">npm create tauri-app@latest semantic-zoom -- --template vanilla-ts\ncd semantic-zoom\nnpm i rxjs unified remark-parse unist-util-visit\ncd src-tauri\ncargo add notify notify-debouncer-mini serde serde_json sha2 hex --features serde/derive\ncargo add tauri-plugin-dialog   # native file-open dialog\n</code></pre>","lang":"bash"},"P-214c21cd-0":{"id":"P-214c21cd-0","level":0,"parent":"S-10c7677d-0","kind":"prose","span":{"start":8474,"end":8527},"html":"<p><strong><code>tauri.conf.json</code> essentials (macOS-native feel):</strong></p>"},"P-ab96a5d5-0":{"id":"P-ab96a5d5-0","level":0,"parent":"S-10c7677d-0","kind":"code","span":{"start":8529,"end":8858},"html":"<pre><code class=\"language-jsonc\">{\n  &quot;app&quot;: {\n    &quot;windows&quot;: [{\n      &quot;title&quot;: &quot;Semantic Zoom&quot;,\n      &quot;width&quot;: 980, &quot;height&quot;: 760,\n      &quot;titleBarStyle&quot;: &quot;Overlay&quot;,       // traffic lights over content\n      &quot;hiddenTitle&quot;: true,\n      &quot;transparent&quot;: false\n    }]\n  },\n  &quot;bundle&quot;: { &quot;targets&quot;: [&quot;dmg&quot;], &quot;macOS&quot;: { &quot;minimumSystemVersion&quot;: &quot;12.0&quot; } }\n}\n</code></pre>","lang":"jsonc"},"P-efe43533-0":{"id":"P-efe43533-0","level":0,"parent":"S-10c7677d-0","kind":"prose","span":{"start":8860,"end":9118},"html":"<p><strong>Rule for the whole codebase:</strong> Rust owns <em>disk truth</em> (reading, watching, payload extraction). TypeScript owns <em>view truth</em> (lookup table in memory, anchoring, rendering). The only crossings are three Tauri commands and one event channel (<code>doc://changed</code>).</p>"},"P-247821b0-0":{"id":"P-247821b0-0","level":0,"parent":"S-247821b0-0","kind":"heading","span":{"start":9125,"end":9183},"html":"<h2>2. The Relational Schema &amp; Parser Engine (System A + C)</h2>"},"P-6544cffb-0":{"id":"P-6544cffb-0","level":0,"parent":"S-247821b0-0","kind":"heading","span":{"start":9185,"end":9209},"html":"<h3>2.1 Conceptual model</h3>"},"P-b6964e17-0":{"id":"P-b6964e17-0","level":0,"parent":"S-247821b0-0","kind":"prose","span":{"start":9211,"end":9277},"html":"<p>The document is an inverted tree with strict parent/child binding:</p>"},"P-e9ef5093-0":{"id":"P-e9ef5093-0","level":0,"parent":"S-247821b0-0","kind":"code","span":{"start":9279,"end":9488},"html":"<pre><code>M_1 (k=-2, &quot;The Story&quot;)\n ├── S_1 (k=-1, plain-English section)\n │    ├── P_1 (k=0, raw paragraph)\n │    └── P_2\n └── S_2\n      ├── P_3\n      └── P_4 (code block)\n</code></pre>"},"P-0ca10484-0":{"id":"P-0ca10484-0","level":0,"parent":"S-247821b0-0","kind":"prose","span":{"start":9490,"end":9698},"html":"<p>Every node at level k = 0 has exactly one parent at k = −1; every k = −1 node has exactly one parent at k = −2. A &quot;sibling group&quot; (used by Focus Masking, §4) is <em>all P-nodes sharing the same S-parent</em>.</p>"},"P-dce65e70-0":{"id":"P-dce65e70-0","level":0,"parent":"S-247821b0-0","kind":"prose","span":{"start":9700,"end":10379},"html":"<p>IDs are <strong>content-addressed</strong> (D6), never positional: <code>P-&lt;hash8&gt;-&lt;n&gt;</code>, where <code>hash8</code> is the first 8 hex chars of SHA-256 over the node&#39;s raw span text and <code>n</code> is the 0-based ordinal among nodes sharing that hash, in document order. Repeated blocks — identical code fences, standard log separators — get distinct, deterministic IDs: the third identical separator is <code>P-&lt;h&gt;-2</code> in every parse, on every machine. Section IDs apply the same scheme to the section&#39;s leading block (<code>S-&lt;hash8&gt;-&lt;n&gt;</code>). Meta nodes stay positional (<code>M1</code>, <code>M2</code>): story text is regenerated wholesale on every synthesis, so content identity is meaningless at that level, while narrative <em>slots</em> are stable.</p>"},"P-4f526662-0":{"id":"P-4f526662-0","level":0,"parent":"S-247821b0-0","kind":"prose","span":{"start":10381,"end":10891},"html":"<p>Why not sequential: if an agent inserts a paragraph mid-document, <code>P3</code> becomes different content while the ID <code>P3</code> still &quot;exists&quot; — caret restoration (§5.3) would succeed while anchoring to the wrong paragraph, silently. Content addressing makes &quot;same ID&quot; mean &quot;same bytes&quot;, which is exactly the guarantee restoration needs. The payload contract mandates this derivation, and the Rust side enforces it (<code>verify_ids</code>, §2.3) — an unenforced derivation rule is no rule, since Engine A agents author the IDs.</p>"},"P-7399460d-0":{"id":"P-7399460d-0","level":0,"parent":"S-247821b0-0","kind":"heading","span":{"start":10893,"end":10943},"html":"<h3>2.2 TypeScript schema (<code>src/engine/schema.ts</code>)</h3>"},"P-51791ee0-0":{"id":"P-51791ee0-0","level":0,"parent":"S-247821b0-0","kind":"code","span":{"start":10945,"end":13584},"html":"<pre><code class=\"language-ts\">export type ZoomLevel = -2 | -1 | 0;\n\n/** Raw paragraph — level 0. Immutable view of a slice of the source file. */\nexport interface ParagraphNode {\n  id: string;                     // &quot;P-1c9a2b3f-0&quot; (D6)\n  level: 0;\n  parent: string;                 // S-node id\n  kind: &#39;prose&#39; | &#39;code&#39; | &#39;list&#39; | &#39;table&#39; | &#39;heading&#39; | &#39;blockquote&#39;;\n  /** Byte offsets into the ORIGINAL markdown source. Enables copy-exact\n      and cheap diffing on hot reload. */\n  span: { start: number; end: number };\n  /** Pre-rendered HTML (markdown → HTML at parse time, never at scroll time). */\n  html: string;\n  /** For kind === &#39;code&#39; only. */\n  lang?: string;\n}\n\n/** Plain-English section — level −1. */\nexport interface SectionNode {\n  id: string;                     // &quot;S-7e02d4aa-0&quot; (D6)\n  level: -1;\n  parent: string;                 // M-node id\n  children: string[];             // ordered P ids — THE sibling group\n  title: string;\n  body: string;                   // jargon-free walkthrough, plain markdown\n}\n\n/** Story meta-node — level −2. */\nexport interface MetaNode {\n  id: string;                     // &quot;M1&quot; (positional — see §2.1)\n  level: -2;\n  children: string[];             // ordered S ids\n  title: string;\n  body: string;                   // accomplished / blockers / next steps\n}\n\nexport interface LookupTable {\n  version: 1;\n  /** SHA-256 of all bytes PRECEDING the payload marker — a payload\n      cannot hash a file that contains itself. The watcher&#39;s no-op\n      short-circuit (§5.3) must hash the same region. */\n  docHash: string;\n  meta: Record&lt;string, MetaNode&gt;;\n  sections: Record&lt;string, SectionNode&gt;;\n  paragraphs: Record&lt;string, ParagraphNode&gt;;\n  /** Document-order arrays. Rendering iterates these; never Object.keys(). */\n  order: { meta: string[]; sections: string[]; paragraphs: string[] };\n}\n\n/** O(1) child→parent resolution both directions. Built once per load. */\nexport interface ResolvedIndex {\n  parentOfParagraph: Map&lt;string, string&gt;;   // P → S\n  parentOfSection: Map&lt;string, string&gt;;     // S → M\n  siblingGroup: Map&lt;string, string[]&gt;;      // P → all P ids in its group\n}\n\nexport function buildIndex(t: LookupTable): ResolvedIndex {\n  const parentOfParagraph = new Map&lt;string, string&gt;();\n  const parentOfSection = new Map&lt;string, string&gt;();\n  const siblingGroup = new Map&lt;string, string[]&gt;();\n  for (const s of Object.values(t.sections)) {\n    parentOfSection.set(s.id, s.parent);\n    for (const p of s.children) {\n      parentOfParagraph.set(p, s.id);\n      siblingGroup.set(p, s.children);\n    }\n  }\n  return { parentOfParagraph, parentOfSection, siblingGroup };\n}\n</code></pre>","lang":"ts"},"P-48146d99-0":{"id":"P-48146d99-0","level":0,"parent":"S-247821b0-0","kind":"heading","span":{"start":13586,"end":13637},"html":"<h3>2.3 Rust mirror (<code>src-tauri/src/parser/mod.rs</code>)</h3>"},"P-a11c9145-0":{"id":"P-a11c9145-0","level":0,"parent":"S-247821b0-0","kind":"prose","span":{"start":13639,"end":13839},"html":"<p>The Rust side never <em>interprets</em> the tree — it only validates and hands it over. Mirror structs exist so <code>serde_json</code> can reject malformed payloads at the boundary instead of poisoning the frontend.</p>"},"P-06f1b7f0-0":{"id":"P-06f1b7f0-0","level":0,"parent":"S-247821b0-0","kind":"code","span":{"start":13841,"end":17086},"html":"<pre><code class=\"language-rust\">use serde::{Deserialize, Serialize};\nuse std::collections::HashMap;\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct Span { pub start: usize, pub end: usize }\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct ParagraphNode {\n    pub id: String,\n    pub level: i8,                 // always 0; validated below\n    pub parent: String,\n    pub kind: String,\n    pub span: Span,\n    pub html: String,\n    #[serde(skip_serializing_if = &quot;Option::is_none&quot;)]\n    pub lang: Option&lt;String&gt;,\n}\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct SectionNode {\n    pub id: String,\n    pub level: i8,                 // always -1\n    pub parent: String,\n    pub children: Vec&lt;String&gt;,\n    pub title: String,\n    pub body: String,\n}\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct MetaNode {\n    pub id: String,\n    pub level: i8,                 // always -2\n    pub children: Vec&lt;String&gt;,\n    pub title: String,\n    pub body: String,\n}\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct Order {\n    pub meta: Vec&lt;String&gt;,\n    pub sections: Vec&lt;String&gt;,\n    pub paragraphs: Vec&lt;String&gt;,\n}\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct LookupTable {\n    pub version: u8,\n    pub doc_hash: String,\n    pub meta: HashMap&lt;String, MetaNode&gt;,\n    pub sections: HashMap&lt;String, SectionNode&gt;,\n    pub paragraphs: HashMap&lt;String, ParagraphNode&gt;,\n    pub order: Order,\n}\n\nimpl LookupTable {\n    /// Referential-integrity check. Reject the payload rather than let the\n    /// UI hit a missing parent mid-transition.\n    pub fn validate(&amp;self) -&gt; Result&lt;(), String&gt; {\n        for (id, p) in &amp;self.paragraphs {\n            if p.level != 0 { return Err(format!(&quot;{id}: level must be 0&quot;)); }\n            if !self.sections.contains_key(&amp;p.parent) {\n                return Err(format!(&quot;{id}: dangling parent {}&quot;, p.parent));\n            }\n        }\n        for (id, s) in &amp;self.sections {\n            if s.level != -1 { return Err(format!(&quot;{id}: level must be -1&quot;)); }\n            if !self.meta.contains_key(&amp;s.parent) {\n                return Err(format!(&quot;{id}: dangling parent {}&quot;, s.parent));\n            }\n            for c in &amp;s.children {\n                if !self.paragraphs.contains_key(c) {\n                    return Err(format!(&quot;{id}: missing child {c}&quot;));\n                }\n            }\n        }\n        Ok(())\n    }\n\n    /// D6 enforcement: recompute each paragraph&#39;s content hash from its\n    /// span slice of the pre-payload source and require the ID to embed\n    /// it. Rejects payloads whose IDs weren&#39;t derived per contract —\n    /// without this, content addressing is a convention, not a guarantee.\n    /// (Cargo: add `sha2` and `hex`.)\n    pub fn verify_ids(&amp;self, source: &amp;str) -&gt; Result&lt;(), String&gt; {\n        use sha2::{Digest, Sha256};\n        let bytes = source.as_bytes();\n        for (id, p) in &amp;self.paragraphs {\n            let slice = bytes\n                .get(p.span.start..p.span.end)\n                .ok_or_else(|| format!(&quot;{id}: span out of bounds&quot;))?;\n            let h = &amp;hex::encode(Sha256::digest(slice))[..8];\n            if !id.starts_with(&amp;format!(&quot;P-{h}-&quot;)) {\n                return Err(format!(&quot;{id}: content hash mismatch (expected P-{h}-*)&quot;));\n            }\n        }\n        Ok(())\n    }\n}\n</code></pre>","lang":"rust"},"P-25303dcb-0":{"id":"P-25303dcb-0","level":0,"parent":"S-247821b0-0","kind":"heading","span":{"start":17088,"end":17162},"html":"<h3>2.4 Mapping matrix — JSON Schema (the on-disk / in-payload contract)</h3>"},"P-12c11aa4-0":{"id":"P-12c11aa4-0","level":0,"parent":"S-247821b0-0","kind":"prose","span":{"start":17164,"end":17269},"html":"<p>Store this at <code>docs/payload-format.md</code> and treat it as the versioned contract between agents and the app.</p>"},"P-d5b53fc4-0":{"id":"P-d5b53fc4-0","level":0,"parent":"S-247821b0-0","kind":"code","span":{"start":17271,"end":19869},"html":"<pre><code class=\"language-json\">{\n  &quot;$schema&quot;: &quot;https://json-schema.org/draft/2020-12/schema&quot;,\n  &quot;$id&quot;: &quot;semantic-zoom/lookup-table/v1&quot;,\n  &quot;type&quot;: &quot;object&quot;,\n  &quot;required&quot;: [&quot;version&quot;, &quot;docHash&quot;, &quot;meta&quot;, &quot;sections&quot;, &quot;paragraphs&quot;, &quot;order&quot;],\n  &quot;properties&quot;: {\n    &quot;version&quot;: { &quot;const&quot;: 1 },\n    &quot;docHash&quot;: { &quot;type&quot;: &quot;string&quot;, &quot;pattern&quot;: &quot;^[a-f0-9]{64}$&quot; },\n    &quot;meta&quot;: {\n      &quot;type&quot;: &quot;object&quot;,\n      &quot;additionalProperties&quot;: {\n        &quot;type&quot;: &quot;object&quot;,\n        &quot;required&quot;: [&quot;id&quot;, &quot;level&quot;, &quot;children&quot;, &quot;title&quot;, &quot;body&quot;],\n        &quot;properties&quot;: {\n          &quot;id&quot;: { &quot;type&quot;: &quot;string&quot;, &quot;pattern&quot;: &quot;^M\\\\d+$&quot; },\n          &quot;level&quot;: { &quot;const&quot;: -2 },\n          &quot;children&quot;: { &quot;type&quot;: &quot;array&quot;, &quot;items&quot;: { &quot;pattern&quot;: &quot;^S-[a-f0-9]{8}-\\\\d+$&quot; }, &quot;minItems&quot;: 1 },\n          &quot;title&quot;: { &quot;type&quot;: &quot;string&quot; },\n          &quot;body&quot;: { &quot;type&quot;: &quot;string&quot; }\n        }\n      }\n    },\n    &quot;sections&quot;: {\n      &quot;type&quot;: &quot;object&quot;,\n      &quot;additionalProperties&quot;: {\n        &quot;type&quot;: &quot;object&quot;,\n        &quot;required&quot;: [&quot;id&quot;, &quot;level&quot;, &quot;parent&quot;, &quot;children&quot;, &quot;title&quot;, &quot;body&quot;],\n        &quot;properties&quot;: {\n          &quot;id&quot;: { &quot;type&quot;: &quot;string&quot;, &quot;pattern&quot;: &quot;^S-[a-f0-9]{8}-\\\\d+$&quot; },\n          &quot;level&quot;: { &quot;const&quot;: -1 },\n          &quot;parent&quot;: { &quot;type&quot;: &quot;string&quot;, &quot;pattern&quot;: &quot;^M\\\\d+$&quot; },\n          &quot;children&quot;: { &quot;type&quot;: &quot;array&quot;, &quot;items&quot;: { &quot;pattern&quot;: &quot;^P-[a-f0-9]{8}-\\\\d+$&quot; }, &quot;minItems&quot;: 1 },\n          &quot;title&quot;: { &quot;type&quot;: &quot;string&quot; },\n          &quot;body&quot;: { &quot;type&quot;: &quot;string&quot; }\n        }\n      }\n    },\n    &quot;paragraphs&quot;: {\n      &quot;type&quot;: &quot;object&quot;,\n      &quot;additionalProperties&quot;: {\n        &quot;type&quot;: &quot;object&quot;,\n        &quot;required&quot;: [&quot;id&quot;, &quot;level&quot;, &quot;parent&quot;, &quot;kind&quot;, &quot;span&quot;, &quot;html&quot;],\n        &quot;properties&quot;: {\n          &quot;id&quot;: { &quot;type&quot;: &quot;string&quot;, &quot;pattern&quot;: &quot;^P-[a-f0-9]{8}-\\\\d+$&quot; },\n          &quot;level&quot;: { &quot;const&quot;: 0 },\n          &quot;parent&quot;: { &quot;type&quot;: &quot;string&quot;, &quot;pattern&quot;: &quot;^S-[a-f0-9]{8}-\\\\d+$&quot; },\n          &quot;kind&quot;: { &quot;enum&quot;: [&quot;prose&quot;, &quot;code&quot;, &quot;list&quot;, &quot;table&quot;, &quot;heading&quot;, &quot;blockquote&quot;] },\n          &quot;span&quot;: {\n            &quot;type&quot;: &quot;object&quot;,\n            &quot;required&quot;: [&quot;start&quot;, &quot;end&quot;],\n            &quot;properties&quot;: {\n              &quot;start&quot;: { &quot;type&quot;: &quot;integer&quot;, &quot;minimum&quot;: 0 },\n              &quot;end&quot;: { &quot;type&quot;: &quot;integer&quot;, &quot;minimum&quot;: 0 }\n            }\n          },\n          &quot;html&quot;: { &quot;type&quot;: &quot;string&quot; },\n          &quot;lang&quot;: { &quot;type&quot;: &quot;string&quot; }\n        }\n      }\n    },\n    &quot;order&quot;: {\n      &quot;type&quot;: &quot;object&quot;,\n      &quot;required&quot;: [&quot;meta&quot;, &quot;sections&quot;, &quot;paragraphs&quot;],\n      &quot;properties&quot;: {\n        &quot;meta&quot;: { &quot;type&quot;: &quot;array&quot;, &quot;items&quot;: { &quot;type&quot;: &quot;string&quot; } },\n        &quot;sections&quot;: { &quot;type&quot;: &quot;array&quot;, &quot;items&quot;: { &quot;type&quot;: &quot;string&quot; } },\n        &quot;paragraphs&quot;: { &quot;type&quot;: &quot;array&quot;, &quot;items&quot;: { &quot;type&quot;: &quot;string&quot; } }\n      }\n    }\n  }\n}\n</code></pre>","lang":"json"},"P-d31de407-0":{"id":"P-d31de407-0","level":0,"parent":"S-d31de407-0","kind":"heading","span":{"start":19871,"end":19933},"html":"<h3>2.5 Bidirectional navigation math (<code>src/engine/anchor.ts</code>)</h3>"},"P-00d5fbab-0":{"id":"P-00d5fbab-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":19935,"end":20187},"html":"<p><strong>The invariant:</strong> at any moment, exactly one node is the <em>anchor</em>. Zoom transitions never scroll to &quot;where you were&quot; in pixels — pixel positions are meaningless across levels. They scroll to <em>the semantic relative of the anchor at the target level</em>.</p>"},"P-008ca03f-0":{"id":"P-008ca03f-0","level":0,"parent":"S-d31de407-0","kind":"blockquote","span":{"start":20189,"end":20499},"html":"<blockquote>\n<p><strong>Amended 2026-07-18</strong> (design: <code>docs/superpowers/specs/2026-07-18-top-edge-anchoring-design.md</code>): the anchor rule and the landing math both changed from centering to top-alignment, and the read-only caret no longer participates in anchor resolution. Rationale below supersedes the original centering design.</p>\n</blockquote>"},"P-ca109407-0":{"id":"P-ca109407-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":20501,"end":20554},"html":"<p><strong>Anchor resolution (source level → anchor node):</strong></p>"},"P-70dd8e4a-0":{"id":"P-70dd8e4a-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":20556,"end":20994},"html":"<p>The anchor is the <strong>topmost actually-visible node</strong>: the node whose box contains the viewport&#39;s top edge, or, if the top edge falls in a gap, the first node starting below it (single pass over currently mounted elements using cached <code>offsetTop</code>/<code>offsetHeight</code>; no <code>getBoundingClientRect</code> in a loop). Explicitly <em>not</em> &quot;closest to the top edge&quot; — a node whose bottom scrolled a few pixels above the edge is close but no longer being read.</p>"},"P-502f0f91-0":{"id":"P-502f0f91-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":20996,"end":21337},"html":"<p>Scroll position is the <em>only</em> anchor signal. The read-only caret (<code>data-caret</code> on the clicked <code>.pnode</code>) carries no visible CSS anywhere in the app — it is an invisible marker — so it must never steer navigation the user cannot see happening. It keeps its other jobs (click-to-spotlight via the focus mask, arrow-key traversal) unchanged.</p>"},"P-77118bee-0":{"id":"P-77118bee-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":21339,"end":21388},"html":"<p><strong>Cross-level mapping (anchor → target node):</strong></p>"},"P-660d40ea-0":{"id":"P-660d40ea-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":21390,"end":21951},"html":"<table>\n<thead>\n<tr>\n<th>From → To</th>\n<th>Mapping</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>0 → −1</td>\n<td><code>target = parentOfParagraph.get(anchor)</code> — e.g. caret in P₃ → pan to S₂</td>\n</tr>\n<tr>\n<td>0 → −2</td>\n<td><code>parentOfSection.get(parentOfParagraph.get(anchor))</code></td>\n</tr>\n<tr>\n<td>−1 → 0</td>\n<td><code>target = lastCaretIn[S_x] ?? sections[S_x].children[0]</code> — restore the caret&#39;s paragraph if we&#39;ve been here before, else first child</td>\n</tr>\n<tr>\n<td>−1 → −2</td>\n<td><code>parentOfSection.get(anchor)</code></td>\n</tr>\n<tr>\n<td>−2 → −1</td>\n<td><code>lastAnchorIn[M_y] ?? meta[M_y].children[0]</code></td>\n</tr>\n<tr>\n<td>−2 → 0</td>\n<td>resolve −2 → −1 first, then −1 → 0 (two table reads, still O(1))</td>\n</tr>\n</tbody></table>"},"P-5b6c485e-0":{"id":"P-5b6c485e-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":21953,"end":22122},"html":"<p><code>lastCaretIn</code> / <code>lastAnchorIn</code> are plain <code>Map&lt;string,string&gt;</code> kept in the store — this is what makes zooming out and back in feel like the app &quot;remembered your place.&quot;</p>"},"P-91fae7d2-0":{"id":"P-91fae7d2-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":22124,"end":22175},"html":"<p><strong>Top-alignment math (target node → scrollTop):</strong></p>"},"P-d4f59cdc-0":{"id":"P-d4f59cdc-0","level":0,"parent":"S-d31de407-0","kind":"code","span":{"start":22177,"end":22508},"html":"<pre><code class=\"language-ts\">export const TOP_GAP = 24;\n\nexport function topAlignScrollTop(\n  el: { offsetTop: number },\n  viewport: { clientHeight: number; scrollHeight: number },\n  gap: number = TOP_GAP,\n): number {\n  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);\n  return Math.min(Math.max(el.offsetTop - gap, 0), max);\n}\n</code></pre>","lang":"ts"},"P-576ba68c-0":{"id":"P-576ba68c-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":22510,"end":22584},"html":"<p><strong>Transition sequence (prevents the layout-jump the spec worries about):</strong></p>"},"P-c9814357-0":{"id":"P-c9814357-0","level":0,"parent":"S-d31de407-0","kind":"list","span":{"start":22586,"end":23315},"html":"<ol>\n<li><strong>Frame n:</strong> append the target level&#39;s layer hidden (<code>visibility:hidden</code>, same container width) and return — no layout reads in this frame. Groups carry <code>content-visibility:auto</code> (§4.2), so WebKit lays out only near-viewport groups, not the whole tree.</li>\n<li><strong>Frame n+1 (rAF):</strong> read the mapped target node&#39;s <code>offsetTop</code> — one contained layout, not a read/write thrash loop — compute <code>topAlignScrollTop</code>, set <code>scrollTop</code> on the hidden layer.</li>\n<li>Same frame: start the 200ms opacity crossfade (compositor-only, §4).</li>\n<li>On <code>transitionend</code>: unmount the old layer, then briefly mark the landed node (<code>data-landed</code>) so the anchor is visibly acknowledged — a left accent bar fading over ~1s (opacity only, D1), self-clearing.</li>\n</ol>"},"P-8843e0bc-0":{"id":"P-8843e0bc-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":23317,"end":23621},"html":"<p>The one-frame delay (~16ms) is invisible inside the 200ms fade; a <code>switchMap</code>-aborted effect (§3.2) covers slider spam. Do <strong>not</strong> substitute measurement with estimated heights (character counts etc.): approximate positions break exact top-alignment, which is the entire point of the anchor engine (D8).</p>"},"P-b54687e6-0":{"id":"P-b54687e6-0","level":0,"parent":"S-d31de407-0","kind":"prose","span":{"start":23623,"end":23777},"html":"<p>The user never sees an intermediate scroll position; the new level <em>arrives already top-aligned</em>, with the landed node just below the viewport&#39;s top edge.</p>"},"P-ee486a4c-0":{"id":"P-ee486a4c-0","level":0,"parent":"S-ee486a4c-0","kind":"heading","span":{"start":23779,"end":23850},"html":"<h3>2.6 Engine A — Native payload extraction (the ≤10ms happy path)</h3>"},"P-33c457d3-0":{"id":"P-33c457d3-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":23852,"end":23879},"html":"<p><strong>Marker convention (D2):</strong></p>"},"P-b2935767-0":{"id":"P-b2935767-0","level":0,"parent":"S-ee486a4c-0","kind":"code","span":{"start":23881,"end":23957},"html":"<pre><code class=\"language-markdown\">&lt;!-- semantic-zoom:payload:v1\n{ ...LookupTable JSON... }\n--&gt;\n</code></pre>","lang":"markdown"},"P-77c00e38-0":{"id":"P-77c00e38-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":23959,"end":24097},"html":"<p>Placed by the agent at the <strong>end</strong> of the .md file (invisible in GitHub/VS Code preview). Extraction is a byte scan, not a markdown parse:</p>"},"P-93aa020a-0":{"id":"P-93aa020a-0","level":0,"parent":"S-ee486a4c-0","kind":"code","span":{"start":24099,"end":24745},"html":"<pre><code class=\"language-rust\">// src-tauri/src/parser/payload.rs\nconst HEAD: &amp;str = &quot;&lt;!-- semantic-zoom:payload:v1&quot;;\nconst TAIL: &amp;str = &quot;--&gt;&quot;;\n\npub fn extract_payload(source: &amp;str) -&gt; Option&lt;Result&lt;LookupTable, String&gt;&gt; {\n    let start = source.rfind(HEAD)?;               // rfind: payload lives at EOF\n    let json_start = start + HEAD.len();\n    let end = source[json_start..].rfind(TAIL)? + json_start; // last --&gt;: hardens against unescaped occurrences\n    let json = source[json_start..end].trim();\n    Some(\n        serde_json::from_str::&lt;LookupTable&gt;(json)\n            .map_err(|e| e.to_string())\n            .and_then(|t| t.validate().map(|_| t)),\n    )\n}\n</code></pre>","lang":"rust"},"P-e2c39228-0":{"id":"P-e2c39228-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":24747,"end":24947},"html":"<p>Budget check: <code>rfind</code> + <code>serde_json</code> on a 1 MB file with a ~200 KB payload parses in ~1–3 ms on Apple Silicon. The 10 ms budget is comfortable; add a <code>debug_assert!</code> timing log, not an optimization.</p>"},"P-94fdc8ab-0":{"id":"P-94fdc8ab-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":24949,"end":25067},"html":"<p><strong>Contract addenda (surfaced by fixture construction and review round 1) — these live in <code>docs/payload-format.md</code>:</strong></p>"},"P-81549238-0":{"id":"P-81549238-0","level":0,"parent":"S-ee486a4c-0","kind":"list","span":{"start":25069,"end":25557},"html":"<ul>\n<li><strong>A1:</strong> <code>docHash</code> covers all bytes <em>preceding</em> the payload marker. A payload cannot hash a file that contains itself; the hot-reload short-circuit must hash the same region.</li>\n<li><strong>A2:</strong> all <code>span</code> offsets reference that same pre-payload byte region.</li>\n<li><strong>A3:</strong> producers must escape any <code>--&gt;</code> inside JSON strings as <code>--\\u003e</code>; the extractor additionally matches the <em>last</em> <code>--&gt;</code> as defense in depth.</li>\n<li><strong>A4:</strong> IDs must follow the D6 derivation; <code>verify_ids()</code> rejects payloads that don&#39;t.</li>\n</ul>"},"P-1c46255b-0":{"id":"P-1c46255b-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":25559,"end":25610},"html":"<p><strong>Return contract of the <code>load_document</code> command:</strong></p>"},"P-4dbc906d-0":{"id":"P-4dbc906d-0","level":0,"parent":"S-ee486a4c-0","kind":"code","span":{"start":25612,"end":26076},"html":"<pre><code class=\"language-rust\">#[derive(Serialize)]\n#[serde(tag = &quot;kind&quot;, rename_all = &quot;camelCase&quot;)]\npub enum LoadResult {\n    /// Engine A succeeded — render immediately.\n    Native { table: LookupTable, raw: String },\n    /// No payload found — frontend shows k=0 immediately and\n    /// routes to Engine B (stub in Phase 1).\n    Untagged { raw: String },\n    /// Payload present but invalid — show k=0 + non-modal warning badge.\n    Corrupt { raw: String, error: String },\n}\n</code></pre>","lang":"rust"},"P-85ec2bf4-0":{"id":"P-85ec2bf4-0","level":0,"parent":"S-ee486a4c-0","kind":"heading","span":{"start":26078,"end":26145},"html":"<h3>2.7 Engine B — Fallback Synthesizer (Phase 1: interface only)</h3>"},"P-578ab58e-0":{"id":"P-578ab58e-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":26147,"end":26435},"html":"<p>Phase 1 ships the <em>seam</em>, not the synthesis. The frontend must already handle the &quot;levels −1/−2 unavailable&quot; state gracefully (slider detents disabled with tooltip &quot;Generating summary…&quot; or &quot;No summary available&quot;), so that plugging in the real synthesizer later touches zero UI code.</p>"},"P-dc27c7b0-0":{"id":"P-dc27c7b0-0","level":0,"parent":"S-ee486a4c-0","kind":"code","span":{"start":26437,"end":26913},"html":"<pre><code class=\"language-ts\">// src/engine/engine-b.ts\nexport interface Synthesizer {\n  /** Segments raw markdown (unified + remark-parse → AST → paragraph\n      grouping) and generates S/M layers. Resolves with a full LookupTable. */\n  synthesize(raw: string, signal: AbortSignal): Promise&lt;LookupTable&gt;;\n}\n\n/** Phase 1 stub: rejects immediately; UI stays at k=0. */\nexport const stubSynthesizer: Synthesizer = {\n  synthesize: async () =&gt; { throw new Error(&#39;ENGINE_B_NOT_IMPLEMENTED&#39;); },\n};\n</code></pre>","lang":"ts"},"P-0985edd1-0":{"id":"P-0985edd1-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":26915,"end":27315},"html":"<p>Phase 2 notes (do not build yet): segmentation runs client-side with <code>unified().use(remarkParse)</code> + <code>unist-util-visit</code>, grouping top-level AST nodes under nearest heading; generation targets a local Ollama endpoint (<code>http://localhost:11434/api/generate</code>, model: quantized Gemma 3 4B or Qwen3 4B) with one prompt template per level; results must pass the same Rust-side <code>validate()</code> before activation.</p>"},"P-5c319197-0":{"id":"P-5c319197-0","level":0,"parent":"S-ee486a4c-0","kind":"prose","span":{"start":27317,"end":27404},"html":"<p><strong>Parser configuration (used by Engine B segmentation and by any future re-chunking):</strong></p>"},"P-fdc99993-0":{"id":"P-fdc99993-0","level":0,"parent":"S-ee486a4c-0","kind":"code","span":{"start":27406,"end":28141},"html":"<pre><code class=\"language-ts\">import { unified } from &#39;unified&#39;;\nimport remarkParse from &#39;remark-parse&#39;;\nimport { visit } from &#39;unist-util-visit&#39;;\n\nconst processor = unified().use(remarkParse);\n\nexport function segment(raw: string): { kind: string; start: number; end: number }[] {\n  const tree = processor.parse(raw);\n  const out: { kind: string; start: number; end: number }[] = [];\n  visit(tree, (node: any) =&gt; {\n    if (!node.position || node.type === &#39;root&#39;) return;\n    if ([&#39;paragraph&#39;, &#39;code&#39;, &#39;list&#39;, &#39;table&#39;, &#39;heading&#39;, &#39;blockquote&#39;].includes(node.type)) {\n      out.push({ kind: node.type, start: node.position.start.offset, end: node.position.end.offset });\n      return &#39;skip&#39;; // don&#39;t descend into block children\n    }\n  });\n  return out;\n}\n</code></pre>","lang":"ts"},"P-a58b0af4-0":{"id":"P-a58b0af4-0","level":0,"parent":"S-a58b0af4-0","kind":"heading","span":{"start":28147,"end":28204},"html":"<h2>3. Reactive Subject State Management (System A/B glue)</h2>"},"P-e37870b4-0":{"id":"P-e37870b4-0","level":0,"parent":"S-a58b0af4-0","kind":"heading","span":{"start":28206,"end":28235},"html":"<h3>3.1 The single-store rule</h3>"},"P-d441390a-0":{"id":"P-d441390a-0","level":0,"parent":"S-a58b0af4-0","kind":"prose","span":{"start":28237,"end":28468},"html":"<p>One <code>BehaviorSubject&lt;AppState&gt;</code> is the app. Nothing else holds state. Components subscribe to <em>selectors</em>, never to the raw store, and every selector pipes through <code>distinctUntilChanged</code> so a caret move never re-renders the slider.</p>"},"P-e87fc865-0":{"id":"P-e87fc865-0","level":0,"parent":"S-a58b0af4-0","kind":"code","span":{"start":28470,"end":30140},"html":"<pre><code class=\"language-ts\">// src/state/store.ts\nimport { BehaviorSubject, Subject, animationFrameScheduler } from &#39;rxjs&#39;;\nimport { map, distinctUntilChanged, observeOn, auditTime } from &#39;rxjs/operators&#39;;\nimport type { LookupTable, ZoomLevel, ResolvedIndex } from &#39;../engine/schema&#39;;\n\nexport type DocStatus = &#39;empty&#39; | &#39;ready&#39; | &#39;untagged&#39; | &#39;corrupt&#39; | &#39;reloading&#39;;\n\nexport interface AppState {\n  zoom: ZoomLevel;\n  doc: LookupTable | null;\n  index: ResolvedIndex | null;\n  raw: string;\n  status: DocStatus;\n  caret: { paragraphId: string | null; offset: number };\n  /** P-id whose sibling group is spotlit. Derived from caret, cached here\n      so focus-mask doesn&#39;t recompute the group on every caret offset tick. */\n  activeGroupHead: string | null;\n  /** Per-container &quot;remembered place&quot; maps (§2.5). */\n  lastCaretIn: Map&lt;string, string&gt;;   // S-id → P-id\n  lastAnchorIn: Map&lt;string, string&gt;;  // M-id → S-id\n}\n\nexport type Action =\n  | { type: &#39;DOC_LOADED&#39;; result: import(&#39;../engine/engine-a&#39;).LoadResultDTO }\n  | { type: &#39;DOC_CHANGED_ON_DISK&#39; }          // from watcher event\n  | { type: &#39;ZOOM_SET&#39;; level: ZoomLevel }\n  | { type: &#39;CARET_PLACED&#39;; paragraphId: string; offset: number };\n\nconst initial: AppState = {\n  zoom: 0, doc: null, index: null, raw: &#39;&#39;, status: &#39;empty&#39;,\n  caret: { paragraphId: null, offset: 0 },\n  activeGroupHead: null,\n  lastCaretIn: new Map(), lastAnchorIn: new Map(),\n};\n\nconst state$ = new BehaviorSubject&lt;AppState&gt;(initial);\nexport const actions$ = new Subject&lt;Action&gt;();\n\nactions$.subscribe((a) =&gt; state$.next(reduce(state$.getValue(), a)));\n\nexport const select = &lt;T&gt;(fn: (s: AppState) =&gt; T) =&gt;\n  state$.pipe(map(fn), distinctUntilChanged());\n</code></pre>","lang":"ts"},"P-107a589f-0":{"id":"P-107a589f-0","level":0,"parent":"S-107a589f-0","kind":"heading","span":{"start":30142,"end":30198},"html":"<h3>3.2 The three streams that must not fight each other</h3>"},"P-b0470403-0":{"id":"P-b0470403-0","level":0,"parent":"S-107a589f-0","kind":"prose","span":{"start":30200,"end":31133},"html":"<table>\n<thead>\n<tr>\n<th>Stream</th>\n<th>Source</th>\n<th>Discipline</th>\n</tr>\n</thead>\n<tbody><tr>\n<td><strong>Slider → zoom</strong></td>\n<td>pointer events on slider detents</td>\n<td>Emits <code>ZOOM_SET</code> only on detent snap, never per-pixel. The transition sequence (§2.5 step 1–4) runs as an async effect keyed by zoom; a new <code>ZOOM_SET</code> mid-flight aborts the previous via <code>switchMap</code>.</td>\n</tr>\n<tr>\n<td><strong>Caret → focus mask</strong></td>\n<td>click/keyboard in viewport</td>\n<td><code>CARET_PLACED</code> is <code>auditTime(16)</code>-throttled. <code>activeGroupHead</code> changes only when the caret crosses a sibling-group boundary — the reducer compares <code>siblingGroup.get(new)[0]</code> to the current head. Same group ⇒ no emission ⇒ zero DOM writes.</td>\n</tr>\n<tr>\n<td><strong>Watcher → reload</strong></td>\n<td>Tauri <code>doc://changed</code> event</td>\n<td>Sets <code>status:&#39;reloading&#39;</code>, re-invokes <code>load_document</code>, and on success diffs <code>docHash</code>; identical hash ⇒ silently drop. State restore: if the old caret&#39;s <code>P</code>-id still exists in the new table, keep it; else fall back to its parent <code>S</code>&#39;s first surviving child.</td>\n</tr>\n</tbody></table>"},"P-55039efb-0":{"id":"P-55039efb-0","level":0,"parent":"S-107a589f-0","kind":"prose","span":{"start":31135,"end":31241},"html":"<p><strong>Scroll writes</strong> are the one place layout is touched. All of them route through a single scheduler queue:</p>"},"P-48949622-0":{"id":"P-48949622-0","level":0,"parent":"S-107a589f-0","kind":"code","span":{"start":31243,"end":31529},"html":"<pre><code class=\"language-ts\">// src/ui/viewport.ts (excerpt)\nimport { observeOn } from &#39;rxjs/operators&#39;;\nimport { animationFrameScheduler } from &#39;rxjs&#39;;\n\nscrollCommands$\n  .pipe(observeOn(animationFrameScheduler))   // batch to rAF; never mid-layout\n  .subscribe(({ el, top }) =&gt; { el.scrollTop = top; });\n</code></pre>","lang":"ts"},"P-7d11bea5-0":{"id":"P-7d11bea5-0","level":0,"parent":"S-107a589f-0","kind":"prose","span":{"start":31531,"end":31712},"html":"<p>Reads (<code>offsetTop</code> etc.) happen <em>before</em> the effect enqueues a write. Read-then-write, never interleaved — this alone eliminates the &quot;layout lag&quot; class of bugs the spec calls out.</p>"},"P-728d4905-0":{"id":"P-728d4905-0","level":0,"parent":"S-728d4905-0","kind":"heading","span":{"start":31714,"end":31734},"html":"<h3>3.3 Tauri bridge</h3>"},"P-e8361244-0":{"id":"P-e8361244-0","level":0,"parent":"S-728d4905-0","kind":"code","span":{"start":31736,"end":32225},"html":"<pre><code class=\"language-ts\">// src/main.ts (excerpt)\nimport { listen } from &#39;@tauri-apps/api/event&#39;;\nimport { invoke } from &#39;@tauri-apps/api/core&#39;;\nimport { actions$ } from &#39;./state/store&#39;;\n\nawait listen(&#39;doc://changed&#39;, () =&gt; actions$.next({ type: &#39;DOC_CHANGED_ON_DISK&#39; }));\n\nexport async function openFile(path: string) {\n  const result = await invoke(&#39;load_document&#39;, { path });\n  actions$.next({ type: &#39;DOC_LOADED&#39;, result });\n  await invoke(&#39;watch_directory&#39;, { path }); // §5 — watches parent dir\n}\n</code></pre>","lang":"ts"},"P-09995cd8-0":{"id":"P-09995cd8-0","level":0,"parent":"S-728d4905-0","kind":"prose","span":{"start":32227,"end":32533},"html":"<p><strong>Subscription hygiene (non-negotiable):</strong> every UI module exposes <code>mount(): () =&gt; void</code> and returns a teardown that unsubscribes everything it created. <code>main.ts</code> owns all lifecycles. No component calls <code>.subscribe</code> on <code>actions$</code> directly — components dispatch actions and subscribe to selectors, period.</p>"},"P-3008a382-0":{"id":"P-3008a382-0","level":0,"parent":"S-3008a382-0","kind":"heading","span":{"start":32540,"end":32583},"html":"<h2>4. UI &amp; Focus Mask Stylesheet (System B)</h2>"},"P-dfb24bce-0":{"id":"P-dfb24bce-0","level":0,"parent":"S-3008a382-0","kind":"heading","span":{"start":32585,"end":32606},"html":"<h3>4.1 DOM structure</h3>"},"P-e109335c-0":{"id":"P-e109335c-0","level":0,"parent":"S-3008a382-0","kind":"prose","span":{"start":32608,"end":32733},"html":"<p>The k = 0 renderer wraps each sibling group in one element. The group is the unit of dimming — never individual paragraphs.</p>"},"P-4e9d6a14-0":{"id":"P-4e9d6a14-0","level":0,"parent":"S-3008a382-0","kind":"code","span":{"start":32735,"end":33183},"html":"<pre><code class=\"language-html\">&lt;main id=&quot;viewport&quot; data-zoom=&quot;0&quot;&gt;\n  &lt;!-- one .pgroup per SectionNode; data-sid links back to the lookup table --&gt;\n  &lt;section class=&quot;pgroup&quot; data-sid=&quot;S1&quot;&gt;\n    &lt;div class=&quot;pnode&quot; data-pid=&quot;P1&quot; data-kind=&quot;prose&quot;&gt;…&lt;/div&gt;\n    &lt;div class=&quot;pnode&quot; data-pid=&quot;P2&quot; data-kind=&quot;code&quot;&gt;…&lt;/div&gt;\n  &lt;/section&gt;\n  &lt;section class=&quot;pgroup&quot; data-sid=&quot;S2&quot; data-dimmed&gt;\n    &lt;div class=&quot;pnode&quot; data-pid=&quot;P3&quot; data-kind=&quot;prose&quot;&gt;…&lt;/div&gt;\n  &lt;/section&gt;\n&lt;/main&gt;\n</code></pre>","lang":"html"},"P-33ae0b38-0":{"id":"P-33ae0b38-0","level":0,"parent":"S-3008a382-0","kind":"prose","span":{"start":33185,"end":33401},"html":"<p>The focus-mask module does exactly one thing per activeGroupHead change: toggles <code>data-dimmed</code> on the groups that changed state (not on all groups — track the previous spotlit <code>sid</code> and touch at most two elements).</p>"},"P-1b3f5ebf-0":{"id":"P-1b3f5ebf-0","level":0,"parent":"S-1b3f5ebf-0","kind":"heading","span":{"start":33403,"end":33451},"html":"<h3>4.2 Stylesheet (<code>src/styles/focus-mask.css</code>)</h3>"},"P-db75d70f-0":{"id":"P-db75d70f-0","level":0,"parent":"S-1b3f5ebf-0","kind":"code","span":{"start":33453,"end":35626},"html":"<pre><code class=\"language-css\">/* ---------- Focus masking: the spotlight ---------- */\n\n.pgroup {\n  opacity: 1;\n  /* ONLY opacity transitions. It is compositor-driven in WebKit:\n     no layout, no paint, runs off the main thread. */\n  transition: opacity 200ms linear;\n}\n\n/* Promote to its own layer ONLY while a transition can occur.\n   Applied via [data-transitioning] on #viewport during the 200ms window,\n   removed on transitionend — permanent will-change wastes VRAM on long docs. */\n#viewport[data-transitioning] .pgroup {\n  will-change: opacity;\n}\n\n/* Layout containment (D8): permits WebKit to skip layout/paint of\n   far-off-screen groups. This is what makes the two-frame zoom mount\n   (§2.5) and keyed hot-reload (§5.3) cheap on 10k-paragraph documents. */\n.pgroup {\n  content-visibility: auto;\n  contain-intrinsic-size: auto 480px;  /* placeholder; browser corrects after first render */\n}\n\n.pgroup[data-dimmed] {\n  opacity: 0.35;\n  /* Contrast/saturation is an INSTANT class swap, not a transition (D1).\n     The 200ms opacity crossfade perceptually masks the step change.\n     Transitioning filter would repaint every frame — visible jank on\n     documents with many highlighted code blocks. */\n  filter: contrast(0.8) saturate(0.55);\n}\n\n/* Cheaper alternative for syntax colors: token remap via custom properties.\n   If profiling shows filter cost on very large docs, drop `filter` from\n   .pgroup[data-dimmed] and rely on this block alone. */\n.pgroup[data-dimmed] {\n  --tok-keyword:  var(--dim-fg);\n  --tok-string:   var(--dim-fg);\n  --tok-function: var(--dim-fg);\n  --tok-comment:  var(--dim-fg-faint);\n  --tok-number:   var(--dim-fg);\n}\n\n/* ---------- Level crossfade (zoom transitions, §2.5) ---------- */\n\n.level-layer {\n  position: absolute;\n  inset: 0;\n  overflow-y: auto;\n  opacity: 1;\n  transition: opacity 200ms linear;\n}\n.level-layer[data-entering] { opacity: 0; }   /* mounted hidden, then flipped */\n.level-layer[data-leaving]  { opacity: 0; }\n\n/* ---------- Tokens ---------- */\n:root {\n  --dim-fg: #8a8f98;\n  --dim-fg-faint: #a6abb3;\n  color-scheme: light dark;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .pgroup, .level-layer { transition: none; }\n}\n</code></pre>","lang":"css"},"P-1ca32305-0":{"id":"P-1ca32305-0","level":0,"parent":"S-1b3f5ebf-0","kind":"heading","span":{"start":35628,"end":35653},"html":"<h3>4.3 Focus-mask module</h3>"},"P-42dcfa1c-0":{"id":"P-42dcfa1c-0","level":0,"parent":"S-1b3f5ebf-0","kind":"code","span":{"start":35655,"end":36767},"html":"<pre><code class=\"language-ts\">// src/ui/focus-mask.ts\nimport { select } from &#39;../state/store&#39;;\n\nexport function mountFocusMask(viewport: HTMLElement): () =&gt; void {\n  let prevSid: string | null = null;\n\n  const sub = select((s) =&gt; {\n    if (!s.doc || !s.index || !s.activeGroupHead) return null;\n    return s.index.parentOfParagraph.get(s.activeGroupHead) ?? null;\n  }).subscribe((sid) =&gt; {\n    if (sid === prevSid) return;\n    viewport.setAttribute(&#39;data-transitioning&#39;, &#39;&#39;);\n\n    if (prevSid) {\n      viewport.querySelector(`.pgroup[data-sid=&quot;${prevSid}&quot;]`)\n        ?.setAttribute(&#39;data-dimmed&#39;, &#39;&#39;);\n    }\n    viewport.querySelector(`.pgroup[data-sid=&quot;${sid}&quot;]`)\n      ?.removeAttribute(&#39;data-dimmed&#39;);\n\n    // Initial spotlight: dim everything except the active group, once.\n    if (prevSid === null) {\n      viewport.querySelectorAll(`.pgroup:not([data-sid=&quot;${sid}&quot;])`)\n        .forEach((g) =&gt; g.setAttribute(&#39;data-dimmed&#39;, &#39;&#39;));\n    }\n    prevSid = sid;\n\n    viewport.addEventListener(&#39;transitionend&#39;,\n      () =&gt; viewport.removeAttribute(&#39;data-transitioning&#39;),\n      { once: true });\n  });\n\n  return () =&gt; sub.unsubscribe();\n}\n</code></pre>","lang":"ts"},"P-2f654324-0":{"id":"P-2f654324-0","level":0,"parent":"S-1b3f5ebf-0","kind":"heading","span":{"start":36769,"end":37073},"html":"<h2><strong>Acceptance test for this system:</strong> open a 5,000-line agent log with ~40 code blocks, hold ⌥ and arrow the caret across group boundaries continuously for 10 s. Instruments → Core Animation must show no main-thread frame &gt; 8 ms attributable to the mask, and no memory growth from layer promotion.</h2>"},"P-49b7e81c-0":{"id":"P-49b7e81c-0","level":0,"parent":"S-49b7e81c-0","kind":"heading","span":{"start":37075,"end":37116},"html":"<h2>5. Rust File Watcher Module (System D)</h2>"},"P-0d78d56e-0":{"id":"P-0d78d56e-0","level":0,"parent":"S-49b7e81c-0","kind":"heading","span":{"start":37118,"end":37154},"html":"<h3>5.1 Design notes before the code</h3>"},"P-8a9c5517-0":{"id":"P-8a9c5517-0","level":0,"parent":"S-49b7e81c-0","kind":"list","span":{"start":37156,"end":37862},"html":"<ul>\n<li><strong>Watch the parent directory, not the file</strong> (D5). VS Code, Cursor, and most agents save atomically: write <code>file.md.tmp</code> → rename over <code>file.md</code>. A watch on the file path dies at the rename. A non-recursive watch on the parent dir survives it.</li>\n<li><strong>500 ms debounce</strong> via <code>notify-debouncer-mini</code> collapses the tmp-write/rename/metadata burst — and multi-chunk agent appends — into one event.</li>\n<li><strong>Hash before you reload.</strong> Editors touch mtimes without changing bytes. The command layer compares SHA-256 against the last loaded hash and drops no-ops, so the UI never flickers for nothing.</li>\n<li><strong>Never block the notify callback.</strong> It runs on the watcher&#39;s own thread; do nothing there but filter and emit.</li>\n</ul>"},"P-5ca35b4b-0":{"id":"P-5ca35b4b-0","level":0,"parent":"S-49b7e81c-0","kind":"heading","span":{"start":37864,"end":37925},"html":"<h3>5.2 Implementation (<code>src-tauri/src/watcher/debounced.rs</code>)</h3>"},"P-a9a0d31a-0":{"id":"P-a9a0d31a-0","level":0,"parent":"S-49b7e81c-0","kind":"code","span":{"start":37927,"end":40808},"html":"<pre><code class=\"language-rust\">use std::path::{Path, PathBuf};\nuse std::sync::Mutex;\nuse std::time::Duration;\n\nuse notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};\nuse notify_debouncer_mini::notify::RecommendedWatcher;\nuse tauri::{AppHandle, Emitter, Manager};\n\n/// Held in Tauri managed state. Dropping the debouncer stops the watch,\n/// so replacing the Option releases the previous directory automatically\n/// when the user opens a file elsewhere.\npub struct WatcherState {\n    pub debouncer: Mutex&lt;Option&lt;Debouncer&lt;RecommendedWatcher&gt;&gt;&gt;,\n    /// The single file we actually care about within the watched dir.\n    pub target: Mutex&lt;Option&lt;PathBuf&gt;&gt;,\n}\n\nimpl Default for WatcherState {\n    fn default() -&gt; Self {\n        Self { debouncer: Mutex::new(None), target: Mutex::new(None) }\n    }\n}\n\n#[tauri::command]\npub fn watch_directory(app: AppHandle, path: String) -&gt; Result&lt;(), String&gt; {\n    let target = PathBuf::from(&amp;path);\n    let dir = target\n        .parent()\n        .ok_or_else(|| &quot;path has no parent directory&quot;.to_string())?\n        .to_path_buf();\n\n    let app_for_cb = app.clone();\n    let target_for_cb = target.clone();\n\n    // 500ms debounce window: rapid write bursts (atomic saves, partial\n    // flushes, agent appends) collapse into a single DebounceEvent batch.\n    let mut debouncer = new_debouncer(\n        Duration::from_millis(500),\n        move |res: DebounceEventResult| match res {\n            Ok(events) =&gt; {\n                // Cheap filter ON the watcher thread; heavy work OFF it.\n                let relevant = events.iter().any(|e| {\n                    e.path == target_for_cb\n                        || is_atomic_sibling(&amp;e.path, &amp;target_for_cb)\n                });\n                if relevant {\n                    // Fire-and-forget notification; the frontend decides\n                    // when/how to reload. No modal, no diff screen.\n                    let _ = app_for_cb.emit(&quot;doc://changed&quot;, ());\n                }\n            }\n            Err(e) =&gt; eprintln!(&quot;[watcher] error: {e:?}&quot;),\n        },\n    )\n    .map_err(|e| e.to_string())?;\n\n    debouncer\n        .watcher()\n        .watch(&amp;dir, RecursiveMode::NonRecursive)\n        .map_err(|e| e.to_string())?;\n\n    let state = app.state::&lt;WatcherState&gt;();\n    *state.target.lock().unwrap() = Some(target);\n    // Replacing the old debouncer drops it → previous watch is released.\n    *state.debouncer.lock().unwrap() = Some(debouncer);\n    Ok(())\n}\n\n/// Atomic saves surface as events on `file.md.tmp`, `.file.md.swp`, etc.\n/// Treat any event whose file stem contains the target&#39;s file name as\n/// belonging to the target.\nfn is_atomic_sibling(event_path: &amp;Path, target: &amp;Path) -&gt; bool {\n    match (event_path.file_name(), target.file_name()) {\n        (Some(ev), Some(t)) =&gt; ev.to_string_lossy().contains(&amp;*t.to_string_lossy()),\n        _ =&gt; false,\n    }\n}\n</code></pre>","lang":"rust"},"P-09db431d-0":{"id":"P-09db431d-0","level":0,"parent":"S-49b7e81c-0","kind":"prose","span":{"start":40810,"end":40835},"html":"<p>Registration in <code>lib.rs</code>:</p>"},"P-73805a32-0":{"id":"P-73805a32-0","level":0,"parent":"S-49b7e81c-0","kind":"code","span":{"start":40837,"end":41233},"html":"<pre><code class=\"language-rust\">pub fn run() {\n    tauri::Builder::default()\n        .manage(crate::watcher::debounced::WatcherState::default())\n        .invoke_handler(tauri::generate_handler![\n            crate::commands::document::load_document,\n            crate::watcher::debounced::watch_directory,\n        ])\n        .run(tauri::generate_context!())\n        .expect(&quot;error while running tauri application&quot;);\n}\n</code></pre>","lang":"rust"},"P-300b2309-0":{"id":"P-300b2309-0","level":0,"parent":"S-300b2309-0","kind":"heading","span":{"start":41235,"end":41289},"html":"<h3>5.3 The silent hot-reload contract (frontend side)</h3>"},"P-8ec877b8-0":{"id":"P-8ec877b8-0","level":0,"parent":"S-300b2309-0","kind":"prose","span":{"start":41291,"end":41365},"html":"<p>On <code>doc://changed</code> the reducer/effect chain (§3.2, row 3) does, in order:</p>"},"P-e354f354-0":{"id":"P-e354f354-0","level":0,"parent":"S-300b2309-0","kind":"list","span":{"start":41367,"end":43070},"html":"<ol>\n<li><code>invoke(&#39;load_document&#39;, { path })</code> — Rust re-reads and re-extracts.</li>\n<li>Compare <code>docHash</code>; identical → drop silently. <strong>No UI change at all.</strong></li>\n<li>Different → swap <code>doc</code> + rebuilt <code>index</code> in a single <code>DOC_LOADED</code> action (one store emission ⇒ one render pass).</li>\n<li><strong>Keyed reconciliation, not a rebuild (D7):</strong> iterate the new <code>order.sections</code> against a <code>Map&lt;sid, HTMLElement&gt;</code> kept from the previous render. A group whose <code>S</code>-id <em>and</em> full child-ID list are unchanged keeps its DOM node untouched; only inserted/changed groups are built, only removed ones unmounted. Because IDs are content hashes (D6), &quot;unchanged ID list&quot; literally means &quot;unchanged bytes&quot; — an agent appending 50 paragraphs touches only the appended groups, and the full-document rebuild that would blow the 250ms budget never occurs.</li>\n<li>Caret restoration, tiered:<ul>\n<li><strong>(a)</strong> the exact old ID <code>P-&lt;h&gt;-&lt;k&gt;</code> exists in the new table → keep caret and spotlight (same bytes, same occurrence).</li>\n<li><strong>(b)</strong> hash <code>&lt;h&gt;</code> exists but its occurrence count changed (an identical block was inserted/removed among duplicates) → disambiguate by <strong>context hash</strong>: prefer the candidate whose prev/next sibling hashes match the old neighbors&#39;; if still ambiguous, take the occurrence nearest the caret&#39;s old document-position ratio. (Identical block, identical context — the choices are semantically interchangeable.)</li>\n<li><strong>(c)</strong> hash gone (the paragraph was edited) → move caret to the parent <code>S</code>&#39;s first surviving child; parent gone too → clear caret, preserve scroll by ratio (<code>scrollTop / scrollHeight</code>).</li>\n</ul>\n</li>\n<li>A 1.5 s non-modal &quot;Updated&quot; pill in the corner is the <em>only</em> permitted feedback. No modals, no diff view — per spec.</li>\n</ol>"},"P-1c2f51c0-0":{"id":"P-1c2f51c0-0","level":0,"parent":"S-1c2f51c0-0","kind":"heading","span":{"start":43077,"end":43154},"html":"<h2>6. System E — Self-Contained HTML Export (design only; build in Phase 2)</h2>"},"P-fef728d7-0":{"id":"P-fef728d7-0","level":0,"parent":"S-1c2f51c0-0","kind":"prose","span":{"start":43156,"end":43270},"html":"<p>Phase 1 must not implement this, but the Phase 1 architecture is shaped so Phase 2 is an afternoon, not a rewrite:</p>"},"P-64fbfe58-0":{"id":"P-64fbfe58-0","level":0,"parent":"S-1c2f51c0-0","kind":"list","span":{"start":43272,"end":43982},"html":"<ul>\n<li>The exporter is a pure function <code>(LookupTable, raw) → string</code>. Because <em>all</em> view logic reads only the lookup table (never the file system), the web export reuses <code>anchor.ts</code>, <code>focus-mask.ts</code>, and the CSS verbatim.</li>\n<li>Build step produces <code>export-template.html</code> with two placeholders: <code>/*__STYLES__*/</code> (minified CSS from <code>src/styles/</code>) and <code>window.__SZ_DATA__ = /*__DATA__*/</code> (the lookup table + raw text, JSON-embedded).</li>\n<li>A Vite library build target (<code>vite build --config vite.export.config.ts</code>) bundles a slimmed <code>main-export.ts</code> (no Tauri imports, no watcher, no Engine B) to a single IIFE inlined into the template.</li>\n<li>Zero network requests, zero external fonts (system font stack), works from <code>file://</code>.</li>\n</ul>"},"P-9a0c5f90-0":{"id":"P-9a0c5f90-0","level":0,"parent":"S-1c2f51c0-0","kind":"prose","span":{"start":43984,"end":44170},"html":"<p><strong>Phase-1 obligation only:</strong> keep every module the exporter needs free of <code>@tauri-apps/*</code> imports. Enforce with an ESLint <code>no-restricted-imports</code> rule on <code>src/engine/**</code> and <code>src/ui/**</code>.</p>"},"P-d35e24c6-0":{"id":"P-d35e24c6-0","level":0,"parent":"S-d35e24c6-0","kind":"heading","span":{"start":44177,"end":44214},"html":"<h2>7. Phased 3-Week Developer Backlog</h2>"},"P-3cca7974-0":{"id":"P-3cca7974-0","level":0,"parent":"S-d35e24c6-0","kind":"prose","span":{"start":44216,"end":44494},"html":"<p>Sequencing rule: nothing in a later milestone starts until the previous milestone&#39;s acceptance criteria pass. Phase 1 = rendering the three levels, spatial anchoring, focus masking, file monitoring. Engines beyond the Engine B stub, export, and any settings UI are out of scope.</p>"},"P-c7a54935-0":{"id":"P-c7a54935-0","level":0,"parent":"S-d35e24c6-0","kind":"heading","span":{"start":44496,"end":44549},"html":"<h3>Week 1 — Skeleton, contract, and the happy path</h3>"},"P-bfc3553c-0":{"id":"P-bfc3553c-0","level":0,"parent":"S-d35e24c6-0","kind":"prose","span":{"start":44551,"end":45638},"html":"<table>\n<thead>\n<tr>\n<th>#</th>\n<th>Task</th>\n<th>Done when</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1.1</td>\n<td>Scaffold Tauri v2 + vanilla-TS workspace, directory layout from §1, macOS overlay title bar</td>\n<td><code>npm run tauri dev</code> opens a styled empty window</td>\n</tr>\n<tr>\n<td>1.2</td>\n<td>Define <code>schema.ts</code>, Rust mirror structs, <code>validate()</code>, JSON Schema doc; commit <code>docs/payload-format.md</code></td>\n<td>Round-trip test: sample payload → Rust parse → <code>validate()</code> + <code>verify_ids()</code> → frontend <code>buildIndex()</code> passes</td>\n</tr>\n<tr>\n<td>1.3</td>\n<td><code>load_document</code> command + Engine A extraction (§2.6) with <code>LoadResult</code> enum</td>\n<td>Tagged file renders <code>Native</code>; untagged renders <code>Untagged</code>; broken JSON renders <code>Corrupt</code> — unit tests for all three</td>\n</tr>\n<tr>\n<td>1.4</td>\n<td>Hand-author one realistic fixture: a genuine AI implementation-plan .md (~300 lines, 10+ code blocks) with a hand-built payload</td>\n<td>Fixture passes JSON Schema validation; lives in <code>fixtures/</code></td>\n</tr>\n<tr>\n<td>1.5</td>\n<td>Static rendering of all three levels from the lookup table (no transitions yet); slider with three detents switching levels instantly</td>\n<td>All three levels render correct content for the fixture; slider disabled states work for <code>Untagged</code></td>\n</tr>\n</tbody></table>"},"P-9348b695-0":{"id":"P-9348b695-0","level":0,"parent":"S-d35e24c6-0","kind":"heading","span":{"start":45640,"end":45690},"html":"<h3>Week 2 — Spatial anchoring, caret, spotlight</h3>"},"P-114fe72e-0":{"id":"P-114fe72e-0","level":0,"parent":"S-d35e24c6-0","kind":"prose","span":{"start":45692,"end":46575},"html":"<table>\n<thead>\n<tr>\n<th>#</th>\n<th>Task</th>\n<th>Done when</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>2.1</td>\n<td>RxJS store, actions, selectors, subscription-hygiene pattern (§3)</td>\n<td>Caret moves don&#39;t re-render slider (verify with a render counter in dev)</td>\n</tr>\n<tr>\n<td>2.2</td>\n<td>Read-only caret: click-to-place + arrow-key traversal across <code>.pnode</code>s</td>\n<td>Caret id/offset visible in a dev HUD</td>\n</tr>\n<tr>\n<td>2.3</td>\n<td>Anchor engine (§2.5): resolution, cross-level mapping tables, <code>lastCaretIn</code>/<code>lastAnchorIn</code> memory</td>\n<td>Unit tests for all 6 level-pair mappings incl. the two-hop −2 ↔ 0</td>\n</tr>\n<tr>\n<td>2.4</td>\n<td>Two-layer zoom transition: off-screen mount → pre-scroll → 200ms crossfade → unmount</td>\n<td>Reading in P₃ → slide to −1 → S₂ arrives top-aligned, zero visible scroll motion; reverse restores P₃</td>\n</tr>\n<tr>\n<td>2.5</td>\n<td>Focus mask (§4): group DOM structure, <code>data-dimmed</code> toggling, token remap</td>\n<td>Instruments acceptance test in §4.3 passes on the 5,000-line stress fixture</td>\n</tr>\n</tbody></table>"},"P-fba350b0-0":{"id":"P-fba350b0-0","level":0,"parent":"S-d35e24c6-0","kind":"heading","span":{"start":46577,"end":46622},"html":"<h3>Week 3 — Watcher, hot reload, hardening</h3>"},"P-c328902b-0":{"id":"P-c328902b-0","level":0,"parent":"S-d35e24c6-0","kind":"prose","span":{"start":46624,"end":47816},"html":"<table>\n<thead>\n<tr>\n<th>#</th>\n<th>Task</th>\n<th>Done when</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>3.1</td>\n<td>Watcher module (§5) wired to <code>doc://changed</code></td>\n<td>Editing the file in VS Code (atomic save) and via <code>echo &gt;&gt;</code> (append) both fire exactly one event per burst</td>\n</tr>\n<tr>\n<td>3.2</td>\n<td>Silent hot-reload state sync (§5.3): hash short-circuit, keyed group reuse, tiered caret restoration</td>\n<td>Agent appends 50 paragraphs AND inserts 5 at the top mid-session: unchanged groups keep DOM node identity (assert in dev HUD), caret stays on the same <em>content</em>, no modal</td>\n</tr>\n<tr>\n<td>3.3</td>\n<td>Engine B stub + degraded-state UX: disabled detents, &quot;no summary&quot; affordance, <code>Corrupt</code> warning badge</td>\n<td>Loading any random README from disk is a calm, non-broken experience</td>\n</tr>\n<tr>\n<td>3.4</td>\n<td>Perf pass: 1 MB / 10k-paragraph synthetic doc — startup, zoom transition, mask latency budgets (≤10 ms extract, ≤16 ms mask frame, ≤250 ms level swap end-to-end)</td>\n<td>Numbers recorded in <code>docs/perf-baseline.md</code></td>\n</tr>\n<tr>\n<td>3.5</td>\n<td>Packaging: <code>tauri build</code> → signed <code>.dmg</code> (ad-hoc signing acceptable for Phase 1), smoke test on a clean machine</td>\n<td>Fresh install opens the fixture correctly</td>\n</tr>\n<tr>\n<td>3.6</td>\n<td>Buffer / bug-fix. Explicitly scheduled — Week 3 always overruns otherwise</td>\n<td>Issue tracker at zero P0/P1</td>\n</tr>\n</tbody></table>"},"P-e572cd25-0":{"id":"P-e572cd25-0","level":0,"parent":"S-d35e24c6-0","kind":"heading","span":{"start":47818,"end":47874},"html":"<h3>Explicit non-goals for Phase 1 (defer without guilt)</h3>"},"P-8410502b-0":{"id":"P-8410502b-0","level":0,"parent":"S-d35e24c6-0","kind":"prose","span":{"start":47876,"end":48114},"html":"<p>Engine B synthesis, Ollama integration, prompt templates; HTML export (System E) beyond the import-hygiene lint rule; multi-document tabs; editing of any kind (the caret is read-only by design); Windows/Linux targets; theming/settings UI.</p>"},"P-22785af6-0":{"id":"P-22785af6-0","level":0,"parent":"S-22785af6-0","kind":"heading","span":{"start":48121,"end":48185},"html":"<h2>8. Engine B — Remote LLM Synthesis (Phase 2/3 addendum, D9)</h2>"},"P-f146a17d-0":{"id":"P-f146a17d-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":48187,"end":48717},"html":"<p><strong>Status: architecture only, not started.</strong> This section does not begin until the Phase 1 backlog (§7) is complete — Engine B ships as the stub in §2.7 until then. It documents the design for generating the missing k=−1/−2 levels via a remote LLM API (model TBD, e.g. a MiMo-v2.5-Pro-class endpoint — kept swappable, since D3 already shows model recommendations here have superseded each other once) plus the API-key settings dialog, and formalizes the deviation from D3/§2.7&#39;s local-Ollama-only design as <strong>D9</strong> (§0).</p>"},"P-f1c59594-0":{"id":"P-f1c59594-0","level":0,"parent":"S-22785af6-0","kind":"heading","span":{"start":48719,"end":48782},"html":"<h3>8.1 Why this doesn&#39;t slot into the existing three crossings</h3>"},"P-de1a9533-0":{"id":"P-de1a9533-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":48784,"end":49226},"html":"<p>§1&#39;s rule — <em>&quot;Rust owns disk truth, TypeScript owns view truth, exactly three crossings&quot;</em> — held because Phase 1 has no secrets and no network egress. Remote synthesis introduces both. Two new Tauri commands are unavoidable, but everything that depends on Tauri for this feature is isolated into a <strong>new top-level directory, <code>src/native/</code></strong>, which sits outside the <code>no-restricted-imports</code> glob (<code>src/engine/**</code>, <code>src/ui/**</code>). This means:</p>"},"P-afd46b82-0":{"id":"P-afd46b82-0","level":0,"parent":"S-22785af6-0","kind":"list","span":{"start":49228,"end":49687},"html":"<ul>\n<li>The existing lint rule is <strong>not modified or excepted</strong> — it still means what it always meant.</li>\n<li>System E&#39;s static export (§6), which reuses <code>src/engine/**</code> + <code>src/ui/**</code> verbatim, is <strong>structurally incapable</strong> of pulling in the API-key or network code, because that code was never placed under those directories in the first place. No exception list to keep in sync, no risk of a future refactor accidentally dragging a secret into an exported HTML file.</li>\n</ul>"},"P-9a0daf15-0":{"id":"P-9a0daf15-0","level":0,"parent":"S-22785af6-0","kind":"code","span":{"start":49689,"end":50335},"html":"<pre><code>src/\n  engine/\n    engine-b.ts            # UNCHANGED: Synthesizer interface + stubSynthesizer (§2.7)\n  native/                  # NEW — Tauri-dependent, excluded from System E export\n    engine-b-remote.ts      # real Synthesizer impl; invoke(&#39;synthesize_levels&#39;, ...)\n    settings-window.ts      # opens/bootstraps the Settings window\n    settings-form.ts        # form logic — never retains the raw key past Save\nsrc-tauri/src/commands/\n  secrets.rs                # NEW: save_api_key / get_api_key_status / delete_api_key\n  synthesize.rs             # NEW: synthesize_levels — HTTP call + validate() + verify_ids() + write-back\n</code></pre>"},"P-a4cc4027-0":{"id":"P-a4cc4027-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":50337,"end":50578},"html":"<p><code>main.ts</code> (which already legitimately imports <code>@tauri-apps/*</code>) is the only place that chooses between <code>stubSynthesizer</code> and the real <code>src/native/engine-b-remote.ts</code> implementation — <code>engine-b.ts</code>&#39;s interface contract doesn&#39;t change at all.</p>"},"P-74cbda9d-0":{"id":"P-74cbda9d-0","level":0,"parent":"S-22785af6-0","kind":"heading","span":{"start":50580,"end":50636},"html":"<h3>8.2 API key: Rust-owned secret, never in the webview</h3>"},"P-69a485a5-0":{"id":"P-69a485a5-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":50638,"end":50859},"html":"<p>The key must never exist in JS state longer than the instant it&#39;s typed, or it inherits every risk of the untrusted webview context (inspectable, and structurally reusable by the System E exporter if the code ever moved).</p>"},"P-2d662b23-0":{"id":"P-2d662b23-0","level":0,"parent":"S-22785af6-0","kind":"code","span":{"start":50861,"end":51460},"html":"<pre><code class=\"language-rust\">// src-tauri/src/commands/secrets.rs\nuse keyring::Entry;\n\nconst SERVICE: &amp;str = &quot;com.semantic-zoom.llm-api-key&quot;;\n\n#[tauri::command]\npub fn save_api_key(key: String) -&gt; Result&lt;(), String&gt; {\n    Entry::new(SERVICE, &quot;default&quot;).and_then(|e| e.set_password(&amp;key)).map_err(|e| e.to_string())\n}\n\n#[tauri::command]\npub fn get_api_key_status() -&gt; bool {\n    Entry::new(SERVICE, &quot;default&quot;).and_then(|e| e.get_password()).is_ok()\n}\n\n#[tauri::command]\npub fn delete_api_key() -&gt; Result&lt;(), String&gt; {\n    Entry::new(SERVICE, &quot;default&quot;).and_then(|e| e.delete_credential()).map_err(|e| e.to_string())\n}\n</code></pre>","lang":"rust"},"P-b0067727-0":{"id":"P-b0067727-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":51462,"end":51683},"html":"<p><code>get_api_key_status</code> returns a bool, never the key. <code>Cargo.toml</code>: <code>cargo add keyring</code>. Uses macOS Keychain Services under the hood — consistent with §1&#39;s macOS-only Phase 1 target, no cross-platform abstraction needed.</p>"},"P-3da22a9b-0":{"id":"P-3da22a9b-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":51685,"end":52060},"html":"<p><code>src/native/settings-form.ts</code> (sketch): a text input, a Save button that calls <code>invoke(&#39;save_api_key&#39;, { key: input.value })</code> then immediately clears <code>input.value</code> and never assigns it to any variable that outlives the handler; a status line driven by <code>invoke(&#39;get_api_key_status&#39;)</code> on mount (<code>&quot;API key saved ✓&quot;</code> / <code>&quot;No key set&quot;</code>); a Remove button calling <code>delete_api_key</code>.</p>"},"P-fd1140ed-0":{"id":"P-fd1140ed-0","level":0,"parent":"S-22785af6-0","kind":"heading","span":{"start":52062,"end":52085},"html":"<h3>8.3 Settings window</h3>"},"P-b6f6515d-0":{"id":"P-b6f6515d-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":52087,"end":52233},"html":"<p>A second native Tauri window (per the clarifying answer — not an in-app modal), opened from a menu item (<code>Semantic Zoom → Settings…</code>, ⌘,):</p>"},"P-b10bbbf6-0":{"id":"P-b10bbbf6-0","level":0,"parent":"S-22785af6-0","kind":"code","span":{"start":52235,"end":52774},"html":"<pre><code class=\"language-rust\">// src-tauri/src/commands/window.rs (or inline in a menu event handler)\n#[tauri::command]\npub fn open_settings_window(app: tauri::AppHandle) -&gt; Result&lt;(), String&gt; {\n    if app.get_webview_window(&quot;settings&quot;).is_some() { return Ok(()); } // focus, don&#39;t duplicate\n    tauri::WebviewWindowBuilder::new(&amp;app, &quot;settings&quot;, tauri::WebviewUrl::App(&quot;settings.html&quot;.into()))\n        .title(&quot;Settings&quot;)\n        .inner_size(420.0, 220.0)\n        .resizable(false)\n        .build()\n        .map(|_| ())\n        .map_err(|e| e.to_string())\n}\n</code></pre>","lang":"rust"},"P-08cc871f-0":{"id":"P-08cc871f-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":52776,"end":52976},"html":"<p><code>settings.html</code> is a second Vite entry point bundling only <code>src/native/settings-form.ts</code> — it never loads the document viewport, store, or engine modules, so it has nothing to leak even by accident.</p>"},"P-20f79806-0":{"id":"P-20f79806-0","level":0,"parent":"S-22785af6-0","kind":"heading","span":{"start":52978,"end":53024},"html":"<h3>8.4 Generation command and disk write-back</h3>"},"P-211a1bf0-0":{"id":"P-211a1bf0-0","level":0,"parent":"S-22785af6-0","kind":"code","span":{"start":53026,"end":54333},"html":"<pre><code class=\"language-rust\">// src-tauri/src/commands/synthesize.rs\n#[tauri::command]\npub async fn synthesize_levels(path: String, raw: String, doc_hash: String) -&gt; Result&lt;LookupTable, String&gt; {\n    let key = Entry::new(SERVICE, &quot;default&quot;)\n        .and_then(|e| e.get_password())\n        .map_err(|_| &quot;No API key configured&quot;.to_string())?;\n\n    let table = call_remote_llm(&amp;key, &amp;raw).await?;   // builds S/M layers only; P-nodes untouched\n    table.validate()?;\n    table.verify_ids(&amp;raw)?;                          // same gate Engine A payloads pass through\n\n    // Write-back is only safe if the file is unchanged since we read it —\n    // otherwise we&#39;d silently clobber an edit made while the request was in flight.\n    let current = std::fs::read_to_string(&amp;path).map_err(|e| e.to_string())?;\n    if sha256_hex(&amp;current) == doc_hash {\n        std::fs::write(&amp;path, append_payload_marker(&amp;current, &amp;table)).map_err(|e| e.to_string())?;\n    }\n    // Hash still matches → docHash covers only bytes preceding the marker (A1), so this\n    // append doesn&#39;t change it. The watcher&#39;s own debounced `doc://changed` fires next,\n    // load_document re-extracts as `Native`, and the existing hash short-circuit (§5.3\n    // step 2) means the reload is a no-op from the user&#39;s point of view — no flicker.\n    Ok(table)\n}\n</code></pre>","lang":"rust"},"P-1a010a77-0":{"id":"P-1a010a77-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":54335,"end":54650},"html":"<p>If the hash doesn&#39;t match (user edited the file mid-request), the result is returned to the frontend for the current session only and <em>not</em> written to disk — silently overwriting a concurrent edit would violate the &quot;fixtures/user files are never mutated behind their back&quot; spirit even though this isn&#39;t a fixture.</p>"},"P-ab2f8705-0":{"id":"P-ab2f8705-0","level":0,"parent":"S-22785af6-0","kind":"heading","span":{"start":54652,"end":54700},"html":"<h3>8.5 Frontend flow and visible trust boundary</h3>"},"P-571e5b5b-0":{"id":"P-571e5b5b-0","level":0,"parent":"S-22785af6-0","kind":"list","span":{"start":54702,"end":55890},"html":"<ul>\n<li><code>DocStatus</code> (§3.1) gains <code>&#39;synthesizing&#39;</code>. Slider&#39;s −1/−2 detents, when the doc is <code>Untagged</code> and <code>get_api_key_status()</code> is true, show a &quot;Generate&quot; affordance instead of being permanently disabled (§2.7&#39;s stub UX still applies verbatim when no key is set).</li>\n<li>Clicking it calls <code>invoke(&#39;synthesize_levels&#39;, ...)</code>; success merges the returned <code>meta</code>/<code>sections</code> into the existing table via the same <code>DOC_LOADED</code>-shaped action (paragraphs/spans are never touched by Engine B — k=0 truth stays Engine A&#39;s alone). Failure surfaces as the same calm, non-modal toast pattern as the existing <code>Corrupt</code> badge (§5.3 step 6) — no popups, no diff view, per the spec&#39;s UX tone.</li>\n<li><strong>Visible consent, not a buried network call:</strong> the Generate affordance&#39;s tooltip states plainly that generating sends the document&#39;s text to the configured API. This is the one place Phase 1&#39;s &quot;100% local, zero network egress&quot; property changes, and it must be legible to the user at the point of action, not just in a settings screen they may never open.</li>\n<li>Mid-flight cancellation reuses the existing <code>switchMap</code>-abort pattern (§3.2 row 1): a hot reload or a new generation request aborts the in-flight one.</li>\n</ul>"},"P-17199162-0":{"id":"P-17199162-0","level":0,"parent":"S-22785af6-0","kind":"heading","span":{"start":55892,"end":55944},"html":"<h3>8.6 Product calls — locked by D10 (2026-07-15)</h3>"},"P-3a4e7368-0":{"id":"P-3a4e7368-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":55946,"end":56145},"html":"<p>These were open questions at the time this section was first drafted; D10 (§0) resolves all three, so the build plan at <code>.claude/plans/tingly-munching-papert.md</code> proceeds without re-litigating them:</p>"},"P-afa7b29a-0":{"id":"P-afa7b29a-0","level":0,"parent":"S-22785af6-0","kind":"list","span":{"start":56147,"end":56717},"html":"<ul>\n<li><strong>Token/cost ceiling:</strong> v1 refuses documents over the model&#39;s context limit with a clear message. No silent truncation or chunking.</li>\n<li><strong>Regenerate affordance:</strong> allowed only for <code>Untagged</code> documents. Re-running Engine B to overwrite an existing <code>Native</code> payload&#39;s −1/−2 layers is explicitly out of scope for v1.</li>\n<li><strong>Provider abstraction:</strong> built as a small config record (<code>kind</code>, <code>base_url</code>, <code>model</code>, <code>needs_key</code>) against one OpenAI-compatible HTTP client, exactly the recommended option — covers Remote, Ollama, and llama.cpp without a code change per provider.</li>\n</ul>"},"P-bc6ea6a1-0":{"id":"P-bc6ea6a1-0","level":0,"parent":"S-22785af6-0","kind":"prose","span":{"start":56724,"end":56957},"html":"<p><em>End of Phase 1 plan. The contract files (<code>schema.ts</code>, Rust mirrors, <code>docs/payload-format.md</code>) are the spine — get 1.2 reviewed before anything downstream is written. §8 is a Phase 2/3 addendum and does not gate any Phase 1 task.</em></p>"}},"order":{"meta":["M1","M2","M3"],"sections":["S-ab80d77b-0","S-02a9a62b-0","S-10c7677d-0","S-247821b0-0","S-d31de407-0","S-ee486a4c-0","S-a58b0af4-0","S-107a589f-0","S-728d4905-0","S-3008a382-0","S-1b3f5ebf-0","S-49b7e81c-0","S-300b2309-0","S-1c2f51c0-0","S-d35e24c6-0","S-22785af6-0"],"paragraphs":["P-ab80d77b-0","P-9968bd92-0","P-8ae20742-0","P-02a9a62b-0","P-37dbe0aa-0","P-10c7677d-0","P-1884396f-0","P-7f848a7c-0","P-426c826a-0","P-214c21cd-0","P-ab96a5d5-0","P-efe43533-0","P-247821b0-0","P-6544cffb-0","P-b6964e17-0","P-e9ef5093-0","P-0ca10484-0","P-dce65e70-0","P-4f526662-0","P-7399460d-0","P-51791ee0-0","P-48146d99-0","P-a11c9145-0","P-06f1b7f0-0","P-25303dcb-0","P-12c11aa4-0","P-d5b53fc4-0","P-d31de407-0","P-00d5fbab-0","P-008ca03f-0","P-ca109407-0","P-70dd8e4a-0","P-502f0f91-0","P-77118bee-0","P-660d40ea-0","P-5b6c485e-0","P-91fae7d2-0","P-d4f59cdc-0","P-576ba68c-0","P-c9814357-0","P-8843e0bc-0","P-b54687e6-0","P-ee486a4c-0","P-33c457d3-0","P-b2935767-0","P-77c00e38-0","P-93aa020a-0","P-e2c39228-0","P-94fdc8ab-0","P-81549238-0","P-1c46255b-0","P-4dbc906d-0","P-85ec2bf4-0","P-578ab58e-0","P-dc27c7b0-0","P-0985edd1-0","P-5c319197-0","P-fdc99993-0","P-a58b0af4-0","P-e37870b4-0","P-d441390a-0","P-e87fc865-0","P-107a589f-0","P-b0470403-0","P-55039efb-0","P-48949622-0","P-7d11bea5-0","P-728d4905-0","P-e8361244-0","P-09995cd8-0","P-3008a382-0","P-dfb24bce-0","P-e109335c-0","P-4e9d6a14-0","P-33ae0b38-0","P-1b3f5ebf-0","P-db75d70f-0","P-1ca32305-0","P-42dcfa1c-0","P-2f654324-0","P-49b7e81c-0","P-0d78d56e-0","P-8a9c5517-0","P-5ca35b4b-0","P-a9a0d31a-0","P-09db431d-0","P-73805a32-0","P-300b2309-0","P-8ec877b8-0","P-e354f354-0","P-1c2f51c0-0","P-fef728d7-0","P-64fbfe58-0","P-9a0c5f90-0","P-d35e24c6-0","P-3cca7974-0","P-c7a54935-0","P-bfc3553c-0","P-9348b695-0","P-114fe72e-0","P-fba350b0-0","P-c328902b-0","P-e572cd25-0","P-8410502b-0","P-22785af6-0","P-f146a17d-0","P-f1c59594-0","P-de1a9533-0","P-afd46b82-0","P-9a0daf15-0","P-a4cc4027-0","P-74cbda9d-0","P-69a485a5-0","P-2d662b23-0","P-b0067727-0","P-3da22a9b-0","P-fd1140ed-0","P-b6f6515d-0","P-b10bbbf6-0","P-08cc871f-0","P-20f79806-0","P-211a1bf0-0","P-1a010a77-0","P-ab2f8705-0","P-571e5b5b-0","P-17199162-0","P-3a4e7368-0","P-afa7b29a-0","P-bc6ea6a1-0"]}}
-->
