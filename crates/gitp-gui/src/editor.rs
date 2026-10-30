//! The in-app file editor's commands: read a working-tree file as text, save
//! it, create a new one, delete one, and list the files to pick from.
//!
//! Saving, creating and deleting are recorded like a discard — the file's
//! bytes on both sides — so Undo puts the file back exactly.

use gitp_core::TextFile;
use tauri::State;

use crate::state::{with_repo, RepoState};
use crate::undo::with_recorded_files;

/// `path` as text, `None` when it doesn't exist.
fn read_text_file_impl(state: &RepoState, path: String) -> Result<Option<TextFile>, String> {
    with_repo(state, |repo| repo.read_text_file(&path))
}

/// Save `text` to `path`, with `\r\n` line breaks when `crlf`.
fn write_text_file_impl(
    state: &RepoState,
    path: String,
    text: String,
    crlf: bool,
) -> Result<(), String> {
    let paths = [path.clone()];
    with_recorded_files(state, format!("Edit {path}"), &paths, |repo| {
        repo.write_text_file(&path, &text, crlf)
    })
}

/// Create `path` as an empty file, with its folders.
fn create_file_impl(state: &RepoState, path: String) -> Result<(), String> {
    let paths = [path.clone()];
    with_recorded_files(state, format!("Create {path}"), &paths, |repo| {
        repo.create_file(&path)
    })
}

/// Delete the working-tree file `path`.
fn delete_file_impl(state: &RepoState, path: String) -> Result<(), String> {
    let paths = [path.clone()];
    with_recorded_files(state, format!("Delete {path}"), &paths, |repo| {
        repo.delete_file(&path)
    })
}

/// Every tracked and untracked (not ignored) file in the working tree.
fn list_work_files_impl(state: &RepoState) -> Result<Vec<String>, String> {
    with_repo(state, |repo| repo.list_work_files())
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn read_text_file(
    path: String,
    state: State<RepoState>,
) -> Result<Option<TextFile>, String> {
    read_text_file_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn write_text_file(
    path: String,
    text: String,
    crlf: bool,
    state: State<RepoState>,
) -> Result<(), String> {
    write_text_file_impl(&state, path, text, crlf)
}

#[tauri::command(async)]
pub(crate) fn create_file(path: String, state: State<RepoState>) -> Result<(), String> {
    create_file_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn delete_file(path: String, state: State<RepoState>) -> Result<(), String> {
    delete_file_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn list_work_files(state: State<RepoState>) -> Result<Vec<String>, String> {
    list_work_files_impl(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::make_repo;
    use crate::undo::{undo_impl, undo_state_impl};
    use crate::workspace::open_repo_impl;

    #[test]
    fn saving_creating_and_deleting_are_undoable() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).unwrap();
        let f = dir.path().join("f.txt");

        write_text_file_impl(&state, "f.txt".into(), "edited\n".into(), true).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"edited\r\n");
        assert_eq!(
            undo_state_impl(&state).unwrap().undo.as_deref(),
            Some("Edit f.txt")
        );
        undo_impl(&state).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"line 0\n");

        delete_file_impl(&state, "f.txt".into()).unwrap();
        assert!(!f.exists());
        undo_impl(&state).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"line 0\n");

        create_file_impl(&state, "new/a.md".into()).unwrap();
        assert!(dir.path().join("new/a.md").exists());
        undo_impl(&state).unwrap();
        assert!(!dir.path().join("new/a.md").exists());
    }

    #[test]
    fn undoing_a_delete_brings_the_file_back_with_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).unwrap();
        let script = dir.path().join("run.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        delete_file_impl(&state, "run.sh".into()).unwrap();
        undo_impl(&state).unwrap();

        let mode = std::fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn nothing_outside_the_working_tree_is_touched() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).unwrap();

        for bad in ["../x.txt", "/tmp/x.txt", ".git/config"] {
            assert!(read_text_file_impl(&state, bad.into()).is_err(), "{bad}");
            assert!(
                write_text_file_impl(&state, bad.into(), "x".into(), false).is_err(),
                "{bad}"
            );
            assert!(create_file_impl(&state, bad.into()).is_err(), "{bad}");
            assert!(delete_file_impl(&state, bad.into()).is_err(), "{bad}");
        }
    }
}
