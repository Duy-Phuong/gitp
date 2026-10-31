//! Timings of the reads the GUI makes, against a large repository you supply.
//! Not a pass/fail test: it prints how long each read takes.
//!
//! ```sh
//! GITP_BENCH_REPO=/path/to/big/repo \
//!   cargo test -p gitp-core --release --test large_repo_timing -- --ignored --nocapture
//! ```
//!
//! `GITP_BENCH_BLAME` names a file to blame (default `src/big.c`), and
//! `GITP_BENCH_BRANCH` a branch to compare HEAD with (default: the first local
//! branch other than HEAD's). A history of the right shape — 100k commits, ~400
//! branches and their remote copies, ~460 tags, merges — is made by
//! `scripts/gen-large-repo.py`.

use std::time::{Duration, Instant};

use gitp_core::{LogScope, LogSearch, Repo};

/// Prints wall time and CPU time (this process plus the git processes it ran):
/// on a loaded machine the wall time says little, the CPU time still compares.
fn time<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let cpu = cpu_time();
    let start = Instant::now();
    let out = f();
    let wall = start.elapsed();
    let cpu = cpu_time() - cpu;
    println!(
        "{label:<44} {:>9.1} ms wall {:>9.1} ms cpu",
        wall.as_secs_f64() * 1000.0,
        cpu.as_secs_f64() * 1000.0
    );
    out
}

fn cpu_time() -> Duration {
    let mut total = Duration::ZERO;
    for who in [libc::RUSAGE_SELF, libc::RUSAGE_CHILDREN] {
        // SAFETY: getrusage only writes the struct it is handed.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(who, &mut usage) };
        for t in [usage.ru_utime, usage.ru_stime] {
            total += Duration::from_secs(t.tv_sec as u64) + Duration::from_micros(t.tv_usec as u64);
        }
    }
    total
}

#[test]
#[ignore = "needs GITP_BENCH_REPO; run explicitly"]
fn large_repo_timings() {
    let Ok(path) = std::env::var("GITP_BENCH_REPO") else {
        eprintln!("GITP_BENCH_REPO not set: nothing to time");
        return;
    };
    let repo = time("open", || Repo::open(&path).unwrap());
    for _ in 0..3 {
        time("state_fingerprint", || repo.state_fingerprint().unwrap());
    }

    let scope = LogScope::from(true);
    println!("  commit-graph: {}", !repo.commit_graph_missing());
    time("first page (5000 rows read, all branches)", || {
        let mut walk = repo.start_log_walk(&scope).unwrap();
        walk.first_rows(5000).unwrap().unwrap()
    });
    let mut cache = time("log_cache (all branches: walk + lanes)", || {
        repo.log_cache_scoped(&scope).unwrap()
    });
    println!("  {} rows", cache.rows.len());
    time("log_cache (HEAD only)", || repo.log_cache(false).unwrap());
    time("refresh_log (unchanged)", || {
        repo.refresh_log_scoped(&mut cache, &scope).unwrap()
    });
    let pinned = LogScope {
        pinned: Some("main".into()),
        ..scope.clone()
    };
    time("refresh_log (pin main: relay lanes)", || {
        repo.refresh_log_scoped(&mut cache, &pinned).unwrap()
    });
    time("refresh_log (unpin)", || {
        repo.refresh_log_scoped(&mut cache, &scope).unwrap()
    });

    time("refs", || repo.refs().unwrap());
    let refs = time("refs (again)", || repo.refs().unwrap());
    println!(
        "  {} local, {} remote branches, {} tags",
        refs.branches.len(),
        refs.remotes.len(),
        refs.tags.len()
    );

    for query in [
        "refactor parse",
        "author:dev7",
        "refactor parse",
        "path:src/mod3/file345.rs",
        "content:\"file345.rs line 3 v3\"",
    ] {
        let mut search = LogSearch::parse(query);
        let hits = time(&format!("search {query}"), || {
            repo.search_log(&mut cache, &mut search).unwrap()
        });
        println!("  {} hits", hits.len());
    }

    let head = repo.resolve_commit("HEAD").unwrap();
    time("commit_detail HEAD", || repo.commit_detail(&head).unwrap());
    let merge = cache
        .rows
        .iter()
        .find(|r| r.parents.len() > 1)
        .map(|r| r.id.clone());
    if let Some(merge) = merge {
        time("commit_detail (a merge)", || {
            repo.commit_detail(&merge).unwrap()
        });
    }
    let root = cache.rows.last().unwrap().id.clone();
    let detail = time("commit_detail (root commit)", || {
        repo.commit_detail(&root).unwrap()
    });
    println!("  {} files", detail.files.len());

    let branch = std::env::var("GITP_BENCH_BRANCH").ok().or_else(|| {
        refs.branches
            .iter()
            .find(|b| !b.is_head)
            .map(|b| b.name.clone())
    });
    if let Some(branch) = branch {
        let cmp = time(&format!("compare HEAD..{branch}"), || {
            repo.compare("HEAD", &branch, true).unwrap()
        });
        println!(
            "  ahead {} behind {}, {} files",
            cmp.ahead,
            cmp.behind,
            cmp.files.len()
        );
        time("compare HEAD..root (two-dot)", || {
            repo.compare(&root, "HEAD", false).unwrap()
        });
    }

    let blame_path = std::env::var("GITP_BENCH_BLAME").unwrap_or_else(|_| "src/big.c".into());
    let lines = time(&format!("blame {blame_path}"), || {
        repo.blame("HEAD", &blame_path).unwrap()
    });
    println!("  {} lines", lines.len());
    let history = time(&format!("file_history {blame_path}"), || {
        repo.file_history("HEAD", &blame_path).unwrap()
    });
    println!("  {} commits", history.len());

    let summary = time("status_summary", || repo.status_summary().unwrap());
    println!(
        "  {} staged, {} unstaged",
        summary.staged.len(),
        summary.unstaged.len()
    );
    time("status_lists", || repo.status_lists().unwrap());
    let changes = time("working_changes", || repo.working_changes().unwrap());
    println!("  {} files", changes.len());
}
