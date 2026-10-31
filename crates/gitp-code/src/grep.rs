//! Full-text search over the working tree on the ripgrep crates: gitignore
//! honoured, binaries skipped, a cap on hits, and a cancel flag a newer
//! query raises on the older one.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
pub struct Query {
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// A glob like `*.ts` or `src/**`; only matching files are searched.
    pub include_glob: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hit {
    pub path: String,
    /// 0-based.
    pub line: u32,
    /// UTF-16 units.
    pub col: u32,
    pub end_col: u32,
    /// The whole line, trailing whitespace dropped, at most 400 chars.
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub truncated: bool,
    pub files_searched: u32,
}


/// Search `root` for `q`, at most `limit` hits. The error for a bad pattern
/// is the regex engine's own message.
pub fn search(root: &Path, q: &Query, limit: usize, cancel: Arc<AtomicBool>) -> Result<SearchResult, String> {
    use grep_matcher::Matcher;
    use grep_searcher::{sinks::UTF8, BinaryDetection, SearcherBuilder};
    use ignore::WalkState;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    let mut pattern = if q.regex { q.pattern.clone() } else { regex_syntax::escape(&q.pattern) };
    if q.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let matcher = grep_regex::RegexMatcherBuilder::new()
        .case_insensitive(!q.case_sensitive)
        .build(&pattern)
        .map_err(|e| e.to_string())?;

    let hits = Arc::new(Mutex::new(Vec::<Hit>::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let files = Arc::new(AtomicUsize::new(0));

    let mut walk = ignore::WalkBuilder::new(root);
    walk.hidden(false).require_git(false).git_ignore(true).git_global(true).git_exclude(true).filter_entry(|e| e.file_name() != ".git");
    if let Some(glob) = &q.include_glob {
        let mut ov = ignore::overrides::OverrideBuilder::new(root);
        ov.add(glob).map_err(|e| e.to_string())?;
        walk.overrides(ov.build().map_err(|e| e.to_string())?);
    }
    walk.build_parallel().run(|| {
        let (matcher, hits, count, files, cancel) = (matcher.clone(), hits.clone(), count.clone(), files.clone(), cancel.clone());
        let mut searcher = SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).line_number(true).build();
        Box::new(move |entry| {
            if cancel.load(Ordering::Relaxed) || count.load(Ordering::Relaxed) > limit {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            files.fetch_add(1, Ordering::Relaxed);
            let rel = entry.path().strip_prefix(root).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
            let _ = searcher.search_path(
                &matcher,
                entry.path(),
                UTF8(|line_no, line| {
                    let mut start = 0;
                    while let Ok(Some(m)) = matcher.find_at(line.as_bytes(), start) {
                        // One past the limit is kept so the caller can tell there were more.
                        if count.fetch_add(1, Ordering::Relaxed) > limit {
                            return Ok(false);
                        }
                        hits.lock().unwrap().push(Hit {
                            path: rel.clone(),
                            line: line_no as u32 - 1,
                            col: line[..m.start()].encode_utf16().count() as u32,
                            end_col: line[..m.end()].encode_utf16().count() as u32,
                            text: line.trim_end().chars().take(400).collect(),
                        });
                        start = if m.end() > m.start() { m.end() } else { m.end() + 1 };
                        if start > line.len() {
                            break;
                        }
                    }
                    Ok(true)
                }),
            );
            WalkState::Continue
        })
    });

    let mut hits = std::mem::take(&mut *hits.lock().unwrap());
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)).then(a.col.cmp(&b.col)));
    let truncated = hits.len() > limit;
    hits.truncate(limit);
    Ok(SearchResult { hits, truncated, files_searched: files.load(Ordering::Relaxed) as u32 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        std::fs::write(root.join("src/a.ts"), "const total = 1;\nfunction totals() {}\nlet axb = total;\n").unwrap();
        std::fs::write(root.join("src/b.py"), "TOTAL = 2\n# café total\n").unwrap();
        std::fs::write(root.join("build/out.ts"), "total\n").unwrap();
        std::fs::write(root.join("blob.bin"), b"total\0total").unwrap();
        dir
    }

    fn q(pattern: &str) -> Query {
        Query { pattern: pattern.into(), regex: false, case_sensitive: false, whole_word: false, include_glob: None }
    }

    fn run(dir: &tempfile::TempDir, q: &Query, limit: usize) -> SearchResult {
        search(dir.path(), q, limit, Arc::new(AtomicBool::new(false))).unwrap()
    }

    #[test]
    fn literal_is_escaped() {
        let dir = tree();
        let r = run(&dir, &q("a.b"), 100);
        assert!(r.hits.is_empty(), "a.b is not a regex: {:?}", r.hits);
    }

    #[test]
    fn regex_matches() {
        let dir = tree();
        let r = run(&dir, &Query { regex: true, ..q("a.b") }, 100);
        assert_eq!(r.hits.len(), 1);
        assert_eq!((r.hits[0].path.as_str(), r.hits[0].line, r.hits[0].col, r.hits[0].end_col), ("src/a.ts", 2, 4, 7));
        assert_eq!(r.hits[0].text, "let axb = total;");
    }

    #[test]
    fn case_insensitive_by_default() {
        let dir = tree();
        let r = run(&dir, &q("total"), 100);
        assert!(r.hits.iter().any(|h| h.path == "src/b.py" && h.line == 0), "TOTAL matches");
        let r = run(&dir, &Query { case_sensitive: true, ..q("total") }, 100);
        assert!(!r.hits.iter().any(|h| h.path == "src/b.py" && h.line == 0));
    }

    #[test]
    fn whole_word() {
        let dir = tree();
        let r = run(&dir, &Query { whole_word: true, case_sensitive: true, ..q("total") }, 100);
        let lines: Vec<(&str, u32)> = r.hits.iter().map(|h| (h.path.as_str(), h.line)).collect();
        assert_eq!(lines, [("src/a.ts", 0), ("src/a.ts", 2), ("src/b.py", 1)]);
    }

    #[test]
    fn gitignored_file_is_not_searched() {
        let dir = tree();
        let r = run(&dir, &q("total"), 100);
        assert!(!r.hits.iter().any(|h| h.path.starts_with("build/")));
    }

    #[test]
    fn binary_file_is_skipped() {
        let dir = tree();
        let r = run(&dir, &q("total"), 100);
        assert!(!r.hits.iter().any(|h| h.path == "blob.bin"));
    }

    #[test]
    fn limit_truncates() {
        let dir = tree();
        let r = run(&dir, &q("total"), 2);
        assert_eq!((r.hits.len(), r.truncated), (2, true));
        let r = run(&dir, &q("total"), 100);
        assert!(!r.truncated);
    }

    #[test]
    fn cancel_stops_early() {
        let dir = tree();
        let r = search(dir.path(), &q("total"), 100, Arc::new(AtomicBool::new(true))).unwrap();
        assert_eq!((r.hits.len(), r.files_searched), (0, 0));
    }

    #[test]
    fn invalid_regex_is_an_error() {
        let dir = tree();
        let err = search(dir.path(), &Query { regex: true, ..q("(") }, 100, Arc::new(AtomicBool::new(false))).unwrap_err();
        assert!(err.to_lowercase().contains("regex") || err.contains("parse"), "{err}");
    }

    #[test]
    fn columns_are_utf16() {
        let dir = tree();
        let r = run(&dir, &Query { case_sensitive: true, ..q("total") }, 100);
        let hit = r.hits.iter().find(|h| h.path == "src/b.py").unwrap();
        assert_eq!((hit.line, hit.col, hit.end_col), (1, 7, 12));
    }

    #[test]
    fn include_glob_narrows() {
        let dir = tree();
        let r = run(&dir, &Query { include_glob: Some("*.py".into()), ..q("total") }, 100);
        assert!(r.hits.iter().all(|h| h.path.ends_with(".py")));
        assert!(!r.hits.is_empty());
        let _ = Ordering::Relaxed;
    }
}
