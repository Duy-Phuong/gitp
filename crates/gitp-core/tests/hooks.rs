//! Git hooks: listing them and switching one off and on.

mod common;

use std::os::unix::fs::PermissionsExt;

use common::FixtureRepo;
use gitp_core::{HookState, Repo};

fn write_hook(dir: &std::path::Path, name: &str, mode: u32) {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn hooks_are_listed_with_their_state() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let dir = repo.hooks_dir().unwrap();
    assert!(dir.ends_with("hooks"), "{}", dir.display());
    write_hook(&dir, "pre-commit", 0o755);
    write_hook(&dir, "commit-msg", 0o644);
    write_hook(&dir, "pre-push.disabled", 0o755);
    // git's own templates are not hooks.
    write_hook(&dir, "post-update.sample", 0o755);

    let hooks = repo.hooks().unwrap();
    let state = |name: &str| hooks.hooks.iter().find(|h| h.name == name).unwrap().state;
    assert_eq!(state("pre-commit"), HookState::Active);
    assert_eq!(state("commit-msg"), HookState::NotExecutable);
    assert_eq!(state("pre-push"), HookState::Disabled);
    assert_eq!(state("post-commit"), HookState::Missing);
    assert_eq!(hooks.hooks.len(), gitp_core::HOOK_NAMES.len());
}

#[test]
fn a_hook_is_disabled_by_renaming_and_enabled_back_executable() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    let dir = repo.hooks_dir().unwrap();
    write_hook(&dir, "pre-commit", 0o755);
    write_hook(&dir, "commit-msg", 0o644);

    repo.set_hook_enabled("pre-commit", false).unwrap();
    assert!(!dir.join("pre-commit").exists());
    assert!(dir.join("pre-commit.disabled").is_file());
    repo.set_hook_enabled("pre-commit", true).unwrap();
    assert!(dir.join("pre-commit").is_file());
    assert!(!dir.join("pre-commit.disabled").exists());

    // Enabling a script git skips for its mode sets the bit; the text stays.
    repo.set_hook_enabled("commit-msg", true).unwrap();
    let mode = std::fs::metadata(dir.join("commit-msg"))
        .unwrap()
        .permissions()
        .mode();
    assert_ne!(mode & 0o111, 0);
    assert_eq!(
        std::fs::read_to_string(dir.join("commit-msg")).unwrap(),
        "#!/bin/sh\nexit 0\n"
    );

    assert!(
        repo.set_hook_enabled("post-commit", false).is_err(),
        "nothing to disable"
    );
    assert!(repo.set_hook_enabled("not-a-hook", true).is_err());
    assert!(repo.set_hook_enabled("../../etc/passwd", true).is_err());
}

#[test]
fn the_folder_follows_core_hookspath() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();
    repo.set_config(
        gitp_core::ConfigScope::Local,
        "core.hooksPath",
        "tools/hooks",
    )
    .unwrap();
    let dir = repo.hooks_dir().unwrap();
    // git prints the real path; the temp dir may be reached through a symlink.
    assert_eq!(dir, fx.path().canonicalize().unwrap().join("tools/hooks"));
    write_hook(&dir, "pre-push", 0o755);
    let hooks = repo.hooks().unwrap();
    assert_eq!(hooks.dir, dir.to_string_lossy());
    assert_eq!(
        hooks
            .hooks
            .iter()
            .find(|h| h.name == "pre-push")
            .unwrap()
            .state,
        HookState::Active
    );
}
