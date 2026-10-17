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

#[test]
fn ignore_rules_cover_ignored_directories_and_everything_under_them() {
    let fixture = FixtureRepo::init();
    fixture.commit_file(".gitignore", "target/\nnode_modules\n*.log\n", "ignore");
    std::fs::create_dir_all(fixture.path().join("target/debug")).unwrap();
    std::fs::create_dir_all(fixture.path().join("src")).unwrap();
    let repo = Repo::open(fixture.path()).unwrap();
    let ignored = |p: &str, dir: bool| repo.is_ignored(std::path::Path::new(p), dir);

    assert!(ignored("target", true));
    assert!(
        ignored("target/debug/build.o", false),
        "inside an ignored dir"
    );
    assert!(ignored("node_modules", true));
    assert!(ignored("a.log", false));
    assert!(!ignored("src", true));
    assert!(!ignored("src/main.rs", false));
    // A `name/` rule only matches directories — and must still match one that
    // no longer exists (`rm -rf target` is exactly when the events pour in).
    std::fs::remove_dir_all(fixture.path().join("target")).unwrap();
    assert!(
        ignored("target", true),
        "a deleted ignored dir is still ignored"
    );
    assert!(ignored("target/debug/build.o", false));
    assert!(!ignored("target", false), "a *file* named target is not");
}
