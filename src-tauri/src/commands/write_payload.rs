// write_payload.rs — Engine B's disk write-back (D10 split of §8.4's
// original single-command sketch). The TS side (src/native/engine-b-remote.ts,
// T6) builds the LookupTable in memory via the portable zoom-tools/**
// modules; this command is the ONLY place that touches disk for it, gated
// by validate()/verify_ids() — the exact same gate Engine A payloads pass
// through (commands/document.rs), so a hand-tagged file and an
// LLM-synthesized one are held to an identical bar.

use crate::parser::payload::{HEAD, TAIL};
use crate::parser::LookupTable;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WritePayloadOutcome {
    /// Written to disk. The watcher's own `doc://changed` fires next and is
    /// a no-op (same docHash) — this is not a race with it.
    Written,
    /// The file changed on disk since the caller read it (a concurrent
    /// edit while the LLM request was in flight). Per §8.4: silently
    /// overwriting that edit would violate the "user files are never
    /// mutated behind their back" spirit, so nothing was written. The
    /// caller may still use the synthesized table for the CURRENT session
    /// only — it must not be treated as persisted.
    SkippedHashMismatch,
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The exact bytes docHash covers (A1) — raw content plus the same
/// newline-padding convention `assemble.mjs`'s `buildLookupTable` uses, so
/// a `docHash` computed by the TS side agrees with this Rust recomputation
/// byte-for-byte.
fn prefix_bytes(raw: &str) -> Vec<u8> {
    let mut s = raw.to_string();
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s.push('\n');
    s.into_bytes()
}

/// A3 escaping, mirroring assemble.mjs: any literal marker terminator
/// inside a JSON string value would otherwise let the app's HEAD-scanning
/// extractor misparse the embedded payload as ending early.
fn escape_marker_collisions(payload_json: &str) -> String {
    let escaped_tail = payload_json.replace(TAIL, "--\\u003e");
    let head_without_bracket = &HEAD[1..]; // "!-- semantic-zoom:payload:v1"
    escaped_tail.replace(HEAD, &format!("\\u003c{head_without_bracket}"))
}

#[tauri::command]
pub fn write_payload(
    path: String,
    table: LookupTable,
    doc_hash: String,
) -> Result<WritePayloadOutcome, String> {
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let prefix = prefix_bytes(&current);
    let current_hash = sha256_hex(&prefix);

    if current_hash != doc_hash {
        return Ok(WritePayloadOutcome::SkippedHashMismatch);
    }

    // Same gate load_document runs on any Engine A payload (commands/document.rs) —
    // a synthesized table is never trusted more than a hand-tagged one.
    table.validate()?;
    table.verify_ids(&current)?;

    let payload_json = serde_json::to_string(&table).map_err(|e| e.to_string())?;
    let payload_json = escape_marker_collisions(&payload_json);

    let mut out = String::from_utf8(prefix).map_err(|e| e.to_string())?;
    out.push_str(HEAD);
    out.push('\n');
    out.push_str(&payload_json);
    out.push('\n');
    out.push_str(TAIL);
    out.push('\n');

    write_atomically(&path, &out)?;
    Ok(WritePayloadOutcome::Written)
}

/// Write-then-rename: the target path never observes a partially-written
/// file, even if the process is killed mid-write. The temp file lives in
/// the SAME directory as the target so the rename is same-filesystem (atomic).
pub(crate) fn write_atomically(path: &str, contents: &str) -> Result<(), String> {
    let target = Path::new(path);
    let dir = target.parent().ok_or_else(|| format!("{path}: no parent directory"))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("{path}: no file name"))?
        .to_string_lossy();
    let tmp_path = dir.join(format!(".{file_name}.szoom-write-tmp"));

    fs::write(&tmp_path, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Test-only helpers shared with remove_payload.rs's tests: build a minimal
/// valid single-block table for a raw doc (real D6 content-addressed ids)
/// and embed it through the REAL write_payload path — so removal tests
/// exercise exactly the bytes generation produces, not a hand-mocked block.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;
    use crate::parser::{MetaNode, Order, ParagraphNode, SectionNode, Span};
    use std::collections::HashMap;

    /// Embed a valid payload into the file at `path` via write_payload.
    /// Panics on any failure — these are test preconditions.
    pub(crate) fn embed_payload_for_test(path: &str) {
        let raw = fs::read_to_string(path).unwrap();
        let (table, doc_hash) = table_for(&raw);
        let outcome = write_payload(path.to_string(), table, doc_hash).unwrap();
        assert_eq!(outcome, WritePayloadOutcome::Written);
    }

    pub(crate) fn table_for(raw: &str) -> (LookupTable, String) {
        // A single-paragraph doc — mirrors what the TS-side buildLookupTable
        // would produce for a one-block untagged file.
        let text = raw.trim_end_matches('\n');
        let hash8 = &sha256_hex(text.as_bytes())[..8];
        let pid = format!("P-{hash8}-0");
        let sid = format!("S-{hash8}-0");

        let mut paragraphs = HashMap::new();
        paragraphs.insert(
            pid.clone(),
            ParagraphNode {
                id: pid.clone(),
                level: 0,
                parent: sid.clone(),
                kind: "prose".to_string(),
                span: Span { start: 0, end: text.len() },
                html: format!("<p>{text}</p>"),
                lang: None,
            },
        );
        let mut sections = HashMap::new();
        sections.insert(
            sid.clone(),
            SectionNode {
                id: sid.clone(),
                level: -1,
                parent: "M1".to_string(),
                children: vec![pid.clone()],
                title: "Section".to_string(),
                body: "Body.".to_string(),
            },
        );
        let mut meta = HashMap::new();
        meta.insert(
            "M1".to_string(),
            MetaNode {
                id: "M1".to_string(),
                level: -2,
                children: vec![sid.clone()],
                title: "Story".to_string(),
                body: "**Accomplished:**\n- x\n\n**Blockers:**\n- None noted.\n\n**Next steps:**\n- x".to_string(),
            },
        );

        let prefix = prefix_bytes(raw);
        let doc_hash = sha256_hex(&prefix);

        let table = LookupTable {
            version: 1,
            doc_hash: doc_hash.clone(),
            meta,
            sections,
            paragraphs,
            order: Order { meta: vec!["M1".to_string()], sections: vec![sid], paragraphs: vec![pid] },
        };
        (table, doc_hash)
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::table_for;
    use super::*;

    fn write_temp_md(dir: &std::path::Path, name: &str, content: &str) -> String {
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn hash_match_writes_and_verify_payload_accepts_it() {
        let dir = tempfile_dir("write-payload-match");
        let raw = "Hello world.\n";
        let path = write_temp_md(&dir, "doc.md", raw);
        let (table, doc_hash) = table_for(raw);

        let outcome = write_payload(path.clone(), table, doc_hash).unwrap();
        assert_eq!(outcome, WritePayloadOutcome::Written);

        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains(HEAD));
        assert!(written.contains(TAIL));

        // The authoritative gate: re-parse and verify exactly as load_document would.
        let (head, reparsed) = crate::parser::payload::extract_payload(&written)
            .expect("payload must be detected")
            .expect("payload must validate");
        reparsed.verify_ids(&written[..head]).expect("verify_ids must pass");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hash_mismatch_skips_write_and_leaves_file_bytes_unchanged() {
        let dir = tempfile_dir("write-payload-mismatch");
        let raw = "Hello world.\n";
        let path = write_temp_md(&dir, "doc.md", raw);
        let (table, _correct_hash) = table_for(raw);

        let before = fs::read(&path).unwrap();
        let outcome = write_payload(path.clone(), table, "0".repeat(64)).unwrap();
        assert_eq!(outcome, WritePayloadOutcome::SkippedHashMismatch);

        let after = fs::read(&path).unwrap();
        assert_eq!(before, after, "file bytes must be byte-identical after a skipped write");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn id_corrupted_table_is_refused_even_with_a_matching_hash() {
        let dir = tempfile_dir("write-payload-corrupt-id");
        let raw = "Hello world.\n";
        let path = write_temp_md(&dir, "doc.md", raw);
        let (mut table, doc_hash) = table_for(raw);

        // Corrupt one paragraph's id so it no longer matches its own content hash.
        let (real_id, node) = table.paragraphs.drain().next().unwrap();
        table.paragraphs.insert("P-deadbeef-0".to_string(), node);
        for s in table.sections.values_mut() {
            s.children = vec!["P-deadbeef-0".to_string()];
        }
        let _ = real_id;

        let before = fs::read(&path).unwrap();
        let err = write_payload(path.clone(), table, doc_hash).unwrap_err();
        assert!(err.contains("hash mismatch") || err.contains("dangling"), "got: {err}");

        let after = fs::read(&path).unwrap();
        assert_eq!(before, after, "a refused write must never touch the file");

        std::fs::remove_dir_all(&dir).ok();
    }

    fn tempfile_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("szoom-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
