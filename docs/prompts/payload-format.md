# Semantic Zoom — Payload Format (v1)

This document is the **versioned agent↔app contract**: the on-disk / in-payload format that AI agents (Engine A producers) write into a markdown file and that the Semantic Zoom app reads back. It defines how the pre-computed `LookupTable` is embedded in the `.md` file, the JSON Schema every payload must satisfy, and the contract addenda that govern hashing, byte offsets, escaping, and ID derivation. It is versioned (`v1`); any breaking change to the schema below bumps the marker version and the schema `$id`.

## Marker convention (spec §2.6, D2)

The agent appends the payload to the **end** of the `.md` file, wrapped in an HTML comment so it stays invisible in any markdown renderer (GitHub, VS Code preview, etc.):

```markdown
<!-- semantic-zoom:payload:v1
{ ...LookupTable JSON... }
-->
```

Extraction is a **byte scan, not a markdown parse**. The extractor finds the last `<!-- semantic-zoom:payload:v1` (via `rfind` — the payload lives at EOF), takes the JSON up to the last `-->`, trims it, and hands it to `serde_json`. Because the marker is EOF-placed and located by reverse scan, it is cheap (~1–3 ms on a 1 MB file) and robust against stray marker-like text earlier in the document.

## JSON Schema (spec §2.4)

The following JSON Schema is the versioned contract between agents and the app. It is transcribed verbatim from spec §2.4:

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

> **Machine-readable copy:** `src/engine/payload.schema.json` is the machine-readable copy of the exact same schema (it is what the validation test compiles with Ajv). The fenced block above and that file **must stay byte-identical** (modulo the surrounding code fence). If you edit one, edit the other.

## Contract addenda A1–A4 (spec §2.6)

These addenda were surfaced by fixture construction and review round 1, and are transcribed verbatim from spec §2.6:

- **A1:** `docHash` covers all bytes *preceding* the payload marker. A payload cannot hash a file that contains itself; the hot-reload short-circuit must hash the same region.
- **A2:** all `span` offsets reference that same pre-payload byte region.
- **A3:** producers must escape any `-->` inside JSON strings as `--\u003e`; the extractor additionally matches the *last* `-->` as defense in depth.
- **A4:** IDs must follow the D6 derivation; `verify_ids()` rejects payloads that don't.
