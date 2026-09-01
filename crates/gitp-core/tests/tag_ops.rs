//! Tag inspection and deletion behind the sidebar's tag menu. Push and remote
//! delete aren't covered here — they need a real remote, and they're a single
//! `run_git` call each with nothing to get wrong locally.

mod common;

use common::FixtureRepo;
use gitp_core::Repo;

/// Create an annotated tag (git2's `tag`, as opposed to `tag_lightweight`).
fn annotate(fx: &FixtureRepo, name: &str, oid: git2::Oid, message: &str) {
    let target = fx.repo.find_object(oid, None).unwrap();
    let sig = git2::Signature::new(
        "Tagger Person",
        "tagger@example.com",
        &git2::Time::new(1_700_000_000, 0),
    )
    .unwrap();
    fx.repo.tag(name, &target, &sig, message, false).unwrap();
}

#[test]
fn tag_detail_reads_an_annotated_tags_tagger_and_message() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "first commit");
    annotate(&fx, "v1.0", oid, "the first release\n");
    let repo = Repo::open(fx.path()).unwrap();

    let d = repo.tag_detail("v1.0").unwrap();
    assert_eq!(d.name, "v1.0");
    assert!(d.annotated, "created with git2::tag, so it has its own object");
    assert_eq!(d.tagger_name.as_deref(), Some("Tagger Person"));
    assert_eq!(d.tagger_email.as_deref(), Some("tagger@example.com"));
    assert_eq!(d.tagger_time, Some(1_700_000_000));
    assert_eq!(d.message.as_deref(), Some("the first release\n"));
    // The target is peeled through the tag object to the commit itself.
    assert_eq!(d.target, oid.to_string());
    assert_eq!(d.target_summary, "first commit");
}

#[test]
fn tag_detail_reports_a_lightweight_tag_as_having_no_tagger_or_message() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "first commit");
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_tag_at("v1.0", &oid.to_string()).unwrap();

    let d = repo.tag_detail("v1.0").unwrap();
    assert!(!d.annotated, "a plain `git tag <name>` is only a ref");
    assert_eq!(d.tagger_name, None);
    assert_eq!(d.tagger_email, None);
    assert_eq!(d.tagger_time, None);
    assert_eq!(d.message, None);
    // Even without a tag object, the commit it points at is still reported.
    assert_eq!(d.target, oid.to_string());
    assert_eq!(d.target_summary, "first commit");
}

#[test]
fn tag_detail_errors_on_a_tag_that_does_not_exist() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "first commit");
    let repo = Repo::open(fx.path()).unwrap();

    assert!(repo.tag_detail("nope").is_err());
}

#[test]
fn delete_tag_removes_the_ref_and_leaves_the_commit_reachable() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "first commit");
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_tag_at("v1.0", &oid.to_string()).unwrap();
    assert!(repo.refs().unwrap().tags.iter().any(|t| t.name == "v1.0"));

    repo.delete_tag("v1.0").unwrap();

    assert!(
        !repo.refs().unwrap().tags.iter().any(|t| t.name == "v1.0"),
        "tag is gone from the ref listing"
    );
    // Deleting a tag must not touch history — the commit is still on the branch.
    assert_eq!(repo.head_commit_id().unwrap(), oid.to_string());
}

#[test]
fn delete_tag_errors_on_a_tag_that_does_not_exist() {
    let fx = FixtureRepo::init();
    fx.commit_file("a.txt", "one\n", "first commit");
    let repo = Repo::open(fx.path()).unwrap();

    assert!(repo.delete_tag("nope").is_err());
}
