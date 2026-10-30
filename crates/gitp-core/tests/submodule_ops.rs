//! Submodules: their status, `update --init --recursive` (one or all, with
//! progress), `sync`, and how a moved submodule shows up in Local Changes.
//! The submodule is a local repo cloned over `file://`, so no network is
//! involved.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, Once};

use gitp_core::{NetworkHooks, Repo, SubmoduleState};
use tempfile::TempDir;

/// Git ≥ 2.38 refuses `file://` submodules by default (CVE-2022-39253). Allow
/// them for this test process — and every git it spawns, including the ones
/// gitp-core runs — through git's environment config. Set once, before any
/// test spawns anything.
fn allow_file_protocol() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::env::set_var("GIT_CONFIG_COUNT", "1");
        std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
        std::env::set_var("GIT_CONFIG_VALUE_0", "always");
    });
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed in {dir:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Tester"]);
    git(dir, &["config", "user.email", "t@t.io"]);
}

/// A library repo with two commits, and a superproject with it checked out
/// as submodule `lib` at the second.
struct Setup {
    _root: TempDir,
    lib: std::path::PathBuf,
    sup: std::path::PathBuf,
    first: String,
    second: String,
}

fn setup() -> Setup {
    allow_file_protocol();
    let root = TempDir::new().unwrap();
    let lib = root.path().join("lib");
    let sup = root.path().join("super");
    std::fs::create_dir(&lib).unwrap();
    std::fs::create_dir(&sup).unwrap();

    init_repo(&lib);
    std::fs::write(lib.join("lib.txt"), "v1\n").unwrap();
    git(&lib, &["add", "."]);
    git(&lib, &["commit", "-q", "-m", "lib v1"]);
    let first = git(&lib, &["rev-parse", "HEAD"]);
    std::fs::write(lib.join("lib.txt"), "v2\n").unwrap();
    git(&lib, &["commit", "-q", "-am", "lib v2"]);
    let second = git(&lib, &["rev-parse", "HEAD"]);

    init_repo(&sup);
    std::fs::write(sup.join("app.txt"), "app\n").unwrap();
    let url = format!("file://{}", lib.display());
    git(&sup, &["submodule", "add", "-q", &url, "lib"]);
    git(&sup, &["add", "."]);
    git(&sup, &["commit", "-q", "-m", "add lib"]);
    Setup {
        _root: root,
        lib,
        sup,
        first,
        second,
    }
}

#[test]
fn a_repo_without_submodules_lists_none() {
    let s = setup();
    assert!(Repo::open(&s.lib).unwrap().submodules().unwrap().is_empty());
}

#[test]
fn lists_a_checked_out_submodule_as_up_to_date() {
    let s = setup();
    let list = Repo::open(&s.sup).unwrap().submodules().unwrap();
    assert_eq!(list.len(), 1);
    let sm = &list[0];
    assert_eq!(sm.name, "lib");
    assert_eq!(sm.path, "lib");
    assert_eq!(
        sm.url.as_deref(),
        Some(format!("file://{}", s.lib.display()).as_str())
    );
    assert_eq!(sm.recorded.as_deref(), Some(s.second.as_str()));
    assert_eq!(sm.checked_out.as_deref(), Some(s.second.as_str()));
    assert_eq!(sm.state, SubmoduleState::UpToDate);
}

#[test]
fn a_different_commit_checked_out_is_modified() {
    let s = setup();
    git(&s.sup.join("lib"), &["checkout", "-q", &s.first]);

    let sm = &Repo::open(&s.sup).unwrap().submodules().unwrap()[0];
    assert_eq!(sm.state, SubmoduleState::Modified);
    assert_eq!(sm.recorded.as_deref(), Some(s.second.as_str()));
    assert_eq!(sm.checked_out.as_deref(), Some(s.first.as_str()));
}

#[test]
fn local_edits_inside_the_submodule_make_it_dirty() {
    let s = setup();
    std::fs::write(s.sup.join("lib/lib.txt"), "edited\n").unwrap();

    let sm = &Repo::open(&s.sup).unwrap().submodules().unwrap()[0];
    assert_eq!(sm.state, SubmoduleState::Dirty);
}

#[test]
fn a_fresh_clone_has_it_uninitialized_until_updated_with_progress() {
    let s = setup();
    let clone = s.sup.parent().unwrap().join("clone");
    git(
        s.sup.parent().unwrap(),
        &["clone", "-q", s.sup.to_str().unwrap(), "clone"],
    );

    let sm = &Repo::open(&clone).unwrap().submodules().unwrap()[0];
    assert_eq!(sm.state, SubmoduleState::Uninitialized);
    assert_eq!(sm.checked_out, None);

    let phases = Arc::new(Mutex::new(Vec::new()));
    let mut repo = Repo::open(&clone).unwrap();
    let seen = Arc::clone(&phases);
    repo.set_network_hooks(NetworkHooks {
        on_progress: Some(Box::new(move |p| {
            seen.lock().unwrap().push(p.phase.clone())
        })),
        cancel: Some(Arc::new(AtomicBool::new(false))),
        ..Default::default()
    });
    repo.update_submodules(Some("lib")).unwrap();

    let sm = &Repo::open(&clone).unwrap().submodules().unwrap()[0];
    assert_eq!(sm.state, SubmoduleState::UpToDate);
    assert_eq!(sm.checked_out.as_deref(), Some(s.second.as_str()));
    assert!(clone.join("lib/lib.txt").exists());
    // The clone's meters went through the hooks, not into the output.
    assert!(
        !phases.lock().unwrap().is_empty(),
        "clone progress was reported"
    );
}

#[test]
fn update_all_checks_out_the_recorded_commit() {
    let s = setup();
    git(&s.sup.join("lib"), &["checkout", "-q", &s.first]);

    Repo::open(&s.sup).unwrap().update_submodules(None).unwrap();

    let sm = &Repo::open(&s.sup).unwrap().submodules().unwrap()[0];
    assert_eq!(sm.state, SubmoduleState::UpToDate);
    assert_eq!(sm.checked_out.as_deref(), Some(s.second.as_str()));
}

#[test]
fn sync_copies_the_url_from_gitmodules_into_the_config() {
    let s = setup();
    git(
        &s.sup,
        &[
            "config",
            "-f",
            ".gitmodules",
            "submodule.lib.url",
            "file:///moved/lib",
        ],
    );

    Repo::open(&s.sup).unwrap().sync_submodules(None).unwrap();
    assert_eq!(
        git(&s.sup, &["config", "submodule.lib.url"]),
        "file:///moved/lib"
    );
}

#[test]
fn a_moved_submodule_diffs_as_a_subproject_commit_change() {
    let s = setup();
    git(&s.sup.join("lib"), &["checkout", "-q", &s.first]);
    let repo = Repo::open(&s.sup).unwrap();

    let status = repo.status_summary().unwrap();
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "lib");

    // The shape Local Changes recognises a submodule by (see submodule-diff.ts).
    let diff = repo.file_diff("lib", false, 3, None).unwrap().unwrap();
    let lines: Vec<String> = diff.hunks[0]
        .lines
        .iter()
        .map(|l| format!("{}{}", l.origin, l.content))
        .collect();
    assert_eq!(
        lines,
        [
            format!("-Subproject commit {}", s.second),
            format!("+Subproject commit {}", s.first),
        ]
    );
}
