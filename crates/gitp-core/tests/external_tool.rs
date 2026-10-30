//! `git difftool` / `git mergetool` launched with the user's configured tool.

mod common;

use std::sync::Once;

use common::FixtureRepo;
use gitp_core::{DiffToolTarget, Repo};

/// Ignore the developer's own git config — whether a diff.tool is set is
/// exactly what these tests are about.
fn hermetic() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    });
}

/// A fixture whose diff tool `fake` appends each file it's shown to `out.txt`.
fn with_fake_tool() -> FixtureRepo {
    hermetic();
    let fx = FixtureRepo::init();
    let out = fx.path().join("out.txt");
    let mut cfg = fx.repo.config().unwrap();
    cfg.set_str("diff.tool", "fake").unwrap();
    cfg.set_str(
        "difftool.fake.cmd",
        &format!("printf '%s\\n' \"$MERGED\" >> '{}'", out.display()),
    )
    .unwrap();
    fx
}

fn shown(fx: &FixtureRepo) -> String {
    std::fs::read_to_string(fx.path().join("out.txt")).unwrap_or_default()
}

#[test]
fn without_a_configured_tool_nothing_is_launched() {
    hermetic();
    let fx = FixtureRepo::init();
    fx.commit_file("f.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    let paths = vec!["f.txt".to_string()];
    assert!(!repo
        .open_difftool(&DiffToolTarget::Commit("HEAD".into()), &paths)
        .unwrap());
    assert!(!repo.open_mergetool("f.txt").unwrap());
}

#[test]
fn diffs_a_commit_including_a_root_commit() {
    let fx = with_fake_tool();
    fx.commit_file("f.txt", "a\n", "c1");
    fx.commit_file("f.txt", "b\n", "c2");
    let repo = Repo::open(fx.path()).unwrap();
    let paths = vec!["f.txt".to_string()];

    assert!(repo
        .open_difftool(&DiffToolTarget::Commit("HEAD".into()), &paths)
        .unwrap());
    assert!(repo
        .open_difftool(&DiffToolTarget::Commit("HEAD^".into()), &paths)
        .unwrap());
    assert_eq!(shown(&fx), "f.txt\nf.txt\n");
}

#[test]
fn diffs_the_working_tree_and_the_index() {
    let fx = with_fake_tool();
    fx.commit_file("f.txt", "a\n", "c1");
    std::fs::write(fx.path().join("f.txt"), "b\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    let paths = vec!["f.txt".to_string()];

    assert!(repo
        .open_difftool(&DiffToolTarget::Unstaged, &paths)
        .unwrap());
    assert_eq!(shown(&fx), "f.txt\n");
    // Nothing staged: difftool has nothing to show.
    assert!(repo.open_difftool(&DiffToolTarget::Staged, &paths).unwrap());
    assert_eq!(shown(&fx), "f.txt\n");
}

#[test]
fn a_failing_tool_is_reported_and_options_are_refused() {
    let fx = with_fake_tool();
    fx.commit_file("f.txt", "a\n", "c1");
    fx.commit_file("f.txt", "b\n", "c2");
    {
        let mut cfg = fx.repo.config().unwrap();
        cfg.set_str("difftool.fake.cmd", "echo broken >&2; exit 3")
            .unwrap();
        cfg.set_bool("difftool.trustExitCode", true).unwrap();
    }
    let repo = Repo::open(fx.path()).unwrap();
    let paths = vec!["f.txt".to_string()];

    assert!(repo
        .open_difftool(&DiffToolTarget::Commit("HEAD".into()), &paths)
        .is_err());
    let flag = DiffToolTarget::Compare {
        base: "--output=x".into(),
        head: "HEAD".into(),
        three_dot: false,
    };
    assert!(repo.open_difftool(&flag, &paths).is_err());
}
