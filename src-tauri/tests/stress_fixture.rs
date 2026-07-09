// Task 2.5 (docs/Implementation_Plan.md §4.3): confirms the generated
// "5,000-line agent log with ~40 code blocks" stress fixture is a genuinely
// valid Native payload BEFORE anyone spends Instruments time on it — a
// generator bug here would waste a manual GUI session chasing a false result.
//
// Ignored by default (matches the perf_extract.rs pattern): it depends on a
// gitignored generated artifact, not something CI should require present.
//
//     node perf/gen-stress-fixture.mjs
//     cargo test -- --ignored stress_fixture

use std::path::PathBuf;

use semantic_zoom_lib::parser::payload::extract_payload;

const HEAD: &str = "<!-- semantic-zoom:payload:v1";

fn stress_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../perf/stress-fixture.md")
}

#[test]
#[ignore = "depends on generated artifact: run `node perf/gen-stress-fixture.mjs` first"]
fn stress_fixture_parses_validates_and_verifies() {
    let path = stress_fixture_path();
    let source = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "stress_fixture: skipping — {} not found. Generate it with `node perf/gen-stress-fixture.mjs`.",
                path.display()
            );
            return;
        }
    };

    let marker_start = source
        .rfind(HEAD)
        .expect("stress fixture must contain a payload marker");
    let pre_payload = &source[..marker_start];

    let table = extract_payload(&source)
        .expect("payload marker present")
        .expect("payload parses + validates");
    table
        .verify_ids(pre_payload)
        .expect("D6 ids verify against the pre-payload region");

    let body_lines = pre_payload.lines().count();
    let code_blocks = table
        .paragraphs
        .values()
        .filter(|p| p.kind == "code")
        .count();
    eprintln!(
        "stress_fixture: {body_lines} pre-payload lines, {code_blocks} code-kind paragraphs, \
         {} sections, {} meta nodes — all D6/validate() checks pass.",
        table.sections.len(),
        table.meta.len()
    );
    assert!(
        body_lines >= 4500 && body_lines <= 5500,
        "expected ~5,000 lines per §4.3, got {body_lines}"
    );
    assert!(
        code_blocks >= 35 && code_blocks <= 45,
        "expected ~40 code blocks per §4.3, got {code_blocks}"
    );
}
