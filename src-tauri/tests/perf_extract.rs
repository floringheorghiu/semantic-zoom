// Perf pass (Task 3.4): Rust native extraction budget — the ≤10 ms happy path
// (spec §2.6 / §7). This is the ONLY Phase-1 budget measurable headlessly; the
// frontend budgets (≤16 ms mask frame, ≤250 ms level swap) are measured in the
// running app — see `docs/perf-baseline.md`.
//
// Ignored by default so the normal `cargo test` suite stays fast. Timing is only
// meaningful in a release build, so run it as:
//
//     cargo test --release -- --ignored perf_extract
//
// It reads `perf/synthetic-1mb.md` (generate first with `node perf/gen-synthetic.mjs`).
// If the file is absent it returns early with a note, so CI without the artifact
// never fails on this test.

use std::path::PathBuf;
use std::time::Instant;

use semantic_zoom_lib::parser::payload::extract_payload;

const ITERS: usize = 20;
const BUDGET_MS: f64 = 10.0;

fn synthetic_path() -> PathBuf {
    // Test runs with CWD = src-tauri; the artifact lives at ../perf/.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../perf/synthetic-1mb.md")
}

#[test]
#[ignore = "perf: run explicitly with `cargo test --release -- --ignored perf_extract`"]
fn perf_extract_1mb_within_budget() {
    let path = synthetic_path();
    let source = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "perf_extract: skipping — {} not found. Generate it with `node perf/gen-synthetic.mjs`.",
                path.display()
            );
            return;
        }
    };

    // Pre-payload region (A1/A2): everything before the marker, at the
    // offset extract_payload() itself found it — `verify_ids` recomputes
    // each paragraph hash from its span slice of this region. Sanity: the
    // pipeline must accept the generated payload before we time it. (If
    // this fails, fix the generator — never the Rust.)
    let pre_payload_len = {
        let (head, table) = extract_payload(&source)
            .expect("payload marker present")
            .expect("payload parses + validates");
        table
            .verify_ids(&source[..head])
            .expect("D6 ids verify against the pre-payload region");
        head
    };
    let pre_payload = &source[..pre_payload_len];

    // Time extract_payload (parse + validate) + verify_ids over N iterations.
    let mut samples_ms: Vec<f64> = Vec::with_capacity(ITERS);
    for _ in 0..ITERS {
        let t0 = Instant::now();
        let (_, table) = extract_payload(&source)
            .expect("some")
            .expect("ok");
        table.verify_ids(pre_payload).expect("verify");
        samples_ms.push(t0.elapsed().as_secs_f64() * 1_000.0);
    }

    samples_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let min = samples_ms[0];
    let max = *samples_ms.last().unwrap();
    let median = samples_ms[samples_ms.len() / 2];
    let mean = samples_ms.iter().sum::<f64>() / samples_ms.len() as f64;

    let mode = if cfg!(debug_assertions) { "debug" } else { "release" };
    eprintln!(
        "perf_extract [{mode}] over {ITERS} iters ({} bytes source, {} bytes pre-payload):",
        source.len(),
        pre_payload.len()
    );
    eprintln!(
        "  min={min:.3} ms  median={median:.3} ms  mean={mean:.3} ms  max={max:.3} ms  (budget ≤{BUDGET_MS} ms)"
    );

    // Only enforce the budget in release — debug builds are not representative.
    if cfg!(debug_assertions) {
        eprintln!("  (debug build — budget assertion skipped; run with --release to enforce)");
    } else {
        assert!(
            median <= BUDGET_MS,
            "extraction median {median:.3} ms exceeds the ≤{BUDGET_MS} ms budget"
        );
    }
}
