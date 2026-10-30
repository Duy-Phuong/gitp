mod common;

use common::FixtureRepo;
use gitp_core::{Identity, Repo};

fn work() -> Identity {
    Identity {
        name: "Ada Work".into(),
        email: "ada@work.example".into(),
        signing_key: String::new(),
        signing_format: String::new(),
    }
}

#[test]
fn commits_after_applying_a_local_identity_are_authored_by_it() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();

    assert!(repo.apply_local_identity(&work()).unwrap());

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

    assert!(!repo.apply_local_identity(&work()).unwrap());
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

#[test]
fn a_local_identity_writes_its_signing_format_and_an_empty_one_removes_it() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();
    let ssh = Identity {
        signing_key: "/home/ada/.ssh/id_ed25519.pub".into(),
        signing_format: "ssh".into(),
        ..work()
    };

    assert!(repo.apply_local_identity(&ssh).unwrap());
    assert!(!repo.apply_local_identity(&ssh).unwrap(), "already there");

    let local = || {
        fixture
            .repo
            .config()
            .unwrap()
            .open_level(git2::ConfigLevel::Local)
            .unwrap()
    };
    assert_eq!(local().get_string("gpg.format").unwrap(), "ssh");

    // A profile with no format removes it again.
    repo.apply_local_identity(&work()).unwrap();
    assert!(local().get_string("gpg.format").is_err());
}
