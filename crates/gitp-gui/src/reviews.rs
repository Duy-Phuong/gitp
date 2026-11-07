//! Reviews of a local branch before any pull request exists, and the drafts
//! of a review kept on disk (a branch's or a pull request's): loading the
//! branch's diff against its base, running the review command on it as a
//! Claude job, and fixing one draft in the branch's worktree.

use gitp_core::{FileDiff, FindingInput, GeneratedBranchReview, Repo, ReviewKey, StoredReview};
use serde::Serialize;
use tauri::State;

use crate::claude_jobs::{ClaudeJobs, JobKind, NewJob};
use crate::gh::FixJobs;
use crate::state::to_message;

/// What the branch Review panel shows: the saved review, the branch's diff
/// against `base`, how the files moved since the reviewed head (`None` when
/// that head is gone: every line counts as moved), and whether a fix can run.
#[derive(Debug, Serialize)]
pub(crate) struct BranchReviewData {
    review: Option<StoredReview>,
    /// The branch's commit now.
    head: String,
    base: String,
    files: Vec<FileDiff>,
    moves: Option<Vec<FileDiff>>,
    /// The worktree that has the branch, if any, and whether it has changes.
    worktree: Option<String>,
    dirty: bool,
}

fn open(path: &str) -> Result<Repo, String> {
    Repo::open(path).map_err(to_message)
}

fn review_default_base_impl(path: String) -> Result<String, String> {
    open(&path)?.default_review_base().map_err(to_message)
}

/// Load the panel's data for `branch` against `base` (the default base when
/// none is given).
fn branch_review_load_impl(
    path: String,
    branch: String,
    base: Option<String>,
) -> Result<BranchReviewData, String> {
    let repo = open(&path)?;
    let base = match base.filter(|b| !b.trim().is_empty()) {
        Some(b) => b,
        None => repo.default_review_base().map_err(to_message)?,
    };
    let diff = repo.branch_diff(&branch, &base).map_err(to_message)?;
    let review = repo
        .stored_review(&ReviewKey::Branch(branch.clone()))
        .map_err(to_message)?;
    let moves = match &review {
        Some(r) if !r.head.is_empty() && r.head != diff.head => {
            repo.diff_between(&r.head, &diff.head).map_err(to_message)?
        }
        _ => Some(Vec::new()),
    };
    let worktree = repo.branch_worktree(&branch).map_err(to_message)?;
    let dirty = match &worktree {
        Some(dir) => Repo::worktree_dirty(dir).map_err(to_message)?,
        None => false,
    };
    Ok(BranchReviewData {
        review,
        head: diff.head,
        base,
        files: diff.files,
        moves,
        worktree: worktree.map(|p| p.to_string_lossy().into_owned()),
        dirty,
    })
}

fn stored_review_load_impl(path: String, key: ReviewKey) -> Result<Option<StoredReview>, String> {
    open(&path)?.stored_review(&key).map_err(to_message)
}

fn stored_review_save_impl(path: String, review: StoredReview) -> Result<(), String> {
    open(&path)?.save_stored_review(&review).map_err(to_message)
}

fn stored_review_delete_impl(path: String, key: ReviewKey) -> Result<(), String> {
    open(&path)?.delete_stored_review(&key).map_err(to_message)
}

/// Run the review `command` over `branch` against `base` as a Claude job:
/// one per branch at a time, with its own Stop.
fn branch_generate_review_impl(
    jobs: &ClaudeJobs,
    path: String,
    branch: String,
    base: String,
    command: String,
    label: Option<String>,
) -> Result<GeneratedBranchReview, String> {
    let mut repo = open(&path)?;
    let run = jobs.begin(NewJob {
        kind: JobKind::Review,
        label: format!("{} · {branch}", label.as_deref().unwrap_or("Review")),
        activity: String::new(),
        repo: path,
        pr: 0,
        thread: None,
        finding: None,
        branch: Some(branch.clone()),
        command: command.clone(),
        stdin_bytes: 0,
    })?;
    repo.set_network_hooks(run.hooks());
    let out = repo
        .generate_branch_review(&branch, &base, &command)
        .map_err(to_message);
    run.finish(
        out.as_ref().map(|r| r.text.clone()).map_err(Clone::clone),
        &[],
    );
    out
}

/// Fix draft `id` of the review at `key` in its branch's worktree, as a
/// Claude job, under the branch's fix lock; the review with the draft
/// marked fixed.
fn review_draft_fix_impl(
    jobs: &ClaudeJobs,
    fixes: &FixJobs,
    path: String,
    key: ReviewKey,
    id: u64,
    input: FindingInput,
    fix_command: String,
) -> Result<StoredReview, String> {
    let file = input
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&input.path)
        .to_string();
    let place = match &key {
        ReviewKey::Pr(n) => format!("#{n}"),
        ReviewKey::Branch(b) => b.clone(),
    };
    fixes.hold(&path, &input.branch)?;
    let out = jobs
        .begin(NewJob {
            kind: JobKind::Thread,
            label: format!("{file}:{} · {place}", input.line),
            activity: "Fix".into(),
            repo: path.clone(),
            pr: input.pr.unwrap_or(0),
            thread: None,
            finding: Some(format!("d{id}")),
            branch: Some(input.branch.clone()),
            command: fix_command.clone(),
            stdin_bytes: input.body.len(),
        })
        .and_then(|run| {
            let out = open(&path).and_then(|mut repo| {
                repo.set_network_hooks(run.hooks());
                repo.fix_review_draft(&key, id, &input, &fix_command)
                    .map_err(to_message)
            });
            let said = out
                .as_ref()
                .map(|r| {
                    r.drafts
                        .iter()
                        .find(|d| d.id == id)
                        .and_then(|d| d.fix.as_ref())
                        .map(|f| format!("Fixed in {}", &f.commit[..f.commit.len().min(7)]))
                        .unwrap_or_default()
                })
                .map_err(Clone::clone);
            run.finish(said, &[]);
            out
        });
    fixes.release(&path, &input.branch);
    out
}

// --- Tauri commands ----------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn review_default_base(path: String) -> Result<String, String> {
    review_default_base_impl(path)
}

#[tauri::command(async)]
pub(crate) fn branch_review_load(
    path: String,
    branch: String,
    base: Option<String>,
) -> Result<BranchReviewData, String> {
    branch_review_load_impl(path, branch, base)
}

#[tauri::command(async)]
pub(crate) fn stored_review_load(
    path: String,
    key: ReviewKey,
) -> Result<Option<StoredReview>, String> {
    stored_review_load_impl(path, key)
}

#[tauri::command(async)]
pub(crate) fn stored_review_save(path: String, review: StoredReview) -> Result<(), String> {
    stored_review_save_impl(path, review)
}

#[tauri::command(async)]
pub(crate) fn stored_review_delete(path: String, key: ReviewKey) -> Result<(), String> {
    stored_review_delete_impl(path, key)
}

#[tauri::command(async)]
pub(crate) fn branch_generate_review(
    path: String,
    branch: String,
    base: String,
    command: String,
    label: Option<String>,
    jobs: State<ClaudeJobs>,
) -> Result<GeneratedBranchReview, String> {
    branch_generate_review_impl(&jobs, path, branch, base, command, label)
}

#[tauri::command]
pub(crate) fn branch_cancel_review(path: String, branch: String, jobs: State<ClaudeJobs>) {
    jobs.stop_branch(JobKind::Review, &path, &branch);
}

#[tauri::command(async)]
pub(crate) fn review_draft_fix(
    path: String,
    key: ReviewKey,
    id: u64,
    input: FindingInput,
    fix_command: String,
    jobs: State<ClaudeJobs>,
    fixes: State<FixJobs>,
) -> Result<StoredReview, String> {
    review_draft_fix_impl(&jobs, &fixes, path, key, id, input, fix_command)
}

#[tauri::command]
pub(crate) fn review_draft_fix_cancel(path: String, branch: String, jobs: State<ClaudeJobs>) {
    jobs.stop_branch(JobKind::Thread, &path, &branch);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{git, make_repo};
    use gitp_core::{DraftStatus, StoredDraft};

    fn stored(branch: &str, head: &str) -> StoredReview {
        StoredReview {
            version: 1,
            branch: Some(branch.into()),
            pr: None,
            base: "main".into(),
            head: head.into(),
            drafts: vec![StoredDraft {
                id: 1,
                path: "f.txt".into(),
                line: 1,
                side: "RIGHT".into(),
                body: "x".into(),
                severity: None,
                original: "x".into(),
                status: DraftStatus::Pending,
                topic: None,
                fix: None,
                stale: false,
            }],
        }
    }

    fn rev(dir: &std::path::Path, r: &str) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["rev-parse", r])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn a_branch_review_loads_its_diff_moves_and_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        make_repo(d, &["c1"]);
        git(d, &["branch", "-M", "main"]);
        git(d, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(d.join("f.txt"), "changed\n").unwrap();
        git(d, &["commit", "-qam", "c2"]);
        let path = d.to_string_lossy().into_owned();
        let reviewed = rev(d, "feature");
        let repo = Repo::open(d).unwrap();
        repo.save_stored_review(&stored("feature", &reviewed))
            .unwrap();

        let data = branch_review_load_impl(path.clone(), "feature".into(), None).unwrap();
        assert_eq!(data.base, "main");
        assert_eq!(data.head, reviewed);
        assert_eq!(data.files.len(), 1);
        assert_eq!(
            data.moves.as_ref().map(Vec::len),
            Some(0),
            "nothing moved yet"
        );
        assert!(data.review.is_some());
        assert_eq!(data.worktree.as_deref().map(canon), Some(canon(&path)));
        assert!(!data.dirty);

        std::fs::write(d.join("g.txt"), "new\n").unwrap();
        git(d, &["add", "g.txt"]);
        git(d, &["commit", "-qm", "c3"]);
        std::fs::write(d.join("loose.txt"), "wip").unwrap();
        let data = branch_review_load_impl(path, "feature".into(), Some("main".into())).unwrap();
        let moved: Vec<_> = data.moves.unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(moved, ["g.txt"]);
        assert!(data.dirty);
    }

    fn canon(p: &str) -> String {
        std::fs::canonicalize(p)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_finding_fix_is_refused_while_a_fix_runs_on_the_branch() {
        let jobs = ClaudeJobs::default();
        let fixes = FixJobs::default();
        let input = || FindingInput {
            path: "f.txt".into(),
            line: 1,
            side: "RIGHT".into(),
            body: "x".into(),
            severity: None,
            diff_hunk: String::new(),
            branch: "feature".into(),
            base: "main".into(),
            pr: None,
            pr_head: None,
        };
        let key = ReviewKey::Branch("feature".into());
        fixes.hold("/nowhere", "feature").unwrap();
        let err = review_draft_fix_impl(
            &jobs,
            &fixes,
            "/nowhere".into(),
            key.clone(),
            1,
            input(),
            "true".into(),
        )
        .unwrap_err();
        assert_eq!(err, "A fix is already running on feature.");
        fixes.release("/nowhere", "feature");
        // A repository that doesn't exist fails and releases both locks.
        assert!(review_draft_fix_impl(
            &jobs,
            &fixes,
            "/nowhere".into(),
            key,
            1,
            input(),
            "true".into()
        )
        .is_err());
        assert!(fixes.hold("/nowhere", "feature").is_ok() && jobs.running().is_empty());
    }
}
