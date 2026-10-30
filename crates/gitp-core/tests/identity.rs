mod common;

use common::FixtureRepo;
use gitp_core::{restore_local_identity, Identity, Repo};

fn work() -> Identity {
    Identity {
        name: "Ada Work".into(),
        email: "ada@work.example".into(),
        signing_key: String::new(),
    }
}

#[test]
fn commits_after_applying_a_local_identity_are_authored_by_it() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();

    assert!(repo.apply_local_identity(&work()).unwrap().is_some());

    std::fs::write(fixture.path().join("a.txt"), "a\n").unwrap();
    let mut index = fixture.repo.index().unwrap();
    index.add_path(std::path::Path::new("a.txt")).unwrap();
    index.write().unwrap();
    repo.commit("first", "", false, Some(false), true).unwrap();

    let head = fixture.repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.author().name(), Some("Ada Work"));
    assert_eq!(head.author().email(), Some("ada@work.example"));
    assert_eq!(head.committer().email(), Some("ada@work.example"));
}

#[test]
fn applying_the_same_local_identity_again_changes_nothing() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();
    repo.apply_local_identity(&work()).unwrap();

    assert!(repo.apply_local_identity(&work()).unwrap().is_none());
}

#[test]
fn a_local_identity_without_a_key_drops_the_previous_profiles_key() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();
    let signed = Identity {
        signing_key: "WORKKEY".into(),
        ..work()
    };
    repo.apply_local_identity(&signed).unwrap();

    repo.apply_local_identity(&work()).unwrap();

    let cfg = fixture
        .repo
        .config()
        .unwrap()
        .open_level(git2::ConfigLevel::Local)
        .unwrap();
    assert!(cfg.get_string("user.signingkey").is_err());
}

fn local_config(fixture: &FixtureRepo) -> git2::Config {
    fixture
        .repo
        .config()
        .unwrap()
        .open_level(git2::ConfigLevel::Local)
        .unwrap()
        .snapshot()
        .unwrap()
}

fn local(fixture: &FixtureRepo, key: &str) -> Option<String> {
    local_config(fixture).get_string(key).ok()
}

#[test]
fn applying_a_local_identity_returns_what_the_repo_had_before() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();

    let previous = repo.apply_local_identity(&work()).unwrap();

    assert_eq!(
        previous,
        Some(Identity {
            name: "Fixture Author".into(),
            email: "author@example.com".into(),
            signing_key: String::new(),
        })
    );
}

#[test]
fn restoring_gives_the_repo_its_own_identity_back() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();
    let signed = Identity {
        signing_key: "WORKKEY".into(),
        ..work()
    };
    let previous = repo.apply_local_identity(&signed).unwrap().unwrap();

    restore_local_identity(fixture.path(), &signed, &previous).unwrap();

    assert_eq!(local(&fixture, "user.name").as_deref(), Some("Fixture Author"));
    assert_eq!(local(&fixture, "user.email").as_deref(), Some("author@example.com"));
    assert_eq!(local(&fixture, "user.signingkey"), None, "a key gitp added is unset");
}

#[test]
fn restoring_unsets_what_the_repo_did_not_set_itself() {
    let fixture = FixtureRepo::init();
    {
        let mut cfg = fixture.repo.config().unwrap().open_level(git2::ConfigLevel::Local).unwrap();
        cfg.remove("user.name").unwrap();
        cfg.remove("user.email").unwrap();
    }
    let repo = Repo::open(fixture.path()).unwrap();
    let previous = repo.apply_local_identity(&work()).unwrap().unwrap();

    restore_local_identity(fixture.path(), &work(), &previous).unwrap();

    assert_eq!(local(&fixture, "user.name"), None);
    assert_eq!(local(&fixture, "user.email"), None);
}

#[test]
fn restoring_leaves_a_value_changed_since_alone() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();
    let previous = repo.apply_local_identity(&work()).unwrap().unwrap();
    fixture
        .repo
        .config()
        .unwrap()
        .open_level(git2::ConfigLevel::Local)
        .unwrap()
        .set_str("user.email", "mine@example.org")
        .unwrap();

    restore_local_identity(fixture.path(), &work(), &previous).unwrap();

    assert_eq!(local(&fixture, "user.name").as_deref(), Some("Fixture Author"));
    assert_eq!(local(&fixture, "user.email").as_deref(), Some("mine@example.org"));
}

#[test]
fn restoring_a_repo_that_is_gone_is_nothing_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let gone = dir.path().join("gone");

    restore_local_identity(&gone, &work(), &Identity::default()).unwrap();
}
