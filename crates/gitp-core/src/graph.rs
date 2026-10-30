//! Commit-graph lane assignment.
//!
//! Given commits in newest-first walk order, assign each a `lane` (column) and a
//! `color` bucket so a frontend can render branch lanes without recomputing
//! topology. The algorithm tracks "active lanes": each lane reserves the oid of
//! the next commit expected to appear in that column (a child is waiting for it).
//!
//! A pinned branch ("Pin to Left") has its first-parent chain kept in lane 0:
//! lane 0 is reserved for its tip from the top of the graph and handed down
//! the chain, so nothing else can take it while the chain lasts.

use crate::log::CommitRow;

#[derive(Clone)]
struct Lane {
    /// Full hex id of the commit this lane is currently waiting to reach.
    expecting: String,
    color: usize,
}

/// Leftmost free slot, extending the vec if all are occupied.
fn first_free(active: &mut Vec<Option<Lane>>) -> usize {
    if let Some(idx) = active.iter().position(|s| s.is_none()) {
        idx
    } else {
        active.push(None);
        active.len() - 1
    }
}

fn lane_expecting(active: &[Option<Lane>], oid: &str) -> Option<usize> {
    active
        .iter()
        .position(|s| s.as_ref().map(|l| l.expecting.as_str()) == Some(oid))
}

/// Assign `lane` and `color` to each row in place. `rows` must be in newest-first
/// walk order (parents after children). `pinned` is the tip of a branch whose
/// first-parent chain keeps lane 0; with `None` the layout is the plain one.
pub fn assign_lanes(rows: &mut [CommitRow], pinned: Option<&str>) {
    let mut active: Vec<Option<Lane>> = Vec::new();
    let mut next_color = 0usize;

    // The next commit of the pinned chain. Only a tip that is in the walk:
    // one that isn't would leave lane 0 reserved and empty down the graph.
    let mut chain: Option<String> = pinned
        .filter(|tip| rows.iter().any(|r| r.id == *tip))
        .map(str::to_string);
    if let Some(tip) = &chain {
        active.push(Some(Lane {
            expecting: tip.clone(),
            color: 0,
        }));
        next_color = 1;
    }

    for row in rows.iter_mut() {
        // Lane 0 always expects the chain's next commit, and is the leftmost
        // lane, so the lookup below puts a chain commit there by itself.
        let on_chain = chain.as_deref() == Some(row.id.as_str());
        // Which lane, if any, was already reserved for this commit by a child?
        let (lane, color) = match lane_expecting(&active, &row.id) {
            Some(idx) => (idx, active[idx].as_ref().unwrap().color),
            None => {
                // A tip with no waiting child: start a new strand.
                let idx = first_free(&mut active);
                let color = next_color;
                next_color += 1;
                (idx, color)
            }
        };
        row.lane = lane;
        row.color = color;

        // This commit has now been reached: release every lane that was waiting
        // for it (multiple children can converge here).
        for slot in active.iter_mut() {
            if slot.as_ref().map(|l| l.expecting.as_str()) == Some(row.id.as_str()) {
                *slot = None;
            }
        }

        // Route parents into lanes.
        if on_chain {
            chain = row.parents.first().cloned();
        }
        if let Some(first_parent) = row.parents.first() {
            // The first parent continues this commit's strand — unless another
            // lane already expects it, in which case the strands converge and we
            // leave this lane freed. The pinned chain continues regardless: the
            // other lane's line simply bends into lane 0 at the parent.
            if on_chain || lane_expecting(&active, first_parent).is_none() {
                active[lane] = Some(Lane {
                    expecting: first_parent.clone(),
                    color,
                });
            }
            // Extra parents (merges) each open a new strand, unless already tracked.
            for extra in &row.parents[1..] {
                if lane_expecting(&active, extra).is_none() {
                    let idx = first_free(&mut active);
                    let new_color = next_color;
                    next_color += 1;
                    active[idx] = Some(Lane {
                        expecting: extra.clone(),
                        color: new_color,
                    });
                }
            }
        }
        // No parents (root): the lane was already released above.
    }
}

#[cfg(test)]
mod tests {
    use super::assign_lanes;
    use crate::log::CommitRow;

    fn row(id: &str, parents: &[&str]) -> CommitRow {
        CommitRow {
            id: id.into(),
            short_id: id.into(),
            summary: id.into(),
            author_name: String::new(),
            author_email: String::new(),
            time: 0,
            parents: parents.iter().map(|p| p.to_string()).collect(),
            lane: 0,
            color: 0,
        }
    }

    fn lanes(rows: &[CommitRow]) -> Vec<(String, usize)> {
        rows.iter().map(|r| (r.id.clone(), r.lane)).collect()
    }

    // f1 ← f2 is a feature branch off m1; main went on to m2, the newest
    // commit, so it takes lane 0 unpinned:
    //   m2  f2
    //   |   f1
    //   m1 /
    fn forked() -> Vec<CommitRow> {
        vec![
            row("m2", &["m1"]),
            row("f2", &["f1"]),
            row("f1", &["m1"]),
            row("m1", &[]),
        ]
    }

    #[test]
    fn nothing_pinned_is_the_plain_layout() {
        let mut plain = forked();
        assign_lanes(&mut plain, None);
        assert_eq!(
            lanes(&plain),
            [("m2", 0), ("f2", 1), ("f1", 1), ("m1", 0)].map(|(id, l)| (id.to_string(), l))
        );
    }

    #[test]
    fn a_pinned_branch_keeps_lane_zero_down_its_first_parents() {
        let mut rows = forked();
        assign_lanes(&mut rows, Some("f2"));
        // The feature chain takes lane 0, main moves over, and the shared base
        // stays with the pinned chain.
        assert_eq!(
            lanes(&rows),
            [("m2", 1), ("f2", 0), ("f1", 0), ("m1", 0)].map(|(id, l)| (id.to_string(), l))
        );
        assert_eq!(rows[1].color, 0, "the pinned strand keeps one colour");
        assert_ne!(rows[0].color, 0);
    }

    #[test]
    fn the_chain_follows_first_parents_through_a_merge() {
        // m3 merges side (s1) into main; pinning main keeps m3, m2, m1 in lane 0
        // even though side's commit is newer than m2.
        let mut rows = vec![
            row("x", &["m3"]),
            row("m3", &["m2", "s1"]),
            row("s1", &["m1"]),
            row("m2", &["m1"]),
            row("m1", &[]),
        ];
        assign_lanes(&mut rows, Some("m3"));
        let got = lanes(&rows);
        for id in ["m3", "m2", "m1"] {
            assert!(
                got.contains(&(id.to_string(), 0)),
                "{id} in lane 0: {got:?}"
            );
        }
        assert_ne!(rows[0].lane, 0, "x, built on main, starts beside the pin");
    }

    #[test]
    fn a_pin_outside_the_walk_changes_nothing() {
        let mut plain = forked();
        assign_lanes(&mut plain, None);
        let mut pinned = forked();
        assign_lanes(&mut pinned, Some("not-in-the-walk"));
        assert_eq!(lanes(&pinned), lanes(&plain));
    }
}
