//! `Repo::pull` runs as a cancellable fetch followed by an uncancellable
//! merge / rebase, instead of one `git pull`. These pin that the split is
//! invisible: for every mode and pull config, the result matches what a real
//! `git pull` does to an identical copy of the repo — same output lines, same
//! tree, same commit subjects, same conflict state — and that Cancel can stop
//! only the fetch.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};

use gitp_core::{Error, NetworkHooks, Progress, PullMode, Repo};
use tempfile::TempDir;

/// Ignore the developer's own git config (`pull.rebase`, `pull.ff`, ...) —
/// pull's behaviour depends on exactly that. Every test calls this before
/// running git, so the variables are set before any thread spawns a process.
fn hermetic() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    });
}

/// Run git in `dir`; returns (success, stdout + stderr) like gitp's `run_git`.
fn run(dir: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new("git")
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .expect("run git");
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text.trim().to_string())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let (ok, out) = run(dir, args);
    assert!(ok, "git {args:?} failed in {dir:?}: {out}");
    out
}

fn commit(dir: &Path, file: &str, content: &str, message: &str) {
    std::fs::write(dir.join(file), content).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", message]);
}

/// A bare remote with `shared.txt` on main; `ours` (the repo under test,
/// tracking origin/main) and `theirs` (a teammate) are both clones of it.
struct Fixture {
    _dirs: Vec<TempDir>,
    ours: PathBuf,
    theirs: PathBuf,
}

fn fixture() -> Fixture {
    hermetic();
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let url = format!("file://{}", remote.path().display());
    let clone = |dir: &TempDir| {
        let path = dir.path().join("repo");
        git(dir.path(), &["clone", "-q", &url, "repo"]);
        git(&path, &["config", "user.name", "Tester"]);
        git(&path, &["config", "user.email", "t@t.io"]);
        path
    };
    let (a, b) = (TempDir::new().unwrap(), TempDir::new().unwrap());
    let theirs = clone(&b);
    commit(&theirs, "shared.txt", "one\ntwo\nthree\n", "base");
    git(&theirs, &["push", "-q", "-u", "origin", "main"]);
    let ours = clone(&a);
    Fixture {
        _dirs: vec![remote, a, b],
        ours,
        theirs,
    }
}

/// The teammate pushes a commit that `ours` doesn't have.
fn they_push(f: &Fixture, file: &str, content: &str) {
    commit(&f.theirs, file, content, "theirs");
    git(&f.theirs, &["push", "-q"]);
}

fn head(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"])
}

/// What a pull left behind, minus the commit ids (which embed a timestamp, so
/// differ between the two copies): the output lines (sorted — `git pull` lists
/// the merge's stdout before the fetch's stderr, gitp the other way round),
/// the tree, the commit subjects, and any merge / rebase in progress.
#[derive(Debug, PartialEq)]
struct Outcome {
    ok: bool,
    lines: Vec<String>,
    tree: String,
    subjects: String,
    status: String,
    merging: bool,
    rebasing: bool,
}

fn outcome(dir: &Path, ok: bool, text: &str) -> Outcome {
    let mut lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).collect();
    lines.sort();
    Outcome {
        ok,
        lines,
        tree: git(dir, &["rev-parse", "HEAD^{tree}"]),
        subjects: git(dir, &["log", "--topo-order", "--format=%s%x09%p"])
            .lines()
            .map(|l| {
                let (subject, parents) = l.split_once('\t').unwrap_or((l, ""));
                format!("{subject} ({} parents)", parents.split_whitespace().count())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        status: git(dir, &["status", "--porcelain"]),
        merging: dir.join(".git/MERGE_HEAD").exists(),
        rebasing: dir.join(".git/rebase-merge").exists() || dir.join(".git/rebase-apply").exists(),
    }
}

/// Pull `ours` with gitp and an identical copy with `git pull <args>`, and
/// demand the same outcome. Returns gitp's.
fn same_as_git_pull(f: &Fixture, mode: PullMode, args: &[&str]) -> Outcome {
    let twin_dir = TempDir::new().unwrap();
    let twin = twin_dir.path().join("repo");
    let copied = Command::new("cp")
        .args(["-R", f.ours.to_str().unwrap(), twin.to_str().unwrap()])
        .status()
        .unwrap();
    assert!(copied.success());

    let gitp = Repo::open(&f.ours).unwrap().pull(mode);
    let (ok, text) = match &gitp {
        Ok(out) => (true, out.clone()),
        Err(e) => (false, e.to_string()),
    };
    let ours = outcome(&f.ours, ok, &text);

    let mut pull_args = vec!["pull"];
    pull_args.extend_from_slice(args);
    let (ok, text) = run(&twin, &pull_args);
    let real = outcome(&twin, ok, &text);

    assert_eq!(
        ours, real,
        "gitp's pull ({mode:?}) differs from `git {pull_args:?}`"
    );
    ours
}

const MODES: [(PullMode, &[&str]); 3] = [
    (PullMode::FastForward, &[]),
    (PullMode::FastForwardOnly, &["--ff-only"]),
    (PullMode::Rebase, &["--rebase"]),
];

/// One `#[test]` per pull mode for a check that takes `(mode, git pull args)`,
/// so the (slow, git-bound) cases run in parallel.
macro_rules! for_each_mode {
    ($name:ident, $check:expr) => {
        mod $name {
            use super::*;
            const CHECK: fn(PullMode, &[&str]) = $check;
            #[test]
            fn fast_forward() {
                CHECK(MODES[0].0, MODES[0].1)
            }
            #[test]
            fn fast_forward_only() {
                CHECK(MODES[1].0, MODES[1].1)
            }
            #[test]
            fn rebase() {
                CHECK(MODES[2].0, MODES[2].1)
            }
        }
    };
}

for_each_mode!(fast_forwards_a_branch_that_is_only_behind, |mode, args| {
    let f = fixture();
    they_push(&f, "new.txt", "theirs\n");
    let out = same_as_git_pull(&f, mode, args);
    assert!(out.ok, "{mode:?}: {:?}", out.lines);
    assert_eq!(head(&f.ours), head(&f.theirs), "{mode:?}");
});

for_each_mode!(reports_already_up_to_date, |mode, args| {
    let f = fixture();
    let out = same_as_git_pull(&f, mode, args);
    assert!(out.ok, "{mode:?}: {:?}", out.lines);
});

/// Both sides have a commit the other lacks; pull with `mode` under the given
/// local `config` and expect git pull's verdict.
fn diverged(mode: PullMode, args: &[&str], config: &[(&str, &str)], ok: bool) {
    let f = fixture();
    they_push(&f, "theirs.txt", "theirs\n");
    commit(&f.ours, "ours.txt", "ours\n", "ours");
    for (key, value) in config {
        git(&f.ours, &["config", key, value]);
    }
    let before = head(&f.ours);
    let out = same_as_git_pull(&f, mode, args);
    assert_eq!(out.ok, ok, "{mode:?} {config:?}: {:?}", out.lines);
    if !ok {
        assert_eq!(
            head(&f.ours),
            before,
            "a refused pull leaves the branch alone"
        );
    }
}

#[test]
fn diverged_with_no_strategy_configured_is_refused_with_gits_advice() {
    diverged(PullMode::FastForward, &[], &[], false);
}

#[test]
fn diverged_with_pull_rebase_false_merges() {
    diverged(
        PullMode::FastForward,
        &[],
        &[("pull.rebase", "false")],
        true,
    );
}

#[test]
fn diverged_with_pull_rebase_true_rebases() {
    diverged(PullMode::FastForward, &[], &[("pull.rebase", "true")], true);
}

#[test]
fn diverged_with_pull_ff_false_merges() {
    diverged(PullMode::FastForward, &[], &[("pull.ff", "false")], true);
}

#[test]
fn diverged_with_pull_ff_only_is_refused() {
    diverged(PullMode::FastForward, &[], &[("pull.ff", "only")], false);
}

#[test]
fn diverged_branch_rebase_config_beats_pull_rebase() {
    diverged(
        PullMode::FastForward,
        &[],
        &[("branch.main.rebase", "true"), ("pull.rebase", "false")],
        true,
    );
}

#[test]
fn diverged_ff_only_beats_configured_rebase() {
    diverged(
        PullMode::FastForwardOnly,
        &["--ff-only"],
        &[("pull.rebase", "true")],
        false,
    );
}

#[test]
fn diverged_explicit_rebase_overrides_pull_ff_only() {
    diverged(
        PullMode::Rebase,
        &["--rebase"],
        &[("pull.ff", "only")],
        true,
    );
}

#[test]
fn a_rebase_pull_with_nothing_new_upstream_leaves_local_commits_alone() {
    let f = fixture();
    commit(&f.ours, "ours.txt", "ours\n", "ours");
    let out = same_as_git_pull(&f, PullMode::Rebase, &["--rebase"]);
    assert!(out.ok);
}

#[test]
fn a_merge_conflict_is_reported_and_left_in_progress_as_git_pull_does() {
    let f = fixture();
    they_push(&f, "shared.txt", "one\nTHEIRS\nthree\n");
    commit(&f.ours, "shared.txt", "one\nOURS\nthree\n", "ours");
    git(&f.ours, &["config", "pull.rebase", "false"]);

    let out = same_as_git_pull(&f, PullMode::FastForward, &[]);
    assert!(!out.ok);
    assert!(out.merging, "the merge is left for the resolver");
    assert!(
        out.lines
            .iter()
            .any(|l| l.starts_with("CONFLICT (content)")),
        "{:?}",
        out.lines
    );
}

#[test]
fn a_rebase_conflict_is_reported_and_left_in_progress_as_git_pull_does() {
    let f = fixture();
    they_push(&f, "shared.txt", "one\nTHEIRS\nthree\n");
    commit(&f.ours, "shared.txt", "one\nOURS\nthree\n", "ours");

    let out = same_as_git_pull(&f, PullMode::Rebase, &["--rebase"]);
    assert!(!out.ok);
    assert!(out.rebasing, "the rebase is left for the resolver");
    assert!(
        out.lines.iter().any(|l| l.starts_with("CONFLICT")),
        "{:?}",
        out.lines
    );
}

/// Open `ours` with a cancel flag that `raise_on` decides when to raise, and
/// record every update.
fn open_cancelling(
    f: &Fixture,
    raise_on: fn(&Progress) -> bool,
) -> (Repo, Arc<Mutex<Vec<Progress>>>) {
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let mut repo = Repo::open(&f.ours).unwrap();
    repo.set_network_hooks(NetworkHooks {
        on_progress: Some(Box::new(move |p: &Progress| {
            sink.lock().unwrap().push(p.clone());
            if raise_on(p) {
                flag.store(true, Ordering::SeqCst);
            }
        })),
        cancel: Some(cancel),
    });
    (repo, seen)
}

/// Any `*.lock` file left anywhere in the repo's `.git`.
fn stale_locks(dir: &Path) -> Vec<String> {
    let out = Command::new("find")
        .args([dir.join(".git").to_str().unwrap(), "-name", "*.lock"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

for_each_mode!(
    cancelling_during_the_fetch_leaves_branch_index_and_worktree_untouched,
    |mode, _| {
        {
            let f = fixture();
            // Enough objects that the fetch reports meters to cancel on.
            for i in 0..30 {
                let body: String = (0..40).map(|l| format!("{i} line {l}\n")).collect();
                std::fs::write(f.theirs.join(format!("f{i}.txt")), body).unwrap();
            }
            git(&f.theirs, &["add", "."]);
            git(&f.theirs, &["commit", "-q", "-m", "big"]);
            git(&f.theirs, &["push", "-q"]);
            std::fs::write(f.ours.join("wip.txt"), "uncommitted\n").unwrap();
            let before = (head(&f.ours), git(&f.ours, &["status", "--porcelain"]));

            // Cancel on the first fetch meter.
            let (repo, seen) = open_cancelling(&f, |p| p.cancellable);
            let result = repo.pull(mode);

            assert!(
                matches!(result, Err(Error::Cancelled)),
                "{mode:?}: {result:?}"
            );
            assert!(
                seen.lock().unwrap().iter().all(|p| p.cancellable),
                "{mode:?}: the local step never started"
            );
            assert_eq!(
                (head(&f.ours), git(&f.ours, &["status", "--porcelain"])),
                before,
                "{mode:?}: branch, index and worktree as they were"
            );
            assert!(!f.ours.join(".git/MERGE_HEAD").exists());
            assert_eq!(stale_locks(&f.ours), Vec::<String>::new(), "{mode:?}");
        }
    }
);

for_each_mode!(a_cancel_once_the_merge_has_started_is_ignored, |mode, _| {
    {
        let f = fixture();
        they_push(&f, "new.txt", "theirs\n");

        // Raise the flag the moment the local step announces itself.
        let (repo, seen) = open_cancelling(&f, |p| !p.cancellable);
        let out = repo.pull(mode).expect("the pull completes regardless");

        assert!(out.contains("Fast-forward"), "{mode:?}: {out}");
        assert_eq!(head(&f.ours), head(&f.theirs), "{mode:?}");
        let seen = seen.lock().unwrap();
        let local: Vec<_> = seen.iter().filter(|p| !p.cancellable).collect();
        assert_eq!(local.len(), 1, "{mode:?}: one local-step update");
        assert_eq!(local[0].phase, "Fast-forwarding");
    }
});
