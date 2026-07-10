// verify_payload — authoritative cross-check for tools/semantic-zoom-tools.
//
// The plugin's own scripts/validate.mjs independently reimplements
// validate()/verify_ids() in JS so the PostToolUse hook can run on every
// edit without a cargo dependency — a deliberate, documented tradeoff (see
// that script's header). This binary closes the gap that reimplementation
// necessarily opens: it calls THIS APP'S OWN validate()/verify_ids() (the
// same code load_document runs), not a JS mirror of it, so a payload this
// binary accepts is guaranteed acceptable to the shipping app, not just
// "believed equivalent." CLAUDE.md requires exactly this confirmation
// before a hand-assembled payload counts as done.
//
// Not part of the GUI app or any Tauri command — a standalone dev-tool
// binary, built with `cargo build --bin verify_payload` and invoked by the
// plugin's embed-zoom-payload skill as its final gate.
//
//   cargo run --bin verify_payload -- <file.md>
//
// Exit 0, silent: valid.
// Exit 1: prints the specific validate()/verify_ids() failure to stderr.

use semantic_zoom_lib::parser::payload::extract_payload;
use std::env;
use std::fs;
use std::process::ExitCode;

const HEAD: &str = "<!-- semantic-zoom:payload:v1";

fn main() -> ExitCode {
    let path = match env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: verify_payload <file.md>");
            return ExitCode::FAILURE;
        }
    };

    let source = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("verify_payload: cannot read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };

    let Some(marker_start) = source.rfind(HEAD) else {
        eprintln!("verify_payload: {path} has no semantic-zoom payload marker");
        return ExitCode::FAILURE;
    };
    let pre_payload = &source[..marker_start];

    let table = match extract_payload(&source) {
        None => unreachable!("marker presence already checked above"),
        Some(Err(e)) => {
            eprintln!("verify_payload: {path}: parse/validate() failed: {e}");
            return ExitCode::FAILURE;
        }
        Some(Ok(t)) => t,
    };

    if let Err(e) = table.verify_ids(pre_payload) {
        eprintln!("verify_payload: {path}: verify_ids() failed: {e}");
        return ExitCode::FAILURE;
    }

    println!(
        "verify_payload: {path}: OK — validate() + verify_ids() pass ({} paragraphs, {} sections, {} meta)",
        table.paragraphs.len(),
        table.sections.len(),
        table.meta.len()
    );
    ExitCode::SUCCESS
}
