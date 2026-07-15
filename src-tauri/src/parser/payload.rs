use crate::parser::LookupTable;

// pub(crate): reused by write_payload.rs (T8) so both marker-scanning and
// marker-writing agree on the exact sentinel bytes within this one Rust
// codebase — no reason to duplicate the constant twice in the same crate,
// unlike the deliberate JS/Rust duplication (README: "Rust hardcodes its
// own copy by design").
pub(crate) const HEAD: &str = "<!-- semantic-zoom:payload:v1";
pub(crate) const TAIL: &str = "-->";

/// Locate a genuine payload by scanning HEAD occurrences backward from EOF
/// and accepting only a candidate whose content actually deserializes into
/// a LookupTable — mirrors the plugin's `validate.mjs` `findExistingPayload()`.
///
/// A single `rfind(HEAD)` + `rfind(TAIL)` (the prior implementation) treats
/// ANY prose that merely quotes the marker syntax — e.g. a doc explaining
/// this format, such as this plugin's own skill instructions — as a
/// corrupt payload, because the marker text itself matches HEAD with no
/// real JSON following it. Scanning candidates backward and requiring a
/// successful deserialize before accepting one means prose mentions fall
/// through harmlessly to "no payload" instead of "corrupt payload".
///
/// The closing tail is the FIRST "-->" after the head, not the file's
/// last: `assemble.mjs` escapes every literal "-->" inside the JSON (A3),
/// so a genuine payload never contains one, and scanning for the file's
/// last "-->" lets content written after the payload (or a stray "-->"
/// elsewhere) corrupt the candidate slice.
fn find_genuine_payload(source: &str) -> Option<(usize, LookupTable)> {
    let mut search_end = source.len();
    loop {
        let head = source[..search_end].rfind(HEAD)?;
        let json_start = head + HEAD.len();
        if let Some(rel_tail) = source[json_start..].find(TAIL) {
            let tail = json_start + rel_tail;
            let json = source[json_start..tail].trim();
            if let Ok(table) = serde_json::from_str::<LookupTable>(json) {
                return Some((head, table));
            }
        }
        if head == 0 {
            return None;
        }
        search_end = head;
    }
}

/// True when marker-LIKE text sits at EOF (nothing but whitespace follows)
/// without being a genuine payload — almost certainly a damaged payload
/// (truncated JSON, mangled merge) rather than prose describing the
/// format, which has real content around it. Mirrors `validate.mjs`'s
/// `hasDamagedEofMarker()`.
fn has_damaged_eof_marker(source: &str) -> bool {
    let Some(last_head) = source.rfind(HEAD) else {
        return false;
    };
    let json_start = last_head + HEAD.len();
    let block_end = match source[json_start..].find(TAIL) {
        Some(rel_tail) => json_start + rel_tail + TAIL.len(),
        None => source.len(),
    };
    source[block_end..].trim().is_empty()
}

/// Returns `(head_offset, table)` on success so callers can slice the
/// pre-payload region (for docHash/verify_ids) from the SAME position this
/// function found, rather than re-deriving it with their own `rfind(HEAD)`
/// — which would reintroduce the prose-false-positive this function exists
/// to avoid (a later, non-genuine HEAD occurrence — e.g. prose describing
/// the format appearing after a real payload — would win a fresh rfind but
/// isn't where this function's payload actually starts).
pub fn extract_payload(source: &str) -> Option<Result<(usize, LookupTable), String>> {
    if let Some((head, table)) = find_genuine_payload(source) {
        return Some(table.validate().map(|_| (head, table)));
    }
    if has_damaged_eof_marker(source) {
        return Some(Err(
            "marker-like text at end of file did not parse as a valid payload \
             (truncated JSON or corrupted merge)"
                .to_string(),
        ));
    }
    None
}
