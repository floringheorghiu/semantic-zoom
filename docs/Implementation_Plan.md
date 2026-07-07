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
| D8 | Mount hidden layer, read `offsetTop` synchronously | Two-frame mount (append in frame n, measure+scroll+fade in frame n+1) + `content-visibility:auto` on groups | One synchronous forced layout of a 10k-paragraph tree can exceed the frame budget alone. Reviewer's alternative (heights estimated from char counts) rejected: approximate positions break exact centering, defeating the anchor engine. |

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

**Anchor resolution (source level → anchor node):**

1. If the read-only caret is placed in paragraph `P_n` → anchor = `P_n`.
2. Else → anchor = the node whose rendered element's vertical center is closest to the viewport center (single pass over currently mounted elements using cached `offsetTop`/`offsetHeight`; no `getBoundingClientRect` in a loop).

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

**Centering math (target node → scrollTop):**

```ts
export function centerScrollTop(
  el: { offsetTop: number; offsetHeight: number },
  viewport: { clientHeight: number; scrollHeight: number }
): number {
  const ideal = el.offsetTop + el.offsetHeight / 2 - viewport.clientHeight / 2;
  return Math.max(0, Math.min(ideal, viewport.scrollHeight - viewport.clientHeight));
}
```

**Transition sequence (prevents the layout-jump the spec worries about):**

1. **Frame n:** append the target level's layer hidden (`visibility:hidden`, same container width) and return — no layout reads in this frame. Groups carry `content-visibility:auto` (§4.2), so WebKit lays out only near-viewport groups, not the whole tree.
2. **Frame n+1 (rAF):** read the mapped target node's `offsetTop`/`offsetHeight` — one contained layout, not a read/write thrash loop — compute `centerScrollTop`, set `scrollTop` on the hidden layer.
3. Same frame: start the 200ms opacity crossfade (compositor-only, §4).
4. On `transitionend`: unmount the old layer.

The one-frame delay (~16ms) is invisible inside the 200ms fade; a `switchMap`-aborted effect (§3.2) covers slider spam. Do **not** substitute measurement with estimated heights (character counts etc.): approximate positions break exact centering, which is the entire point of the anchor engine (D8).

The user never sees an intermediate scroll position; the new level *arrives already centered*.

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
| 2.4 | Two-layer zoom transition: off-screen mount → pre-scroll → 200ms crossfade → unmount | Caret in P₃ → slide to −1 → S₂ arrives centered, zero visible scroll motion; reverse restores P₃ |
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

*End of Phase 1 plan. The contract files (`schema.ts`, Rust mirrors, `docs/payload-format.md`) are the spine — get 1.2 reviewed before anything downstream is written.*
