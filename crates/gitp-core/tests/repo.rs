mod common;

use common::FixtureRepo;
use gitp_core::Repo;

#[test]
fn opens_an_existing_repository() {
    let fixture = FixtureRepo::init();

    let repo = Repo::open(fixture.path());

    assert!(repo.is_ok(), "expected to open an initialized repo");
}

#[test]
fn fails_to_open_a_non_repository() {
    let dir = tempfile::TempDir::new().unwrap();

    let repo = Repo::open(dir.path());

    assert!(repo.is_err(), "a plain directory is not a git repo");
}
