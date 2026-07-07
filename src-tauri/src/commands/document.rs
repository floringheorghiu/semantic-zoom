use crate::parser::payload::extract_payload;
use crate::parser::LookupTable;
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoadResult {
    /// Engine A succeeded — render immediately.
    Native { table: LookupTable, raw: String },
    /// No payload found — frontend shows k=0 immediately and
    /// routes to Engine B (stub in Phase 1).
    Untagged { raw: String },
    /// Payload present but invalid — show k=0 + non-modal warning badge.
    Corrupt { raw: String, error: String },
}

#[tauri::command]
pub fn load_document(path: String) -> Result<LoadResult, String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match extract_payload(&raw) {
        None => Ok(LoadResult::Untagged { raw }),
        Some(Err(error)) => Ok(LoadResult::Corrupt { raw, error }),
        Some(Ok(table)) => {
            // A1/A2: verify against the pre-payload region only.
            let head = "<!-- semantic-zoom:payload:v1";
            let pre = &raw[..raw.rfind(head).unwrap()];
            match table.verify_ids(pre) {
                Ok(()) => Ok(LoadResult::Native { table, raw }),
                Err(error) => Ok(LoadResult::Corrupt { raw, error }),
            }
        }
    }
}
