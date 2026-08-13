//! Full-tree listing for a commit.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

#[test]
fn commit_tree_lists_all_blob_paths_recursively_and_sorted() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "a\n", "c1");
    fx.commit_file("src/main.rs", "fn main() {}\n", "c2");
    fx.commit_file("src/lib.rs", "// lib\n", "c3");

    let repo = Repo::open(fx.path()).unwrap();
    let paths = repo.commit_tree("HEAD").unwrap();

    assert_eq!(paths, vec!["a.txt", "src/lib.rs", "src/main.rs"]);
}
