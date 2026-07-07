use semantic_zoom_lib::parser::LookupTable;

#[test]
fn validate_rejects_dangling_parent() {
    let json = r#"{
      "version":1,"docHash":"aaaa","meta":{},
      "sections":{},
      "paragraphs":{"P-00000000-0":{"id":"P-00000000-0","level":0,"parent":"S-nope-0","kind":"prose","span":{"start":0,"end":3},"html":"x"}},
      "order":{"meta":[],"sections":[],"paragraphs":["P-00000000-0"]}
    }"#;
    let t: LookupTable = serde_json::from_str(json).unwrap();
    assert!(t.validate().is_err());
}

#[test]
fn verify_ids_rejects_wrong_hash() {
    let src = "hello world paragraph one";
    let json = r#"{
      "version":1,"docHash":"aaaa",
      "meta":{"M1":{"id":"M1","level":-2,"children":["S-00000000-0"],"title":"m","body":"b"}},
      "sections":{"S-00000000-0":{"id":"S-00000000-0","level":-1,"parent":"M1","children":["P-deadbeef-0"],"title":"s","body":"b"}},
      "paragraphs":{"P-deadbeef-0":{"id":"P-deadbeef-0","level":0,"parent":"S-00000000-0","kind":"prose","span":{"start":0,"end":5},"html":"x"}},
      "order":{"meta":["M1"],"sections":["S-00000000-0"],"paragraphs":["P-deadbeef-0"]}
    }"#;
    let t: LookupTable = serde_json::from_str(json).unwrap();
    assert!(t.validate().is_ok(), "referential integrity should hold");
    assert!(t.verify_ids(src).is_err(), "deadbeef is not the real hash of bytes 0..5");
}
