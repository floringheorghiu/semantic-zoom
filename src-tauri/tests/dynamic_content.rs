// Executable proof that the `load_document` parse path (`extract_payload` +
// `verify_ids` — exactly what the Tauri command calls) is driven entirely by
// the bytes of the file it's given, never by any cached or hardcoded
// structure. Two different native documents in, two correspondingly
// different `LookupTable`s out, with content-addressed (D6) ids that are
// deterministic on identical bytes but differ whenever the bytes do.

use semantic_zoom_lib::parser::payload::extract_payload;
use semantic_zoom_lib::parser::LookupTable;
use sha2::{Digest, Sha256};

fn hash8(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))[..8].to_string()
}

fn hash_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// A minimal-but-valid native document: one meta -> one section -> one
/// paragraph, with real D6 content-addressed ids derived from the actual
/// heading/paragraph bytes (mirrors `perf/gen-synthetic.mjs`'s approach).
fn build_native_doc(meta_title: &str, section_heading: &str, paragraph_text: &str) -> String {
    let heading_line = format!("## {section_heading}");
    let sid = format!("S-{}-0", hash8(heading_line.as_bytes()));

    let body = format!("{heading_line}\n\n{paragraph_text}\n\n");
    let start = heading_line.len() + 2; // bytes before the paragraph text starts
    let end = start + paragraph_text.len();

    let pid = format!("P-{}-0", hash8(paragraph_text.as_bytes()));
    let doc_hash = hash_hex(body.as_bytes());

    let json = format!(
        r#"{{"version":1,"docHash":"{doc_hash}","meta":{{"M1":{{"id":"M1","level":-2,"children":["{sid}"],"title":"{meta_title}","body":"b"}}}},"sections":{{"{sid}":{{"id":"{sid}","level":-1,"parent":"M1","children":["{pid}"],"title":"{section_heading}","body":"b"}}}},"paragraphs":{{"{pid}":{{"id":"{pid}","level":0,"parent":"{sid}","kind":"prose","span":{{"start":{start},"end":{end}}},"html":"<p>{paragraph_text}</p>"}}}},"order":{{"meta":["M1"],"sections":["{sid}"],"paragraphs":["{pid}"]}}}}"#
    );

    format!("{body}<!-- semantic-zoom:payload:v1\n{json}\n-->")
}

/// The exact parse path `load_document` runs on whatever file it's asked to
/// read: extract, then verify ids against the pre-payload bytes.
fn load(raw: &str) -> LookupTable {
    let (head, table) = extract_payload(raw)
        .expect("payload present")
        .expect("payload valid JSON + referentially sound");
    table.verify_ids(&raw[..head]).expect("ids verify against the real bytes");
    table
}

#[test]
fn two_different_native_files_produce_two_different_tables() {
    let doc_a = build_native_doc(
        "Milestone Alpha: Onboarding",
        "Sign-up flow",
        "Users create an account with email and password.",
    );
    let doc_b = build_native_doc(
        "Milestone Beta: Payments",
        "Checkout flow",
        "Users enter a card number and confirm the charge.",
    );

    let table_a = load(&doc_a);
    let table_b = load(&doc_b);

    // Parsed straight from each file's own bytes — never a shared/cached
    // instance masquerading as "the" document.
    assert_eq!(table_a.meta["M1"].title, "Milestone Alpha: Onboarding");
    assert_eq!(table_b.meta["M1"].title, "Milestone Beta: Payments");
    assert_ne!(table_a.meta["M1"].title, table_b.meta["M1"].title);

    // Content-addressed ids (D6) differ because the underlying bytes differ —
    // a hardcoded or cached table could never produce this on its own.
    assert_ne!(table_a.order.sections[0], table_b.order.sections[0]);
    assert_ne!(table_a.order.paragraphs[0], table_b.order.paragraphs[0]);
}

#[test]
fn identical_bytes_reproduce_identical_ids_deterministically() {
    let doc = build_native_doc(
        "Milestone Alpha: Onboarding",
        "Sign-up flow",
        "Users create an account with email and password.",
    );
    let doc_again = build_native_doc(
        "Milestone Alpha: Onboarding",
        "Sign-up flow",
        "Users create an account with email and password.",
    );

    let table = load(&doc);
    let table_again = load(&doc_again);

    // A fresh parse of byte-identical content reproduces the SAME ids —
    // content-hashed (D6), not random or sequential per load.
    assert_eq!(table.order.sections, table_again.order.sections);
    assert_eq!(table.order.paragraphs, table_again.order.paragraphs);
}
