//! Time the Code tab's engine on a real tree:
//!
//! ```sh
//! cargo run --release -p gitp-code --example bench -- /path/to/project
//! ```
//!
//! Walk, first index build, one-file reindex, definition / usages / callers
//! per query, three searches, and the process's resident memory before and
//! after the build.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use gitp_code::files::walk;
use gitp_code::grep::{search, Query};
use gitp_code::index::{reindex_many, RefKind, SymbolIndex};
use gitp_code::resolve::{callers, definition, references};

fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output();
    out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok()).map_or(0.0, |kb| kb / 1024.0)
}

fn pct(times: &mut [Duration], p: f64) -> Duration {
    times.sort();
    times[((times.len() - 1) as f64 * p) as usize]
}

fn report(what: &str, times: &mut Vec<Duration>) {
    if times.is_empty() {
        println!("{what:<34} (no samples)");
        return;
    }
    let p50 = pct(times, 0.5);
    let p95 = pct(times, 0.95);
    let max = *times.last().unwrap();
    println!("{what:<34} n={:<5} p50={:>8.2?} p95={:>8.2?} max={:>8.2?}", times.len(), p50, p95, max);
}

fn main() {
    let root = std::env::args().nth(1).expect("usage: bench <root>");
    let root = Path::new(&root);
    println!("root: {}", root.display());
    println!("rss before: {:.0} MB", rss_mb());

    let t = Instant::now();
    let files = walk(root).expect("walk");
    let supported = files.iter().filter(|f| f.lang.is_some()).count();
    println!("walk: {} files ({supported} supported) in {:.2?}", files.len(), t.elapsed());

    let t = Instant::now();
    let index = SymbolIndex::build(root, &files);
    let (nfiles, nsymbols, nrefs) = index.stats();
    println!("build: {nfiles} files, {nsymbols} symbols, {nrefs} refs in {:.2?}", t.elapsed());
    println!("rss after build: {:.0} MB", rss_mb());

    // Queries over a spread of files: every reference in every 25th file.
    let mut defs = Vec::new();
    let mut found = 0usize;
    let mut ambiguous = 0usize;
    let mut samples = Vec::new();
    for (i, fi) in index.files().enumerate() {
        if i % 25 != 0 {
            continue;
        }
        for r in fi.refs.iter().filter(|r| r.kind != RefKind::Import).take(20) {
            samples.push((fi.path.clone(), r.range.start_line, r.range.start_col));
        }
    }
    for (path, line, col) in &samples {
        let t = Instant::now();
        let d = definition(&index, path, *line, *col);
        defs.push(t.elapsed());
        if !d.is_empty() {
            found += 1;
        }
        if d.len() > 1 {
            ambiguous += 1;
        }
    }
    report("definition", &mut defs);
    println!("  resolved {found}/{} ({ambiguous} with a pick list)", samples.len());

    // Usages and callers for a spread of symbols, including the popular names.
    let mut syms: Vec<_> = index.files().flat_map(|f| f.symbols.iter()).step_by(97).take(300).cloned().collect();
    let mut popular: Vec<_> = index.top_names(10).into_iter().filter_map(|n| index.definitions_named(&n).next().cloned()).collect();
    syms.append(&mut popular);
    let mut usages = Vec::new();
    let mut callers_t = Vec::new();
    let mut biggest = (0usize, String::new());
    for s in &syms {
        let t = Instant::now();
        let (hits, _) = references(&index, s, 2000);
        usages.push(t.elapsed());
        if hits.len() > biggest.0 {
            biggest = (hits.len(), s.name.to_string());
        }
        let t = Instant::now();
        let _ = callers(&index, s, 2000);
        callers_t.push(t.elapsed());
    }
    report("usages (cap 2000)", &mut usages);
    println!("  largest answer: {} hits for `{}`", biggest.0, biggest.1);
    report("callers (cap 2000)", &mut callers_t);

    // Reindex one file, parsed outside the lock, as a save does.
    let lock = RwLock::new(index);
    let target = files.iter().filter(|f| f.lang.is_some()).max_by_key(|f| f.size).map(|f| f.path.clone()).unwrap();
    let size = files.iter().find(|f| f.path == target).map_or(0, |f| f.size);
    let mut re = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        reindex_many(&lock, root, std::slice::from_ref(&target));
        re.push(t.elapsed());
    }
    report(&format!("reindex largest file ({} KB)", size / 1024), &mut re);

    for (label, q) in [
        ("search literal `function`", Query { pattern: "function".into(), regex: false, case_sensitive: false, whole_word: false, include_glob: None }),
        ("search regex", Query { pattern: r"fun[ct]+ion\s+\w+\(".into(), regex: true, case_sensitive: true, whole_word: false, include_glob: None }),
        ("search whole word `require`", Query { pattern: "require".into(), regex: false, case_sensitive: true, whole_word: true, include_glob: Some("*.js".into()) }),
    ] {
        let t = Instant::now();
        let r = search(root, &q, 2000, Arc::new(AtomicBool::new(false))).expect("search");
        println!("{label:<34} {} hits{} in {} files, {:.2?}", r.hits.len(), if r.truncated { " (truncated)" } else { "" }, r.files_searched, t.elapsed());
    }
    println!("rss at end: {:.0} MB", rss_mb());
}
