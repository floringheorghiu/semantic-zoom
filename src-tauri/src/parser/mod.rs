use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct Span { pub start: usize, pub end: usize }

#[derive(Debug, Serialize, Deserialize)]
pub struct ParagraphNode {
    pub id: String,
    pub level: i8,                 // always 0; validated below
    pub parent: String,
    pub kind: String,
    pub span: Span,
    pub html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SectionNode {
    pub id: String,
    pub level: i8,                 // always -1
    pub parent: String,
    pub children: Vec<String>,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MetaNode {
    pub id: String,
    pub level: i8,                 // always -2
    pub children: Vec<String>,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Order {
    pub meta: Vec<String>,
    pub sections: Vec<String>,
    pub paragraphs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LookupTable {
    pub version: u8,
    pub doc_hash: String,
    pub meta: HashMap<String, MetaNode>,
    pub sections: HashMap<String, SectionNode>,
    pub paragraphs: HashMap<String, ParagraphNode>,
    pub order: Order,
}

impl LookupTable {
    /// Referential-integrity check. Reject the payload rather than let the
    /// UI hit a missing parent mid-transition.
    pub fn validate(&self) -> Result<(), String> {
        for (id, p) in &self.paragraphs {
            if p.level != 0 { return Err(format!("{id}: level must be 0")); }
            if !self.sections.contains_key(&p.parent) {
                return Err(format!("{id}: dangling parent {}", p.parent));
            }
        }
        for (id, s) in &self.sections {
            if s.level != -1 { return Err(format!("{id}: level must be -1")); }
            if !self.meta.contains_key(&s.parent) {
                return Err(format!("{id}: dangling parent {}", s.parent));
            }
            for c in &s.children {
                if !self.paragraphs.contains_key(c) {
                    return Err(format!("{id}: missing child {c}"));
                }
            }
        }
        Ok(())
    }

    /// D6 enforcement: recompute each paragraph's content hash from its
    /// span slice of the pre-payload source and require the ID to embed
    /// it. Rejects payloads whose IDs weren't derived per contract —
    /// without this, content addressing is a convention, not a guarantee.
    /// (Cargo: add `sha2` and `hex`.)
    pub fn verify_ids(&self, source: &str) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        let bytes = source.as_bytes();
        for (id, p) in &self.paragraphs {
            let slice = bytes
                .get(p.span.start..p.span.end)
                .ok_or_else(|| format!("{id}: span out of bounds"))?;
            let h = &hex::encode(Sha256::digest(slice))[..8];
            if !id.starts_with(&format!("P-{h}-")) {
                return Err(format!("{id}: content hash mismatch (expected P-{h}-*)"));
            }
        }
        Ok(())
    }
}
