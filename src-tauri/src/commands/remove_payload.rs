// remove_payload.rs — the reverse of write_payload (spec:
// docs/superpowers/specs/2026-07-17-remove-zoom-payload-design.md).
//
// Strips the embedded `<!-- semantic-zoom:payload:v1 ... -->` block from a
// document, returning it to raw markdown. The block is located with the
// parser's genuine-payload scanner (parser/payload.rs) — the SAME detector
// load_document uses — so what gets removed can never disagree with what
// the app would have displayed. A damaged (non-deserializing) marker at EOF
// is deliberately NOT removed: blindly deleting bytes the scanner can't
// vouch for risks eating real content; that state stays a hand-fix.
//
// The generation-history sidecar is never part of the document, so removal
// cannot touch past runs; instead the removal itself is appended there as a
// `removed` event, atomically with the rewrite (same command, before return).

use crate::commands::generation_history;
use crate::commands::write_payload::write_atomically;
use crate::parser::payload::{extract_payload, HEAD, TAIL};
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemovePayloadOutcome {
    /// The payload block was stripped and the file rewritten atomically.
    Removed,
    /// No genuine payload found (never present, already removed by a
    /// concurrent edit, or only a damaged/decoy marker). The file was not
    /// touched. "Already gone" is success for this operation — the caller
    /// reloads either way.
    NoPayload,
}

/// The raw content with the payload block spliced out, or None when the
/// scanner finds no genuine payload. The blank padding line write_payload
/// inserted before the marker is stripped too, so the result is
/// byte-identical to the pre-generation file in the normal case.
pub(crate) fn strip_payload(source: &str) -> Option<String> {
    let (head, _table) = match extract_payload(source) {
        Some(Ok(found)) => found,
        // Damaged marker (Some(Err)) or no payload at all: nothing safe to remove.
        _ => return None,
    };

    // The block ends at the FIRST tail after the head — assemble.mjs/A3
    // escaping guarantees a genuine payload contains no literal "-->", so
    // this is the marker's own terminator, never JSON content.
    let json_start = head + HEAD.len();
    let block_end = source[json_start..]
        .find(TAIL)
        .map(|rel| json_start + rel + TAIL.len())?; // genuine ⇒ always present

    let mut prefix = &source[..head];
    // Undo write_payload's padding blank line: the writer emits raw
    // (newline-terminated) + "\n" + HEAD, so dropping one trailing newline —
    // only when two are present — restores the pre-generation bytes. A
    // hand-tagged file with a single newline before the marker keeps it.
    if prefix.ends_with("\n\n") {
        prefix = &prefix[..prefix.len() - 1];
    }

    // Anything after the block (hand-appended afterthoughts) survives;
    // whitespace-only remainders are the writer's own trailing newline.
    let suffix = &source[block_end..];
    let suffix = if suffix.trim().is_empty() { "" } else { suffix };

    Some(format!("{prefix}{suffix}"))
}

/// Testable core: remove from `path`, record the event in the history store
/// at `history_dir`. The command below wires the real app-config dir in.
pub(crate) fn remove_payload_at(
    path: &str,
    history_dir: &Path,
    removed_at: &str,
) -> Result<RemovePayloadOutcome, String> {
    let source = fs::read_to_string(path).map_err(|e| e.to_string())?;

    let Some(stripped) = strip_payload(&source) else {
        return Ok(RemovePayloadOutcome::NoPayload);
    };

    write_atomically(path, &stripped)?;

    // Record the removal in the sidecar. The rewrite already succeeded, so a
    // history-store failure (unwritable config dir) must not surface as a
    // failed removal — the document IS back to raw markdown.
    let event = generation_history::GenerationRun {
        outcome: generation_history::RunOutcome::Removed,
        provider_kind: String::new(),
        base_url: String::new(),
        model: String::new(),
        duration_ms: 0,
        finished_at: removed_at.to_string(),
        version: 0, // assigned by append_run
        attempts: 0,
        temperature: 0.0,
        prompt_tokens: None,
        completion_tokens: None,
        milestones: None,
        sections: None,
        error: None,
        template: None,
    };
    if let Err(e) = generation_history::append_run(history_dir, path, event) {
        eprintln!("remove_payload: history append failed (removal itself succeeded): {e}");
    }

    Ok(RemovePayloadOutcome::Removed)
}

#[tauri::command]
pub fn remove_payload(
    app: tauri::AppHandle,
    path: String,
    removed_at: String,
) -> Result<RemovePayloadOutcome, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    remove_payload_at(&path, &dir, &removed_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::generation_history::{history_for, RunOutcome};
    use crate::commands::write_payload::tests_support::embed_payload_for_test;

    fn setup(raw: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, raw).unwrap();
        (dir, path.to_string_lossy().to_string())
    }

    #[test]
    fn round_trip_restores_original_bytes_exactly() {
        let raw = "# Title\n\nHello world.\n";
        let (dir, path) = setup(raw);
        embed_payload_for_test(&path);
        assert_ne!(fs::read_to_string(&path).unwrap(), raw, "precondition: payload embedded");

        let outcome = remove_payload_at(&path, dir.path(), "2026-07-17T10:00:00Z").unwrap();
        assert_eq!(outcome, RemovePayloadOutcome::Removed);
        assert_eq!(fs::read_to_string(&path).unwrap(), raw, "bytes must match pre-generation file");
    }

    #[test]
    fn file_without_payload_is_left_untouched() {
        let raw = "# Title\n\nNo payload here.\n";
        let (dir, path) = setup(raw);

        let outcome = remove_payload_at(&path, dir.path(), "2026-07-17T10:00:00Z").unwrap();
        assert_eq!(outcome, RemovePayloadOutcome::NoPayload);
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    #[test]
    fn decoy_marker_prose_is_not_stripped() {
        // Prose QUOTING the marker syntax (e.g. docs about this format) must
        // never be treated as a removable payload.
        let raw = format!(
            "# About the format\n\nA payload starts with `{HEAD}` and ends with `{TAIL}`.\n\nMore prose after.\n"
        );
        let (dir, path) = setup(&raw);

        let outcome = remove_payload_at(&path, dir.path(), "2026-07-17T10:00:00Z").unwrap();
        assert_eq!(outcome, RemovePayloadOutcome::NoPayload);
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }

    #[test]
    fn removal_appends_a_removed_event_without_touching_prior_runs() {
        let raw = "# Title\n\nHello world.\n";
        let (dir, path) = setup(raw);
        embed_payload_for_test(&path);

        remove_payload_at(&path, dir.path(), "2026-07-17T10:00:00Z").unwrap();

        let runs = history_for(dir.path(), &path);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].outcome, RunOutcome::Removed);
        assert_eq!(runs[0].finished_at, "2026-07-17T10:00:00Z");
    }

    #[test]
    fn no_payload_records_no_history_event() {
        let raw = "# Title\n\nNo payload.\n";
        let (dir, path) = setup(raw);

        remove_payload_at(&path, dir.path(), "2026-07-17T10:00:00Z").unwrap();
        assert!(history_for(dir.path(), &path).is_empty());
    }

    #[test]
    fn unreadable_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = remove_payload_at("/nonexistent/doc.md", dir.path(), "2026-07-17T10:00:00Z");
        assert!(err.is_err());
    }

    #[test]
    fn strip_preserves_content_appended_after_the_payload() {
        // Content hand-appended after a payload block must survive removal.
        let raw = "# Title\n\nHello world.\n";
        let (dir, path) = setup(raw);
        embed_payload_for_test(&path);
        let mut with_suffix = fs::read_to_string(&path).unwrap();
        with_suffix.push_str("\nAppended afterthought.\n");
        fs::write(&path, &with_suffix).unwrap();

        let outcome = remove_payload_at(&path, dir.path(), "2026-07-17T10:00:00Z").unwrap();
        assert_eq!(outcome, RemovePayloadOutcome::Removed);
        let result = fs::read_to_string(&path).unwrap();
        assert!(result.contains("Appended afterthought."));
        assert!(!result.contains(HEAD));
    }
}
