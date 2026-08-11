mod common;

use common::FixtureRepo;
use gitp_core::{LogOptions, Repo};
use std::collections::HashMap;

/// Map summary -> lane for easy assertions regardless of walk order.
fn lanes_by_summary(rows: &[gitp_core::CommitRow]) -> HashMap<String, usize> {
    rows.iter()
        .map(|r| (r.summary.clone(), r.lane))
        .collect()
}

#[test]
fn linear_history_stays_in_lane_zero() {
    let fixture = FixtureRepo::init();
    let a = fixture.commit_raw("A", &[], 1000);
    let b = fixture.commit_raw("B", &[a], 1001);
    let c = fixture.commit_raw("C", &[b], 1002);
    fixture.point_head_at(c);

    let repo = Repo::open(fixture.path()).unwrap();
    let rows = repo.log(LogOptions::default()).unwrap();

    assert!(rows.iter().all(|r| r.lane == 0), "linear history is one lane");
}

#[test]
fn branch_and_merge_assign_distinct_lanes() {
    // A ← B ┐
    //  ↖ C ┴ M   (M merges B and C; B is first parent)
    let fixture = FixtureRepo::init();
    let a = fixture.commit_raw("A", &[], 1000);
    let b = fixture.commit_raw("B", &[a], 1001);
    let c = fixture.commit_raw("C", &[a], 1002);
    let m = fixture.commit_raw("M", &[b, c], 1003);
    fixture.point_head_at(m);

    let repo = Repo::open(fixture.path()).unwrap();
    let rows = repo.log(LogOptions::default()).unwrap();

    // Walk order (newest-first by time): M, C, B, A.
    let summaries: Vec<&str> = rows.iter().map(|r| r.summary.as_str()).collect();
    assert_eq!(summaries, vec!["M", "C", "B", "A"]);

    let lanes = lanes_by_summary(&rows);
    // M is the tip in lane 0; its first parent B keeps lane 0, second parent C
    // takes a new lane 1. A re-converges into whichever lane already reserved it.
    assert_eq!(lanes["M"], 0);
    assert_eq!(lanes["B"], 0);
    assert_eq!(lanes["C"], 1);
    assert_eq!(lanes["A"], 1);
}
