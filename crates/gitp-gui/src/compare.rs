//! Comparing two revisions (commits, branches or tags) in the detail pane: the
//! comparison itself and the per-file re-diff behind its context controls.

use gitp_core::{Comparison, FileDiff};
use tauri::State;

use crate::state::{with_repo, RepoState};

fn compare_revs_impl(
    state: &RepoState,
    base: String,
    head: String,
    three_dot: bool,
) -> Result<Comparison, String> {
    with_repo(state, |repo| repo.compare(&base, &head, three_dot))
}

fn get_compare_file_diff_impl(
    state: &RepoState,
    base: String,
    head: String,
    three_dot: bool,
    path: String,
    old_path: Option<String>,
    context_lines: u32,
) -> Result<Option<FileDiff>, String> {
    with_repo(state, |repo| {
        repo.compare_file_diff(
            &base,
            &head,
            three_dot,
            &path,
            old_path.as_deref(),
            context_lines,
        )
    })
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn compare_revs(
    base: String,
    head: String,
    three_dot: bool,
    state: State<RepoState>,
) -> Result<Comparison, String> {
    compare_revs_impl(&state, base, head, three_dot)
}

#[tauri::command(async)]
pub(crate) fn get_compare_file_diff(
    base: String,
    head: String,
    three_dot: bool,
    path: String,
    old_path: Option<String>,
    context_lines: u32,
    state: State<RepoState>,
) -> Result<Option<FileDiff>, String> {
    get_compare_file_diff_impl(&state, base, head, three_dot, path, old_path, context_lines)
}

#[cfg(test)]
mod tests {
    use super::{compare_revs_impl, get_compare_file_diff_impl};
    use crate::state::RepoState;
    use crate::test_support::{git, make_repo};
    use crate::workspace::open_repo_impl;

    #[test]
    fn compares_two_refs_of_the_active_repo() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c0", "c1"]); // each commit rewrites f.txt
        git(dir.path(), &["tag", "old", "HEAD~1"]);
        let state = RepoState::default();
        open_repo_impl(&state, dir.path().to_str().unwrap().to_string()).expect("open");

        let cmp = compare_revs_impl(&state, "old".into(), "HEAD".into(), false).expect("compare");
        assert_eq!(cmp.base.rev, "old");
        assert_eq!((cmp.ahead, cmp.behind), (1, 0));
        assert_eq!(cmp.files.len(), 1);
        assert_eq!(cmp.files[0].path, "f.txt");

        let file = get_compare_file_diff_impl(
            &state,
            "old".into(),
            "HEAD".into(),
            true,
            "f.txt".into(),
            None,
            0,
        )
        .expect("file diff");
        assert_eq!(file.map(|f| f.path), Some("f.txt".to_string()));

        assert!(compare_revs_impl(&state, "old".into(), "nope".into(), false).is_err());
    }
}
