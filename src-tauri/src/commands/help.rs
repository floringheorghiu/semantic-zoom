// help.rs — installs the bundled zoomable help file (spec:
// docs/superpowers/specs/2026-07-17-zoomable-help-file-design.md).
//
// The help.md inside the .app bundle is a read-only TEMPLATE — writing to
// it would break the code signature, and the whole point of the help file
// is that users experiment on it (remove its layers, regenerate, edit).
// So opening Help copies the template to the app's config dir, ALWAYS
// overwriting: every ⌘? press restores a pristine zoomable demo no matter
// what the user did to the previous copy. The frontend then opens the
// returned path through the perfectly ordinary openFile path.

use crate::commands::write_payload::write_atomically;
use std::fs;
use std::path::Path;

/// Filename of the user-visible copy (also its window title).
const HELP_FILE_NAME: &str = "Semantic Zoom Help.md";

/// Copy `template` over `target`, creating parent directories as needed.
/// Atomic (write-then-rename) so a half-copied help file can never be
/// opened, even if the process dies mid-copy.
pub(crate) fn install_help_from(template: &Path, target: &Path) -> Result<(), String> {
    let contents = fs::read_to_string(template)
        .map_err(|e| format!("help template unreadable at {}: {e}", template.display()))?;
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomically(&target.to_string_lossy(), &contents)
}

#[tauri::command]
pub fn install_help_file(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    // Bundled build: Contents/Resources/resources/help.md (bundle.resources
    // preserves the source-relative path). Dev run: tauri copies resources
    // beside the debug binary, so resource_dir works there too — but fall
    // back to the source tree for cargo-test / unusual dev layouts.
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("resources").join("help.md"))
        .filter(|p| p.exists());
    let dev_fallback = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("help.md");
    let template = match bundled {
        Some(p) => p,
        None if dev_fallback.exists() => dev_fallback,
        None => return Err("help.md not found in app resources".to_string()),
    };

    let target = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(HELP_FILE_NAME);

    install_help_from(&template, &target)?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_template_to_target_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let template = dir.path().join("help.md");
        fs::write(&template, "# Help\n\nBody.\n").unwrap();
        let target = dir.path().join("out").join(HELP_FILE_NAME);

        install_help_from(&template, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), fs::read(&template).unwrap());
    }

    #[test]
    fn overwrites_a_mutilated_existing_copy() {
        // The user removed the payload / edited the copy — ⌘? must restore
        // the pristine template, not preserve the mutilated state.
        let dir = tempfile::tempdir().unwrap();
        let template = dir.path().join("help.md");
        fs::write(&template, "# Help\n\nPristine.\n").unwrap();
        let target = dir.path().join(HELP_FILE_NAME);
        fs::write(&target, "user-mutilated leftovers").unwrap();

        install_help_from(&template, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Help\n\nPristine.\n");
    }

    #[test]
    fn missing_template_is_an_error_and_target_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(HELP_FILE_NAME);
        fs::write(&target, "existing").unwrap();

        let err = install_help_from(&dir.path().join("nope.md"), &target).unwrap_err();
        assert!(err.contains("unreadable"), "got: {err}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "existing");
    }

    #[test]
    fn the_shipped_template_passes_the_apps_own_payload_gate() {
        // The real resources/help.md must be a valid zoomable document —
        // this is the automated stand-in for "the demo actually demos".
        let source = include_str!("../../resources/help.md");
        let (head, table) = crate::parser::payload::extract_payload(source)
            .expect("help.md must contain a payload")
            .expect("help.md payload must validate");
        table
            .verify_ids(&source[..head])
            .expect("help.md payload ids must verify");
    }
}
