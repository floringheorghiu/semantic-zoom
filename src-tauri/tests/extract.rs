use semantic_zoom_lib::parser::payload::extract_payload;
use sha2::{Digest, Sha256};

#[test]
fn untagged_returns_none() {
    assert!(extract_payload("# just markdown\n\nno payload here").is_none());
}

#[test]
fn prose_mentioning_marker_syntax_returns_none() {
    // A doc that merely quotes/describes the marker syntax (e.g. this
    // plugin's own skill instructions) has no real payload following the
    // marker text and real content after it — must read as untagged, not
    // corrupt. Regression test for the bug where a naive
    // rfind(HEAD)+rfind(TAIL) scan mistook this for a broken payload.
    let src = "Docs describe the format as `<!-- semantic-zoom:payload:v1 ... -->` \
               so authors know what to expect.\n\nMore prose follows here.";
    assert!(extract_payload(src).is_none());
}

#[test]
fn corrupt_json_returns_some_err() {
    let src = "text\n<!-- semantic-zoom:payload:v1\n{ not json }\n-->";
    match extract_payload(src) {
        Some(Err(_)) => {}
        other => panic!("expected Some(Err), got {other:?}"),
    }
}

#[test]
fn valid_payload_returns_some_ok() {
    let body = "the one paragraph";
    let h = &hex::encode(Sha256::digest(body.as_bytes()))[..8];
    let dh = hex::encode(Sha256::digest(body.as_bytes()));
    let json = format!(r#"{{
      "version":1,"docHash":"{dh}",
      "meta":{{"M1":{{"id":"M1","level":-2,"children":["S-00000000-0"],"title":"m","body":"b"}}}},
      "sections":{{"S-00000000-0":{{"id":"S-00000000-0","level":-1,"parent":"M1","children":["P-{h}-0"],"title":"s","body":"b"}}}},
      "paragraphs":{{"P-{h}-0":{{"id":"P-{h}-0","level":0,"parent":"S-00000000-0","kind":"prose","span":{{"start":0,"end":{end}}},"html":"x"}}}},
      "order":{{"meta":["M1"],"sections":["S-00000000-0"],"paragraphs":["P-{h}-0"]}}
    }}"#, h = h, end = body.len(), dh = dh);
    let src = format!("{body}\n<!-- semantic-zoom:payload:v1\n{json}\n-->");
    let (_, table) = extract_payload(&src).expect("some").expect("ok");
    assert_eq!(table.version, 1);
}
