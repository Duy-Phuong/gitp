//! `Repo::start_log_walk`: the log read from `git log` as it goes, so the first
//! page can be shown before the whole history has been read — and the
//! commit-graph gitp writes so that `git log` can stream at all.

mod common;

use common::FixtureRepo;
use gitp_core::{CommitRow, LogScope, Repo};

fn layout(rows: &[CommitRow]) -> Vec<(String, usize, usize)> {
    rows.iter()
        .map(|r| (r.summary.clone(), r.lane, r.color))
        .collect()
}

/// main: a ← b ← m (merges side) ← d, side: a ← s1 ← s2, and a feature branch
/// off b that nothing merged. Dates interleave the strands.
fn branched() -> FixtureRepo {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 1000);
    let b = fx.commit_raw("b", &[a], 1001);
    let s1 = fx.commit_raw("s1", &[a], 1002);
    let f1 = fx.commit_raw("f1", &[b], 1003);
    let s2 = fx.commit_raw("s2", &[s1], 1004);
    let m = fx.commit_raw("m", &[b, s2], 1005);
    let d = fx.commit_raw("d", &[m], 1006);
    let f2 = fx.commit_raw("f2", &[f1], 1007);
    for (name, oid) in [("side", s2), ("feature", f2)] {
        fx.repo
            .reference(&format!("refs/heads/{name}"), oid, true, "test")
            .unwrap();
    }
    fx.point_head_at(d);
    fx
}

#[test]
fn the_first_rows_are_laid_out_as_in_the_full_log() {
    let fx = branched();
    let repo = Repo::open(fx.path()).unwrap();
    let scope = LogScope::from(true);
    let full = repo.log_cache_scoped(&scope).unwrap();
    assert_eq!(full.rows.len(), 8);

    for n in 1..=full.rows.len() {
        let mut walk = repo.start_log_walk(&scope).unwrap();
        let first = walk.first_rows(n).unwrap().expect("nothing pinned");
        assert_eq!(layout(&first), layout(&full.rows[..n]), "first {n} rows");
        let cache = walk.finish().unwrap();
        assert_eq!(
            layout(&cache.rows),
            layout(&full.rows),
            "after the first {n}"
        );
    }
}

#[test]
fn the_log_is_in_git_date_order() {
    let fx = branched();
    let repo = Repo::open(fx.path()).unwrap();
    let rows = repo.log_cache_scoped(&LogScope::from(true)).unwrap().rows;
    let got: Vec<&str> = rows.iter().map(|r| r.summary.as_str()).collect();
    assert_eq!(got, ["f2", "d", "m", "s2", "f1", "s1", "b", "a"]);
}

#[test]
fn early_rows_wait_for_a_pinned_tip_not_read_yet() {
    // Whether the pinned branch is in the walk decides the layout from the
    // first row on, so rows above its tip can't be laid out before it is read.
    let fx = branched();
    let repo = Repo::open(fx.path()).unwrap();
    let scope = LogScope {
        all_branches: true,
        pinned: Some("side".into()),
        ..LogScope::default()
    };
    let full = repo.log_cache_scoped(&scope).unwrap();
    let side_at = full.rows.iter().position(|r| r.summary == "s2").unwrap();

    let mut walk = repo.start_log_walk(&scope).unwrap();
    assert!(walk.first_rows(side_at).unwrap().is_none());
    let mut walk = repo.start_log_walk(&scope).unwrap();
    let first = walk.first_rows(side_at + 1).unwrap().unwrap();
    assert_eq!(layout(&first), layout(&full.rows[..=side_at]));
}

#[test]
fn reading_past_the_end_returns_the_whole_log() {
    let fx = branched();
    let repo = Repo::open(fx.path()).unwrap();
    let mut walk = repo.start_log_walk(&LogScope::from(false)).unwrap();
    let rows = walk.first_rows(100).unwrap().unwrap();
    assert_eq!(rows.len(), 6, "d, m, s2, s1, b and a are HEAD's history");
    assert!(walk.is_complete());
}

#[test]
fn an_empty_repository_has_an_empty_log() {
    let fx = FixtureRepo::init();
    let repo = Repo::open(fx.path()).unwrap();
    let mut walk = repo.start_log_walk(&LogScope::from(true)).unwrap();
    assert_eq!(walk.first_rows(10).unwrap().unwrap().len(), 0);
    assert!(walk.finish().unwrap().rows.is_empty());
}

#[test]
fn summaries_and_authors_are_read_as_libgit2_reads_them() {
    // A multi-line message: the summary is its first paragraph on one line.
    let fx = FixtureRepo::init();
    let sig = git2::Signature::new("Ann Ö", "ann@example.com", &git2::Time::new(1000, 0)).unwrap();
    let tree = fx.repo.treebuilder(None).unwrap().write().unwrap();
    let tree = fx.repo.find_tree(tree).unwrap();
    let oid = fx
        .repo
        .commit(
            None,
            &sig,
            &sig,
            "first line\nstill first\n\nbody",
            &tree,
            &[],
        )
        .unwrap();
    fx.point_head_at(oid);
    // A mailmap must not rename the author: libgit2, which reads the commits a
    // refresh adds, doesn't apply one either.
    std::fs::write(
        fx.path().join(".mailmap"),
        "Bob <bob@example.com> <ann@example.com>\n",
    )
    .unwrap();

    let repo = Repo::open(fx.path()).unwrap();
    let row = &repo.log_cache(false).unwrap().rows[0];
    assert_eq!(row.summary, "first line still first");
    assert_eq!(row.author_name, "Ann Ö");
    assert_eq!(row.author_email, "ann@example.com");
    assert_eq!(row.time, 1000);
    assert_eq!(row.id, oid.to_string());
    assert_eq!(row.short_id, oid.to_string()[..7]);
}

#[test]
fn a_commit_graph_is_written_once_and_only_when_git_would_read_it() {
    let fx = branched();
    let repo = Repo::open(fx.path()).unwrap();
    assert!(repo.commit_graph_missing());
    repo.write_commit_graph().unwrap();
    assert!(!repo.commit_graph_missing());

    let fx = branched();
    fx.repo
        .config()
        .unwrap()
        .set_bool("core.commitGraph", false)
        .unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    assert!(!repo.commit_graph_missing(), "git wouldn't read one");
}
