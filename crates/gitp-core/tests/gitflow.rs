//! Git Flow done with plain git: initialise, start, finish — including a
//! release's tag and its merge back into develop, and a finish that stops on a
//! conflict and is completed by running it again.

mod common;

use std::path::Path;
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{FlowKind, GitFlowConfig, Repo};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, contents: &str, message: &str) {
    std::fs::write(dir.join(file), contents).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", message]);
}

fn rev(dir: &Path, rev: &str) -> String {
    git(dir, &["rev-parse", rev])
}

fn exists(dir: &Path, refname: &str) -> bool {
    Command::new("git")
        .current_dir(dir)
        .args(["rev-parse", "--verify", "--quiet", refname])
        .output()
        .unwrap()
        .status
        .success()
}

fn config(production: &str) -> GitFlowConfig {
    GitFlowConfig {
        production: production.into(),
        develop: "develop".into(),
        feature: "feature/".into(),
        release: "release/".into(),
        hotfix: "hotfix/".into(),
        version_tag: "v".into(),
    }
}

/// A repo with one commit, initialised for Git Flow. Returns it and the name of
/// its production branch (`git init`'s default, which depends on the host).
fn flow_repo() -> (FixtureRepo, String) {
    let fx = FixtureRepo::init();
    commit(fx.path(), "a.txt", "one\n", "first");
    let production = git(fx.path(), &["rev-parse", "--abbrev-ref", "HEAD"]);
    Repo::open(fx.path())
        .unwrap()
        .gitflow_init(&config(&production))
        .expect("init");
    (fx, production)
}

#[test]
fn init_stores_the_git_flow_keys_and_creates_develop() {
    let fx = FixtureRepo::init();
    commit(fx.path(), "a.txt", "one\n", "first");
    let production = git(fx.path(), &["rev-parse", "--abbrev-ref", "HEAD"]);
    let repo = Repo::open(fx.path()).unwrap();
    assert_eq!(repo.gitflow_config().unwrap(), None, "not set up yet");

    repo.gitflow_init(&config(&production)).expect("init");

    assert_eq!(repo.gitflow_config().unwrap(), Some(config(&production)));
    // The keys git-flow itself reads, so the two interoperate.
    let dir = fx.path();
    assert_eq!(git(dir, &["config", "gitflow.branch.master"]), production);
    assert_eq!(git(dir, &["config", "gitflow.branch.develop"]), "develop");
    assert_eq!(git(dir, &["config", "gitflow.prefix.feature"]), "feature/");
    assert_eq!(git(dir, &["config", "gitflow.prefix.versiontag"]), "v");
    assert_eq!(git(dir, &["config", "gitflow.prefix.support"]), "support/");
    assert_eq!(
        rev(dir, "develop"),
        rev(dir, &production),
        "develop starts at production"
    );
    assert_eq!(
        git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]),
        production,
        "nothing is checked out"
    );
}

#[test]
fn init_refuses_a_missing_production_branch_and_identical_branches() {
    let fx = FixtureRepo::init();
    commit(fx.path(), "a.txt", "one\n", "first");
    let repo = Repo::open(fx.path()).unwrap();
    assert!(repo.gitflow_init(&config("no-such-branch")).is_err());
    let mut same = config("develop");
    same.develop = "develop".into();
    assert!(repo.gitflow_init(&same).is_err());
    assert_eq!(repo.gitflow_config().unwrap(), None, "nothing was stored");
}

#[test]
fn a_git_flow_config_written_by_git_flow_itself_is_read() {
    let fx = FixtureRepo::init();
    commit(fx.path(), "a.txt", "one\n", "first");
    let dir = fx.path();
    git(dir, &["config", "gitflow.branch.master", "main"]);
    git(dir, &["config", "gitflow.branch.develop", "dev"]);
    git(dir, &["config", "gitflow.prefix.feature", "feat/"]);
    git(dir, &["config", "gitflow.prefix.versiontag", ""]);
    let cfg = Repo::open(dir).unwrap().gitflow_config().unwrap().unwrap();
    assert_eq!(cfg.production, "main");
    assert_eq!(cfg.develop, "dev");
    assert_eq!(cfg.feature, "feat/");
    assert_eq!(cfg.release, "release/", "an unset prefix takes the default");
    assert_eq!(cfg.version_tag, "");
}

#[test]
fn classify_names_the_kind_and_strips_the_prefix() {
    let cfg = config("main");
    assert_eq!(
        cfg.classify("feature/login"),
        Some((FlowKind::Feature, "login"))
    );
    assert_eq!(
        cfg.classify("release/1.2"),
        Some((FlowKind::Release, "1.2"))
    );
    assert_eq!(
        cfg.classify("hotfix/1.2.1"),
        Some((FlowKind::Hotfix, "1.2.1"))
    );
    assert_eq!(
        cfg.classify("feature/"),
        None,
        "a bare prefix names nothing"
    );
    assert_eq!(cfg.classify("main"), None);
}

#[test]
fn start_branches_features_from_develop_and_hotfixes_from_production() {
    let (fx, production) = flow_repo();
    let dir = fx.path();
    // Move develop on, so the two starting points differ.
    git(dir, &["switch", "-q", "develop"]);
    commit(dir, "b.txt", "dev\n", "on develop");
    let repo = Repo::open(dir).unwrap();

    repo.gitflow_start(FlowKind::Feature, "login")
        .expect("start feature");
    assert_eq!(
        git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/login"
    );
    assert_eq!(rev(dir, "feature/login"), rev(dir, "develop"));

    repo.gitflow_start(FlowKind::Hotfix, "1.0.1")
        .expect("start hotfix");
    assert_eq!(
        git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "hotfix/1.0.1"
    );
    assert_eq!(rev(dir, "hotfix/1.0.1"), rev(dir, &production));

    assert!(
        repo.gitflow_start(FlowKind::Release, "  ").is_err(),
        "a name is needed"
    );
}

#[test]
fn start_refuses_when_git_flow_is_not_set_up() {
    let fx = FixtureRepo::init();
    commit(fx.path(), "a.txt", "one\n", "first");
    let err = Repo::open(fx.path())
        .unwrap()
        .gitflow_start(FlowKind::Feature, "x")
        .unwrap_err();
    assert!(err.to_string().contains("Initialize"), "{err}");
}

#[test]
fn finishing_a_feature_merges_it_into_develop_with_a_merge_commit_and_deletes_it() {
    let (fx, _) = flow_repo();
    let dir = fx.path();
    let repo = Repo::open(dir).unwrap();
    repo.gitflow_start(FlowKind::Feature, "login").unwrap();
    commit(dir, "login.txt", "login\n", "add login");
    let tip = rev(dir, "feature/login");
    let develop_before = rev(dir, "develop");

    repo.gitflow_finish("feature/login", None).expect("finish");

    assert_eq!(git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]), "develop");
    // --no-ff: a merge commit even though a fast-forward was possible.
    assert_eq!(rev(dir, "develop^1"), develop_before);
    assert_eq!(rev(dir, "develop^2"), tip);
    assert!(!exists(dir, "refs/heads/feature/login"), "branch deleted");
}

#[test]
fn finishing_a_release_merges_tags_and_merges_back_into_develop() {
    let (fx, production) = flow_repo();
    let dir = fx.path();
    let repo = Repo::open(dir).unwrap();
    repo.gitflow_start(FlowKind::Release, "1.0").unwrap();
    commit(dir, "VERSION", "1.0\n", "bump version");
    let tip = rev(dir, "release/1.0");

    let out = repo
        .gitflow_finish("release/1.0", Some("The first release"))
        .expect("finish");
    assert!(out.contains("tag v1.0"), "{out}");

    // Merged into production with a merge commit, and tagged there.
    assert_eq!(rev(dir, &format!("{production}^2")), tip);
    assert_eq!(rev(dir, "v1.0^{commit}"), rev(dir, &production));
    assert_eq!(
        git(dir, &["cat-file", "-t", "v1.0"]),
        "tag",
        "an annotated tag"
    );
    assert_eq!(
        git(dir, &["tag", "-l", "--format=%(contents)", "v1.0"]),
        "The first release"
    );
    // And back into develop, which ends up checked out.
    assert!(exists(dir, "develop^2"), "develop got a merge commit");
    assert_eq!(rev(dir, "develop^2"), tip);
    assert_eq!(git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]), "develop");
    assert!(!exists(dir, "refs/heads/release/1.0"), "branch deleted");
}

#[test]
fn finish_refuses_uncommitted_changes_and_changes_nothing() {
    let (fx, _) = flow_repo();
    let dir = fx.path();
    let repo = Repo::open(dir).unwrap();
    repo.gitflow_start(FlowKind::Feature, "x").unwrap();
    commit(dir, "x.txt", "x\n", "x");
    std::fs::write(dir.join("a.txt"), "edited\n").unwrap();
    let develop = rev(dir, "develop");

    let err = repo.gitflow_finish("feature/x", None).unwrap_err();
    assert!(err.to_string().contains("uncommitted"), "{err}");
    assert_eq!(
        git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/x"
    );
    assert_eq!(rev(dir, "develop"), develop);
    assert!(exists(dir, "refs/heads/feature/x"));
}

#[test]
fn a_hotfix_that_conflicts_with_develop_stops_there_and_finishing_again_completes_it() {
    let (fx, production) = flow_repo();
    let dir = fx.path();
    let repo = Repo::open(dir).unwrap();
    // develop and the hotfix both change a.txt: the back-merge conflicts.
    git(dir, &["switch", "-q", "develop"]);
    commit(dir, "a.txt", "develop's\n", "develop edit");
    repo.gitflow_start(FlowKind::Hotfix, "1.0.1").unwrap();
    commit(dir, "a.txt", "hotfix's\n", "hotfix edit");

    let err = repo
        .gitflow_finish("hotfix/1.0.1", None)
        .unwrap_err()
        .to_string();
    assert!(err.contains("conflicts"), "{err}");
    assert!(
        err.contains("delete hotfix/1.0.1"),
        "says what is left: {err}"
    );
    // Production is done — merged and tagged — and the back-merge is left in
    // progress for the conflict resolver.
    assert_eq!(rev(dir, "v1.0.1^{commit}"), rev(dir, &production));
    assert!(dir.join(".git/MERGE_HEAD").exists());
    assert_eq!(git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]), "develop");

    // Resolve, commit, and finish again: the remaining steps run.
    std::fs::write(dir.join("a.txt"), "both\n").unwrap();
    git(dir, &["add", "a.txt"]);
    git(dir, &["commit", "-q", "--no-edit"]);
    let tag_before = rev(dir, "v1.0.1");
    repo.gitflow_finish("hotfix/1.0.1", None)
        .expect("finish again");
    assert_eq!(
        rev(dir, "v1.0.1"),
        tag_before,
        "the tag is kept, not remade"
    );
    assert!(!exists(dir, "refs/heads/hotfix/1.0.1"), "branch deleted");
    assert_eq!(git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]), "develop");
}
