use semantic_zoom_lib::parser::payload::extract_payload;
use semantic_zoom_lib::parser::LookupTable;
use std::fs;

fn fixture() -> String {
    fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/zoom_test.md"
    ))
    .unwrap()
}

// pre-payload region = bytes before the marker (A1/A2)
fn pre_payload(src: &str) -> &str {
    let head = "<!-- semantic-zoom:payload:v1";
    &src[..src.rfind(head).unwrap()]
}

#[test]
fn fixture_payload_parses_validates_and_verifies() {
    let src = fixture();
    let parsed: LookupTable = extract_payload(&src)
        .expect("payload present")
        .expect("payload valid");
    parsed.validate().expect("referential integrity");
    parsed
        .verify_ids(pre_payload(&src))
        .expect("D6 content hashes");
    let canon = serde_json::to_string(&parsed).unwrap();
    fs::write(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/roundtrip-expected.json"
        ),
        canon,
    )
    .unwrap();
}
