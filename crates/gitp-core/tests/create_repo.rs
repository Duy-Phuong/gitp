//! Making new repositories: `init_repo` into a folder.

use gitp_core::{init_repo, Repo};
use tempfile::TempDir;

#[test]
fn init_creates_the_folder_and_writes_the_chosen_files() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nested").join("proj");

    init_repo(&path, Some("target/\n"), true).expect("init");

    assert!(Repo::open(&path).is_ok(), "a repository now opens there");
    assert_eq!(
        std::fs::read_to_string(path.join(".gitignore")).unwrap(),
        "target/\n"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "# proj\n"
    );
}

#[test]
fn init_writes_nothing_it_was_not_asked_for() {
    let tmp = TempDir::new().unwrap();
    init_repo(tmp.path(), None, false).expect("init");
    assert!(tmp.path().join(".git").is_dir());
    assert!(!tmp.path().join(".gitignore").exists());
    assert!(!tmp.path().join("README.md").exists());
}

#[test]
fn init_never_overwrites_an_existing_readme() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("README.md"), "mine\n").unwrap();

    let err = init_repo(tmp.path(), None, true).unwrap_err();

    assert!(
        err.to_string().contains("README.md already exists"),
        "{err}"
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("README.md")).unwrap(),
        "mine\n"
    );
    assert!(
        !tmp.path().join(".git").exists(),
        "refused before git init ran"
    );
}

#[test]
fn init_refuses_a_relative_path() {
    assert!(init_repo(std::path::Path::new("relative/dir"), None, false).is_err());
}
