//! `Repo::refresh_log`: extending a cached log with just the new commits, and
//! falling back to a full walk whenever a cached commit may have disappeared.

mod common;

use std::collections::{HashMap, HashSet};

use common::FixtureRepo;
use gitp_core::{LogCache, LogOptions, LogRefresh, LogScope, Repo};

/// The refreshed cache must hold exactly the commits a fresh full walk finds,
/// once each, in a valid topological order (every commit above its parents).
fn assert_matches_full_walk(repo: &Repo, cache: &LogCache, all_branches: bool) {
    let full = repo
        .log(LogOptions {
            all_branches,
            ..Default::default()
        })
        .unwrap();
    let want: HashSet<&str> = full.iter().map(|r| r.id.as_str()).collect();
    let got: HashSet<&str> = cache.rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(got.len(), cache.rows.len(), "no commit appears twice");
    assert_eq!(got, want, "same commits as a full walk");

    let index: HashMap<&str, usize> = cache
        .rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.id.as_str(), i))
        .collect();
    for (i, row) in cache.rows.iter().enumerate() {
        for parent in &row.parents {
            if let Some(&j) = index.get(parent.as_str()) {
                assert!(j > i, "{} is listed above its child {}", parent, row.id);
            }
        }
    }
}

fn set_branch(fx: &FixtureRepo, name: &str, oid: git2::Oid) {
    fx.repo
        .reference(&format!("refs/heads/{name}"), oid, true, "test")
        .unwrap();
}

#[test]
fn unchanged_tips_reuse_the_cache() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    fx.point_head_at(a);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(false).unwrap();

    assert_eq!(
        repo.refresh_log(&mut cache, false).unwrap(),
        LogRefresh::Unchanged
    );
    assert_eq!(cache.rows.len(), 1);
}

#[test]
fn a_commit_on_top_is_walked_alone() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let b = fx.commit_raw("b", &[a], 200);
    fx.point_head_at(b);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(false).unwrap();

    let c = fx.commit_raw("c", &[b], 300);
    fx.point_head_at(c);
    assert_eq!(
        repo.refresh_log(&mut cache, false).unwrap(),
        LogRefresh::Extended { added: 1 }
    );
    assert_eq!(cache.rows[0].id, c.to_string());
    assert_matches_full_walk(&repo, &cache, false);
}

#[test]
fn new_commits_stay_above_their_parents_despite_clock_skew() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    fx.point_head_at(a);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(false).unwrap();

    // `c` claims to be older than its parent `b` (and than `a`).
    let b = fx.commit_raw("b", &[a], 300);
    let c = fx.commit_raw("c", &[b], 50);
    fx.point_head_at(c);
    assert_eq!(
        repo.refresh_log(&mut cache, false).unwrap(),
        LogRefresh::Extended { added: 2 }
    );
    let ids: Vec<&str> = cache.rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, [c.to_string(), b.to_string(), a.to_string()]);
    assert_matches_full_walk(&repo, &cache, false);
}

#[test]
fn a_new_branch_with_commits_is_walked_alone() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let b = fx.commit_raw("b", &[a], 200);
    fx.point_head_at(b);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(true).unwrap();

    // Branch off the older commit, so the new strand joins mid-history.
    let f1 = fx.commit_raw("f1", &[a], 300);
    let f2 = fx.commit_raw("f2", &[f1], 400);
    set_branch(&fx, "feature", f2);
    assert_eq!(
        repo.refresh_log(&mut cache, true).unwrap(),
        LogRefresh::Extended { added: 2 }
    );
    assert_matches_full_walk(&repo, &cache, true);
}

#[test]
fn fetched_remote_commits_are_walked_alone() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    fx.point_head_at(a);
    fx.repo
        .reference("refs/remotes/origin/main", a, true, "test")
        .unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(true).unwrap();

    // What a fetch does: the remote-tracking ref moves ahead.
    let r1 = fx.commit_raw("r1", &[a], 200);
    let r2 = fx.commit_raw("r2", &[r1], 300);
    fx.repo
        .reference("refs/remotes/origin/main", r2, true, "test")
        .unwrap();
    assert_eq!(
        repo.refresh_log(&mut cache, true).unwrap(),
        LogRefresh::Extended { added: 2 }
    );
    assert_matches_full_walk(&repo, &cache, true);
}

#[test]
fn a_merge_brings_in_the_merged_branch() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let b = fx.commit_raw("b", &[a], 200);
    let f1 = fx.commit_raw("f1", &[a], 150);
    let f2 = fx.commit_raw("f2", &[f1], 250);
    set_branch(&fx, "feature", f2);
    fx.point_head_at(b);
    let repo = Repo::open(fx.path()).unwrap();
    // HEAD only: the feature commits are not in the cache yet.
    let mut cache = repo.log_cache(false).unwrap();
    assert_eq!(cache.rows.len(), 2);

    let m = fx.commit_raw("merge", &[b, f2], 300);
    fx.point_head_at(m);
    assert_eq!(
        repo.refresh_log(&mut cache, false).unwrap(),
        LogRefresh::Extended { added: 3 }
    );
    assert_eq!(cache.rows[0].id, m.to_string());
    assert_matches_full_walk(&repo, &cache, false);
}

#[test]
fn a_fast_forward_to_a_known_commit_adds_nothing() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let b = fx.commit_raw("b", &[a], 200);
    set_branch(&fx, "feature", b);
    fx.point_head_at(a);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(true).unwrap();

    // main's old tip `a` is no longer a tip, but still reachable through `b`.
    fx.point_head_at(b);
    assert_eq!(
        repo.refresh_log(&mut cache, true).unwrap(),
        LogRefresh::Extended { added: 0 }
    );
    assert_matches_full_walk(&repo, &cache, true);
}

#[test]
fn deleting_a_branch_rewalks() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let f = fx.commit_raw("f", &[a], 200);
    set_branch(&fx, "feature", f);
    fx.point_head_at(a);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(true).unwrap();
    assert_eq!(cache.rows.len(), 2);

    fx.repo
        .find_reference("refs/heads/feature")
        .unwrap()
        .delete()
        .unwrap();
    assert_eq!(
        repo.refresh_log(&mut cache, true).unwrap(),
        LogRefresh::Full
    );
    assert_eq!(cache.rows.len(), 1);
    assert_matches_full_walk(&repo, &cache, true);
}

#[test]
fn a_hard_reset_rewalks() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let b = fx.commit_raw("b", &[a], 200);
    fx.point_head_at(b);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(false).unwrap();

    fx.point_head_at(a);
    assert_eq!(
        repo.refresh_log(&mut cache, false).unwrap(),
        LogRefresh::Full
    );
    assert_matches_full_walk(&repo, &cache, false);
}

#[test]
fn an_amend_rewalks() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let b = fx.commit_raw("b", &[a], 200);
    fx.point_head_at(b);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(false).unwrap();

    // Same parent, new commit: `b` drops out of history.
    let b2 = fx.commit_raw("b amended", &[a], 250);
    fx.point_head_at(b2);
    assert_eq!(
        repo.refresh_log(&mut cache, false).unwrap(),
        LogRefresh::Full
    );
    assert!(!cache.rows.iter().any(|r| r.id == b.to_string()));
    assert_matches_full_walk(&repo, &cache, false);
}

#[test]
fn toggling_all_branches_rewalks() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let f = fx.commit_raw("f", &[a], 200);
    set_branch(&fx, "feature", f);
    fx.point_head_at(a);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(false).unwrap();

    assert_eq!(
        repo.refresh_log(&mut cache, true).unwrap(),
        LogRefresh::Full
    );
    assert!(cache.all_branches());
    assert_matches_full_walk(&repo, &cache, true);
}

#[test]
fn lanes_are_reassigned_across_the_whole_log() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let b = fx.commit_raw("b", &[a], 200);
    fx.point_head_at(b);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(true).unwrap();

    // A side branch off `a` opens a second lane that runs past `b`.
    let f = fx.commit_raw("f", &[a], 300);
    set_branch(&fx, "feature", f);
    repo.refresh_log(&mut cache, true).unwrap();

    let lane_of = |oid: git2::Oid| {
        let id = oid.to_string();
        cache.rows.iter().find(|r| r.id == id).unwrap().lane
    };
    assert_ne!(
        lane_of(f),
        lane_of(b),
        "the two tips sit in different lanes"
    );
}

#[test]
fn pinning_a_branch_relays_lanes_without_a_walk() {
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let f = fx.commit_raw("f", &[a], 200);
    let b = fx.commit_raw("b", &[a], 300);
    set_branch(&fx, "feature", f);
    fx.point_head_at(b);
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(true).unwrap();
    let lane_of = |cache: &LogCache, oid: git2::Oid| {
        let id = oid.to_string();
        cache.rows.iter().find(|r| r.id == id).unwrap().lane
    };
    assert_eq!(lane_of(&cache, b), 0, "the newest tip leads unpinned");

    let pinned = LogScope {
        all_branches: true,
        pinned: Some("feature".into()),
        ..LogScope::default()
    };
    assert_eq!(
        repo.refresh_log_scoped(&mut cache, &pinned).unwrap(),
        LogRefresh::Relaid
    );
    assert_eq!(lane_of(&cache, f), 0);
    assert_eq!(lane_of(&cache, a), 0, "down feature's first parents");
    assert_ne!(lane_of(&cache, b), 0);
    assert_eq!(cache.scope(), &pinned);

    // Unpinning lays the plain graph out again.
    assert_eq!(
        repo.refresh_log_scoped(&mut cache, &true.into()).unwrap(),
        LogRefresh::Relaid
    );
    assert_eq!(lane_of(&cache, b), 0);
}

#[test]
fn hidden_refs_are_left_out_of_the_walk() {
    // HEAD on `a`; feature off it and a remote branch further on.
    let fx = FixtureRepo::init();
    let a = fx.commit_raw("a", &[], 100);
    let f = fx.commit_raw("f", &[a], 200);
    let r = fx.commit_raw("r", &[a], 300);
    set_branch(&fx, "feature", f);
    fx.repo
        .reference("refs/remotes/origin/main", r, true, "test")
        .unwrap();
    fx.point_head_at(a);
    let repo = Repo::open(fx.path()).unwrap();
    let ids =
        |cache: &LogCache| -> HashSet<String> { cache.rows.iter().map(|r| r.id.clone()).collect() };
    let all: LogScope = true.into();

    let hidden = LogScope {
        hidden: vec!["refs/heads/feature".into()],
        ..all.clone()
    };
    let cache = repo.log_cache_scoped(&hidden).unwrap();
    assert!(
        !ids(&cache).contains(&f.to_string()),
        "feature's own commit is gone"
    );
    assert!(
        ids(&cache).contains(&r.to_string()),
        "the remote branch still shows"
    );

    // Hiding the checked-out branch can't hide HEAD.
    let head_hidden = LogScope {
        hidden: vec!["refs/heads/master".into(), "refs/heads/main".into()],
        ..all.clone()
    };
    assert!(ids(&repo.log_cache_scoped(&head_hidden).unwrap()).contains(&a.to_string()));

    // Solo walks the soloed refs and HEAD only — in Current mode too.
    let solo = LogScope {
        solo: vec!["refs/remotes/origin/main".into()],
        ..LogScope::default()
    };
    let cache = repo.log_cache_scoped(&solo).unwrap();
    assert_eq!(
        ids(&cache),
        [a, r].iter().map(|o| o.to_string()).collect::<HashSet<_>>()
    );

    // Hiding a tag doesn't change where the walk starts: nothing to redo.
    let mut cache = repo.log_cache_scoped(&all).unwrap();
    let tag_hidden = LogScope {
        hidden: vec!["refs/tags/v1".into()],
        ..all.clone()
    };
    assert_eq!(
        repo.refresh_log_scoped(&mut cache, &tag_hidden).unwrap(),
        LogRefresh::Unchanged
    );
    assert_eq!(cache.scope(), &tag_hidden);

    // Showing a hidden ref again walks afresh, so its commits interleave.
    let mut cache = repo.log_cache_scoped(&hidden).unwrap();
    assert_eq!(
        repo.refresh_log_scoped(&mut cache, &all).unwrap(),
        LogRefresh::Full
    );
    assert_matches_full_walk(&repo, &cache, true);
}
