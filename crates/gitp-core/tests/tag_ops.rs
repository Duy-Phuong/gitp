//! Tag inspection, deletion, and push behind the sidebar's tag menu. Push and
//! remote delete go to bare repos on disk standing in for remotes — no network.

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
    assert!(
        d.annotated,
        "created with git2::tag, so it has its own object"
    );
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

#[test]
fn create_annotated_tag_at_makes_a_tag_object_and_keeps_hash_lines() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "first commit");
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_annotated_tag_at("v1.0", &oid.to_string(), "Release 1\n\n#42 fixed")
        .unwrap();

    let d = repo.tag_detail("v1.0").unwrap();
    assert!(d.annotated);
    // git's default cleanup for tags would have dropped "#42 fixed" as a comment.
    assert_eq!(d.message.as_deref(), Some("Release 1\n\n#42 fixed\n"));
    assert_eq!(d.target, oid.to_string());

    // The refs listing carries the message for the tooltip; a lightweight tag has none.
    repo.create_tag_at("light", &oid.to_string()).unwrap();
    let tags = repo.refs().unwrap().tags;
    let msg = |name: &str| {
        tags.iter()
            .find(|t| t.name == name)
            .unwrap()
            .message
            .clone()
    };
    assert_eq!(msg("v1.0").as_deref(), Some("Release 1\n\n#42 fixed"));
    assert_eq!(msg("light"), None);
}

#[test]
fn refs_tag_message_drops_a_signature_block() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "first commit");
    annotate(
        &fx,
        "v1.0",
        oid,
        "Release 1\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n",
    );
    let repo = Repo::open(fx.path()).unwrap();

    let tags = repo.refs().unwrap().tags;
    assert_eq!(tags[0].message.as_deref(), Some("Release 1"));
}

#[test]
fn annotate_tag_turns_a_lightweight_tag_into_an_annotated_one_in_place() {
    let fx = FixtureRepo::init();
    let first = fx.commit_file("a.txt", "one\n", "first commit");
    fx.commit_file("a.txt", "two\n", "second commit");
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_tag_at("v1.0", &first.to_string()).unwrap();

    repo.annotate_tag("v1.0", "Release 1").unwrap();

    let d = repo.tag_detail("v1.0").unwrap();
    assert!(d.annotated);
    assert_eq!(d.message.as_deref(), Some("Release 1\n"));
    // Same commit as before — not HEAD, which `git tag -f <name>` alone would pick.
    assert_eq!(d.target, first.to_string());

    // Already annotated: refused rather than silently replacing the annotation.
    assert!(repo.annotate_tag("v1.0", "again").is_err());
    assert_eq!(
        repo.tag_detail("v1.0").unwrap().message.as_deref(),
        Some("Release 1\n")
    );
}

/// Run git in `dir`, failing the test on error; returns trimmed stdout.
fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn push_and_delete_a_tag_on_the_chosen_remote_only() {
    let fx = FixtureRepo::init();
    let oid = fx.commit_file("a.txt", "one\n", "first commit");
    // Two bare repos standing in for `origin` and `upstream`.
    let origin = tempfile::tempdir().unwrap();
    let upstream = tempfile::tempdir().unwrap();
    for (name, dir) in [("origin", &origin), ("upstream", &upstream)] {
        git(dir.path(), &["init", "--bare", "-q"]);
        git(
            fx.path(),
            &["remote", "add", name, dir.path().to_str().unwrap()],
        );
    }
    let repo = Repo::open(fx.path()).unwrap();
    repo.create_tag_at("v1.0", &oid.to_string()).unwrap();

    repo.push_tag("v1.0", "upstream").unwrap();
    assert!(repo.remote_tag_exists("v1.0", "upstream").unwrap());
    assert!(
        !repo.remote_tag_exists("v1.0", "origin").unwrap(),
        "only the chosen remote got the tag"
    );
    assert_eq!(
        git(upstream.path(), &["rev-parse", "refs/tags/v1.0"]),
        oid.to_string()
    );

    repo.push_tag("v1.0", "origin").unwrap();
    repo.delete_remote_tag("v1.0", "upstream").unwrap();
    assert!(!repo.remote_tag_exists("v1.0", "upstream").unwrap());
    assert!(
        repo.remote_tag_exists("v1.0", "origin").unwrap(),
        "deleting on one remote leaves the other's copy"
    );

    // A remote name that git would read as an option is refused.
    assert!(repo.push_tag("v1.0", "--upload-pack=x").is_err());
    assert!(repo.remote_tag_exists("v1.0", "-x").is_err());
}
