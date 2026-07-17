// generation_history.rs — per-document Engine B run history (the sidecar
// behind the status-label tooltip; see
// docs/superpowers/specs/2026-07-16-generation-history-tooltip-design.md).
//
// `generation-history.json` lives in the app config dir beside
// provider-config.json and follows the same tolerant-store pattern:
// corrupt/missing file → empty history, never an error. Keyed by the
// document's absolute path; each record also remembers the sha256 of the
// file as of its last recorded run, so a renamed-but-unchanged file finds
// its history again (get_generation_history migrates the key on a hash hit).
//
// The user's document is NEVER written by this module — history is
// telemetry about the file, deliberately kept out of it (failed runs must
// not touch the doc; shared .md files must not carry generation metadata).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
// (hex is already a workspace dependency — write_payload.rs uses the same
// digest-to-hex pairing.)
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const HISTORY_FILE: &str = "generation-history.json";
/// Most-recent runs kept per document; oldest dropped beyond this.
const MAX_RUNS_PER_DOC: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunOutcome {
    Succeeded,
    Failed,
    /// The payload was removed from the document (remove_payload command).
    /// Not a generation run — provider fields are empty, version reports
    /// the version that existed at removal time.
    Removed,
}

/// One completed generation run. Cancelled runs are never recorded — the
/// frontend simply doesn't call `append_generation_run` for them.
/// `version` is assigned by `append_run`, not the caller: the count of
/// successful runs for this document including this one if it succeeded
/// (a failed run reports the version that existed at the time).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRun {
    pub outcome: RunOutcome,
    /// Provider kind at run start: "ollama" | "custom-local" | "remote".
    pub provider_kind: String,
    /// base_url at run start — the tooltip shows the host for remote runs.
    pub base_url: String,
    pub model: String,
    pub duration_ms: u64,
    /// ISO-8601, assembled by the frontend at run end (rendered "Created").
    pub finished_at: String,
    #[serde(default)]
    pub version: u32,
    /// Retry-ladder attempts actually used (1–3).
    pub attempts: u32,
    /// Sampling temperature of the FINAL attempt — the one whose output
    /// (or final error) this entry describes.
    pub temperature: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    /// Output shape, successful runs only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestones: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<u32>,
    /// Full error string, failed runs only (rendered as the quoted block).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocHistory {
    /// sha256 hex of the document's bytes as of the last recorded run —
    /// the rename-resilience key.
    #[serde(default)]
    content_hash: String,
    #[serde(default)]
    runs: Vec<GenerationRun>,
}

type HistoryStore = HashMap<String, DocHistory>;

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn read_store(dir: &Path) -> HistoryStore {
    fs::read_to_string(dir.join(HISTORY_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(dir: &Path, store: &HistoryStore) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(dir.join(HISTORY_FILE), json).map_err(|e| e.to_string())
}

/// Hash of the document as it currently exists on disk. None if unreadable
/// (deleted between the run and this call) — a miss, never an error.
fn hash_file(doc_path: &str) -> Option<String> {
    fs::read(doc_path).ok().map(|bytes| sha256_hex(&bytes))
}

/// History for `doc_path`, with rename fallback: on a path miss, hash the
/// file and adopt any record whose contentHash matches (first match wins —
/// two byte-identical documents with histories are ambiguous, and either
/// answer is defensible). A hit migrates the record to the new path so the
/// fallback never has to fire twice.
pub(crate) fn history_for(dir: &Path, doc_path: &str) -> Vec<GenerationRun> {
    let mut store = read_store(dir);
    if let Some(doc) = store.get(doc_path) {
        return doc.runs.clone();
    }
    let Some(hash) = hash_file(doc_path) else { return Vec::new() };
    if hash.is_empty() {
        return Vec::new();
    }
    let Some(old_key) = store
        .iter()
        .find(|(_, doc)| !doc.content_hash.is_empty() && doc.content_hash == hash)
        .map(|(k, _)| k.clone())
    else {
        return Vec::new();
    };
    let doc = store.remove(&old_key).unwrap_or_default();
    let runs = doc.runs.clone();
    store.insert(doc_path.to_string(), doc);
    // Migration is a cache move, not new information — if the write fails
    // the history is still returned and the fallback fires again next time.
    let _ = write_store(dir, &store);
    runs
}

/// Append a run, assign its version, refresh the record's content hash from
/// the file as it exists NOW (for successes that's post-write_payload), cap
/// at MAX_RUNS_PER_DOC, persist. Returns the updated list — the frontend
/// re-renders from what was actually stored.
pub(crate) fn append_run(
    dir: &Path,
    doc_path: &str,
    mut run: GenerationRun,
) -> Result<Vec<GenerationRun>, String> {
    let mut store = read_store(dir);
    let doc = store.entry(doc_path.to_string()).or_default();

    let prior_successes =
        doc.runs.iter().filter(|r| r.outcome == RunOutcome::Succeeded).count() as u32;
    run.version = match run.outcome {
        RunOutcome::Succeeded => prior_successes + 1,
        RunOutcome::Failed | RunOutcome::Removed => prior_successes,
    };

    doc.runs.push(run);
    if doc.runs.len() > MAX_RUNS_PER_DOC {
        let excess = doc.runs.len() - MAX_RUNS_PER_DOC;
        doc.runs.drain(..excess);
    }
    doc.content_hash = hash_file(doc_path).unwrap_or_default();

    let runs = doc.runs.clone();
    write_store(dir, &store)?;
    Ok(runs)
}

#[tauri::command]
pub fn get_generation_history(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<GenerationRun>, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(history_for(&dir, &path))
}

#[tauri::command]
pub fn append_generation_run(
    app: tauri::AppHandle,
    path: String,
    run: GenerationRun,
) -> Result<Vec<GenerationRun>, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    append_run(&dir, &path, run)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(outcome: RunOutcome) -> GenerationRun {
        GenerationRun {
            outcome,
            provider_kind: "ollama".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            model: "gemma4:latest".to_string(),
            duration_ms: 328_000,
            finished_at: "2026-07-16T12:34:00Z".to_string(),
            version: 0,
            attempts: 1,
            temperature: 0.0,
            prompt_tokens: Some(8_200),
            completion_tokens: Some(1_020),
            milestones: None,
            sections: None,
            error: None,
        }
    }

    fn temp_setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        fs::write(&doc, "# Hello\n\nBody.\n").unwrap();
        (dir, doc)
    }

    #[test]
    fn append_then_get_round_trips_through_disk() {
        let (dir, doc) = temp_setup();
        let doc_path = doc.to_str().unwrap();

        let after = append_run(dir.path(), doc_path, run(RunOutcome::Succeeded)).unwrap();
        assert_eq!(after.len(), 1);

        let read_back = history_for(dir.path(), doc_path);
        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].model, "gemma4:latest");
        assert_eq!(read_back[0].prompt_tokens, Some(8_200));
    }

    #[test]
    fn version_counts_successes_and_failed_runs_show_the_current_version() {
        let (dir, doc) = temp_setup();
        let doc_path = doc.to_str().unwrap();

        let after = append_run(dir.path(), doc_path, run(RunOutcome::Failed)).unwrap();
        assert_eq!(after[0].version, 0, "failed before any success → version 0");

        let after = append_run(dir.path(), doc_path, run(RunOutcome::Succeeded)).unwrap();
        assert_eq!(after[1].version, 1, "first success → version 1");

        let after = append_run(dir.path(), doc_path, run(RunOutcome::Failed)).unwrap();
        assert_eq!(after[2].version, 1, "failure after a success keeps version 1");

        let after = append_run(dir.path(), doc_path, run(RunOutcome::Succeeded)).unwrap();
        assert_eq!(after[3].version, 2);
    }

    #[test]
    fn runs_are_capped_at_the_maximum_dropping_oldest() {
        let (dir, doc) = temp_setup();
        let doc_path = doc.to_str().unwrap();

        for i in 0..(MAX_RUNS_PER_DOC + 5) {
            let mut r = run(RunOutcome::Failed);
            r.duration_ms = i as u64; // distinguishable marker
            append_run(dir.path(), doc_path, r).unwrap();
        }
        let runs = history_for(dir.path(), doc_path);
        assert_eq!(runs.len(), MAX_RUNS_PER_DOC);
        // Oldest (duration_ms 0..5) dropped; the first kept is run #5.
        assert_eq!(runs[0].duration_ms, 5);
    }

    #[test]
    fn renamed_but_unchanged_file_finds_its_history_and_migrates() {
        let (dir, doc) = temp_setup();
        let doc_path = doc.to_str().unwrap().to_string();

        append_run(dir.path(), &doc_path, run(RunOutcome::Succeeded)).unwrap();

        // Rename the file; same bytes → same hash.
        let renamed = dir.path().join("renamed.md");
        fs::rename(&doc, &renamed).unwrap();
        let renamed_path = renamed.to_str().unwrap();

        let runs = history_for(dir.path(), renamed_path);
        assert_eq!(runs.len(), 1, "hash fallback must find the renamed file's history");

        // The record migrated: the old key is gone, the new one resolves
        // directly (no fallback needed — provable even after the old file
        // path can no longer be hashed).
        let store = read_store(dir.path());
        assert!(!store.contains_key(&doc_path), "old path key must be migrated away");
        assert!(store.contains_key(renamed_path));
    }

    #[test]
    fn moved_and_edited_file_starts_fresh() {
        let (dir, doc) = temp_setup();
        let doc_path = doc.to_str().unwrap().to_string();
        append_run(dir.path(), &doc_path, run(RunOutcome::Succeeded)).unwrap();

        let moved = dir.path().join("moved.md");
        fs::rename(&doc, &moved).unwrap();
        fs::write(&moved, "# Hello\n\nEdited body.\n").unwrap();

        let runs = history_for(dir.path(), moved.to_str().unwrap());
        assert!(runs.is_empty(), "hash mismatch → fresh history (accepted limitation)");
    }

    #[test]
    fn corrupt_store_file_yields_empty_history_never_an_error() {
        let (dir, doc) = temp_setup();
        fs::write(dir.path().join(HISTORY_FILE), "{ not json").unwrap();

        let runs = history_for(dir.path(), doc.to_str().unwrap());
        assert!(runs.is_empty());

        // And appending over a corrupt store starts a fresh one.
        let after = append_run(dir.path(), doc.to_str().unwrap(), run(RunOutcome::Succeeded));
        assert_eq!(after.unwrap().len(), 1);
    }

    #[test]
    fn missing_document_file_still_records_the_run() {
        // The doc may be deleted between the run and the append (or the
        // failure IS that the file vanished) — history must not error.
        let dir = tempfile::tempdir().unwrap();
        let after = append_run(dir.path(), "/nonexistent/doc.md", run(RunOutcome::Failed)).unwrap();
        assert_eq!(after.len(), 1);
        let store = read_store(dir.path());
        assert_eq!(store.get("/nonexistent/doc.md").unwrap().content_hash, "");
    }

    #[test]
    fn empty_content_hash_never_matches_on_fallback() {
        // Two docs recorded while unreadable (empty hash) must not adopt
        // each other's history via the fallback scan.
        let dir = tempfile::tempdir().unwrap();
        append_run(dir.path(), "/gone/a.md", run(RunOutcome::Failed)).unwrap();

        // A real file whose hash obviously differs — but crucially, ALSO
        // make sure an unreadable path doesn't inherit /gone/a.md's record.
        let runs = history_for(dir.path(), "/gone/b.md");
        assert!(runs.is_empty());
    }
}
