use crate::parser::LookupTable;

const HEAD: &str = "<!-- semantic-zoom:payload:v1";
const TAIL: &str = "-->";

pub fn extract_payload(source: &str) -> Option<Result<LookupTable, String>> {
    let start = source.rfind(HEAD)?;               // rfind: payload lives at EOF
    let json_start = start + HEAD.len();
    let end = source[json_start..].rfind(TAIL)? + json_start; // last -->: hardens against unescaped occurrences
    let json = source[json_start..end].trim();
    Some(
        serde_json::from_str::<LookupTable>(json)
            .map_err(|e| e.to_string())
            .and_then(|t| t.validate().map(|_| t)),
    )
}
