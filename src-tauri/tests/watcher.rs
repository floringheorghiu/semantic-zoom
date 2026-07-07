use semantic_zoom_lib::watcher::debounced::is_atomic_sibling;
use std::path::Path;

#[test]
fn atomic_siblings_match_target_stem() {
    assert!(is_atomic_sibling(Path::new("/d/file.md.tmp"), Path::new("/d/file.md")));
    assert!(is_atomic_sibling(Path::new("/d/.file.md.swp"), Path::new("/d/file.md")));
    assert!(!is_atomic_sibling(Path::new("/d/other.md"), Path::new("/d/file.md")));
}
