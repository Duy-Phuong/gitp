//! Commit-graph lane assignment.
//!
//! Given commits in newest-first walk order, assign each a `lane` (column) and a
//! `color` bucket so a frontend can render branch lanes without recomputing
//! topology. The algorithm tracks "active lanes": each lane reserves the oid of
//! the next commit expected to appear in that column (a child is waiting for it).

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
/// walk order (parents after children).
pub fn assign_lanes(rows: &mut [CommitRow]) {
    let mut active: Vec<Option<Lane>> = Vec::new();
    let mut next_color = 0usize;

    for row in rows.iter_mut() {
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
        if let Some(first_parent) = row.parents.first() {
            // The first parent continues this commit's strand — unless another
            // lane already expects it, in which case the strands converge and we
            // leave this lane freed.
            if lane_expecting(&active, first_parent).is_none() {
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
