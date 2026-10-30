//! One side of a file as bytes: a revision's tree, the index, the working tree.

mod common;

use common::FixtureRepo;
use gitp_core::{FileContent, FileSide, Repo, PREVIEW_MAX_BYTES};

fn read(repo: &Repo, side: FileSide, path: &str) -> Option<FileContent> {
    repo.file_content(&side, path, PREVIEW_MAX_BYTES).unwrap()
}

#[test]
fn reads_each_side_of_a_file() {
    let fx = FixtureRepo::init();
    fx.commit_file("img.png", "v1", "c1");
    fx.commit_file("img.png", "v22", "c2");
    // Staged "v333", then edited again on disk.
    std::fs::write(fx.path().join("img.png"), "v333").unwrap();
    let mut index = fx.repo.index().unwrap();
    index.add_path(std::path::Path::new("img.png")).unwrap();
    index.write().unwrap();
    std::fs::write(fx.path().join("img.png"), "v4444").unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let b64 = |c: Option<FileContent>| c.and_then(|c| c.base64);
    // "v1" / "v22" / "v333" / "v4444" in base64.
    assert_eq!(b64(read(&repo, FileSide::Rev("HEAD^".into()), "img.png")).as_deref(), Some("djE="));
    assert_eq!(b64(read(&repo, FileSide::Rev("HEAD".into()), "img.png")).as_deref(), Some("djIy"));
    assert_eq!(b64(read(&repo, FileSide::Index, "img.png")).as_deref(), Some("djMzMw=="));
    let disk = read(&repo, FileSide::WorkTree, "img.png").unwrap();
    assert_eq!(disk.size, 5);
    assert_eq!(disk.base64.as_deref(), Some("djQ0NDQ="));
}

#[test]
fn a_missing_side_is_none() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.png", "a", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    assert!(read(&repo, FileSide::Rev("HEAD".into()), "b.png").is_none());
    assert!(read(&repo, FileSide::Index, "b.png").is_none());
    assert!(read(&repo, FileSide::WorkTree, "b.png").is_none());
}

#[test]
fn over_the_cap_reports_only_the_size() {
    let fx = FixtureRepo::init();
    fx.commit_file("big.png", "0123456789", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    for side in [FileSide::Rev("HEAD".into()), FileSide::Index, FileSide::WorkTree] {
        let c = repo.file_content(&side, "big.png", 4).unwrap().unwrap();
        assert_eq!(c.size, 10, "{side:?}");
        assert!(c.base64.is_none(), "{side:?}");
    }
}

#[test]
fn working_tree_reads_stay_inside_the_repository() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.png", "a", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    for bad in ["", "/etc/hosts", "../x.png", "dir/../../x.png"] {
        assert!(
            repo.file_content(&FileSide::WorkTree, bad, PREVIEW_MAX_BYTES).is_err(),
            "{bad}"
        );
    }
}
