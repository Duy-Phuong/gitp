//! Commit search over the cached log: a small query language, every term ANDed.
//!
//! - bare words (or `"quoted phrases"`) — the message (subject and body),
//!   author name or email, or commit id, case-insensitive
//! - `author:<text>` — author name or email, case-insensitive
//! - `path:<path-or-glob>` — commits that touched a matching path
//! - `content:<text>` / `-S:<text>` — commits that add or remove `<text>`
//!   (`git log -S`, case-sensitive)
//! - `after:YYYY-MM-DD` / `before:YYYY-MM-DD` — author date on or after / before
//!   that day (UTC)
//!
//! Quotes group words into one value (`content:"foo bar"`). An unknown key, or
//! a date that doesn't parse, is searched for as plain text; a known key with
//! an empty value is dropped, so a half-typed `author:` filters nothing.

use std::collections::HashSet;

use crate::error::Result;
use crate::log::{CommitRow, LogCache};
use crate::repo::Repo;

/// A parsed search query. Text and author terms are lowercased; paths and
/// content are kept as typed, since git matches them case-sensitively.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct LogQuery {
    pub(crate) text: Vec<String>,
    pub(crate) authors: Vec<String>,
    pub(crate) paths: Vec<String>,
    pub(crate) contents: Vec<String>,
    /// Earliest author time to include, seconds since the epoch.
    pub(crate) after: Option<i64>,
    /// Author times from this one on are excluded.
    pub(crate) before: Option<i64>,
}

impl LogQuery {
    pub(crate) fn parse(input: &str) -> Self {
        let mut q = LogQuery::default();
        for (token, colon) in tokens(input) {
            let Some(i) = colon else {
                q.push_text(&token);
                continue;
            };
            let value = &token[i + 1..];
            let key = token[..i].to_lowercase();
            let known = match key.as_str() {
                "author" => push_nonempty(&mut q.authors, value.to_lowercase()),
                "path" => push_nonempty(&mut q.paths, value.to_string()),
                "content" | "-s" => push_nonempty(&mut q.contents, value.to_string()),
                "after" | "before" if value.is_empty() => true,
                "after" | "before" => match parse_date(value) {
                    // Repeats narrow: the latest `after:`, the earliest `before:`.
                    Some(t) if key == "after" => {
                        q.after = Some(q.after.map_or(t, |a| a.max(t)));
                        true
                    }
                    Some(t) => {
                        q.before = Some(q.before.map_or(t, |b| b.min(t)));
                        true
                    }
                    None => false,
                },
                _ => false,
            };
            if !known {
                q.push_text(&token);
            }
        }
        q
    }

    fn push_text(&mut self, token: &str) {
        push_nonempty(&mut self.text, token.to_lowercase());
    }

    fn is_empty(&self) -> bool {
        *self == LogQuery::default()
    }
}

/// Always `true`: the term was recognised, whether or not it had a value.
fn push_nonempty(terms: &mut Vec<String>, value: String) -> bool {
    if !value.is_empty() {
        terms.push(value);
    }
    true
}

/// Split on unquoted whitespace, dropping the quotes. Each token comes with the
/// byte offset of its first unquoted `:` — where a `key:` ends — so a quoted
/// colon (`"re: foo"`) stays part of the text. An unclosed quote runs to the end.
fn tokens(input: &str) -> Vec<(String, Option<usize>)> {
    let mut out = Vec::new();
    let mut token = String::new();
    let mut colon = None;
    let mut quoted = false;
    let mut started = false;
    for c in input.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    out.push((std::mem::take(&mut token), colon.take()));
                    started = false;
                }
            }
            c => {
                if c == ':' && !quoted && colon.is_none() {
                    colon = Some(token.len());
                }
                token.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push((token, colon));
    }
    out
}

/// `YYYY-MM-DD` as seconds since the epoch at midnight UTC.
fn parse_date(s: &str) -> Option<i64> {
    let mut parts = s.split('-');
    let (Some(y), Some(m), Some(d), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&m) || d < 1 || d > month_days[(m - 1) as usize] {
        return None;
    }
    // Days since 1970-01-01 in the proleptic Gregorian calendar (Howard
    // Hinnant's `days_from_civil`).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400)
}

/// A parsed search, plus the result of its `path:` / `content:` terms once
/// they've been run.
///
/// Those terms shell out to `git log` over the whole history, which can take
/// seconds on a large repo, and they need no cached state — so a caller holding
/// a lock around its `LogCache` can run them first, unlocked, with
/// `Repo::run_log_search_filters`. `Repo::search_log` runs them itself if not.
#[derive(Debug, Clone)]
pub struct LogSearch {
    query: LogQuery,
    /// Commits passing every `path:` and `content:` term, once run.
    git_matches: Option<HashSet<String>>,
}

impl LogSearch {
    pub fn parse(input: &str) -> Self {
        LogSearch {
            query: LogQuery::parse(input),
            git_matches: None,
        }
    }

    /// No terms at all (blank, or only empty `key:`s): nothing to search for.
    pub fn is_empty(&self) -> bool {
        self.query.is_empty()
    }

    /// Whether there are `path:` / `content:` terms still to run.
    pub fn needs_git(&self) -> bool {
        self.git_matches.is_none()
            && !(self.query.paths.is_empty() && self.query.contents.is_empty())
    }
}

impl Repo {
    /// Run `search`'s `path:` and `content:` terms over the history a log
    /// walk with the same `all_branches` would cover. Reads nothing cached, so
    /// it is safe to call without whatever guards the caller's `LogCache`.
    pub fn run_log_search_filters(&self, search: &mut LogSearch, all_branches: bool) -> Result<()> {
        if !search.needs_git() {
            return Ok(());
        }
        // The same tips as `log_tips`, named so git resolves them itself:
        // passing the ids would overflow Windows' command-line limit on a repo
        // with a few thousand remote branches.
        let mut revs: Vec<&str> = Vec::new();
        if all_branches {
            revs.extend(["--branches", "--remotes"]);
        }
        if self.inner.head().and_then(|h| h.peel_to_commit()).is_ok() {
            revs.push("HEAD");
        }
        let mut matched: Option<HashSet<String>> = None;
        if !revs.is_empty() {
            let q = &search.query;
            let runs = q.paths.iter().map(|p| (None, Some(p.as_str())));
            let runs = runs.chain(q.contents.iter().map(|c| (Some(format!("-S{c}")), None)));
            for (pickaxe, path) in runs {
                // `log.follow` would turn a lone pathspec into `--follow`, and
                // `log.showSignature` runs gpg per commit and prints its output.
                let mut args = vec!["-c", "log.follow=false", "-c", "log.showSignature=false"];
                args.extend(["log", "--no-color", "--format=%H"]);
                args.extend(pickaxe.as_deref());
                args.extend(&revs);
                args.push("--");
                args.extend(path);
                let out = self.run_git_raw(&args)?;
                let ids: HashSet<String> = String::from_utf8_lossy(&out)
                    .lines()
                    .map(str::trim)
                    .filter(|l| git2::Oid::from_str(l).is_ok())
                    .map(String::from)
                    .collect();
                matched = Some(match matched {
                    Some(prev) => prev.intersection(&ids).cloned().collect(),
                    None => ids,
                });
            }
        }
        search.git_matches = Some(matched.unwrap_or_default());
        Ok(())
    }

    /// The rows of `cache` matching `search`, in log order.
    ///
    /// Bare words also search each commit's full message, which `CommitRow`
    /// doesn't carry: the first such search reads every commit's message once
    /// and keeps it in `cache`, so later keystrokes only scan memory.
    pub fn search_log(
        &self,
        cache: &mut LogCache,
        search: &mut LogSearch,
    ) -> Result<Vec<CommitRow>> {
        self.run_log_search_filters(search, cache.all_branches())?;
        let q = &search.query;
        if !q.text.is_empty() {
            self.load_bodies(cache)?;
        }
        let rows = cache.rows.iter().filter(|row| {
            q.after.is_none_or(|t| row.time >= t)
                && q.before.is_none_or(|t| row.time < t)
                && search
                    .git_matches
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&row.id))
                && matches_author(row, &q.authors)
                && matches_text(row, &q.text, cache.bodies.get(&row.id).map(|b| &**b))
        });
        Ok(rows.cloned().collect())
    }

    /// Read the lowercased message body (everything after the subject line)
    /// of every cached commit that doesn't have one stored yet.
    fn load_bodies(&self, cache: &mut LogCache) -> Result<()> {
        for row in &cache.rows {
            if cache.bodies.contains_key(&row.id) {
                continue;
            }
            let commit = self.inner.find_commit(git2::Oid::from_str(&row.id)?)?;
            let message = String::from_utf8_lossy(commit.message_bytes());
            let body = message.split_once('\n').map_or("", |(_, rest)| rest.trim());
            cache
                .bodies
                .insert(row.id.clone(), body.to_lowercase().into());
        }
        Ok(())
    }
}

fn matches_author(row: &CommitRow, authors: &[String]) -> bool {
    if authors.is_empty() {
        return true;
    }
    let name = row.author_name.to_lowercase();
    let email = row.author_email.to_lowercase();
    authors
        .iter()
        .all(|a| name.contains(a) || email.contains(a))
}

/// Every word in the subject, body, author name or email, or as an id prefix
/// (anywhere inside a SHA would let short hex words like "add" hit at random).
fn matches_text(row: &CommitRow, text: &[String], body: Option<&str>) -> bool {
    if text.is_empty() {
        return true;
    }
    let summary = row.summary.to_lowercase();
    let name = row.author_name.to_lowercase();
    let email = row.author_email.to_lowercase();
    let body = body.unwrap_or("");
    text.iter().all(|t| {
        summary.contains(t)
            || body.contains(t)
            || name.contains(t)
            || email.contains(t)
            || row.id.starts_with(t.as_str())
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_date, LogQuery};

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn bare_words_are_separate_lowercased_text_terms() {
        let q = LogQuery::parse("  Fix   Parser ");
        assert_eq!(q.text, strings(&["fix", "parser"]));
        assert!(q.authors.is_empty() && q.paths.is_empty() && q.contents.is_empty());
    }

    #[test]
    fn keys_route_values_and_quotes_group_words() {
        let q = LogQuery::parse(
            r#"author:"Jane Doe" path:src/*.rs content:"foo bar" -S:baz "two words" wip"#,
        );
        assert_eq!(q.authors, strings(&["jane doe"]));
        assert_eq!(q.paths, strings(&["src/*.rs"]));
        assert_eq!(
            q.contents,
            strings(&["foo bar", "baz"]),
            "content: and -S: alike"
        );
        assert_eq!(q.text, strings(&["two words", "wip"]));
    }

    #[test]
    fn keys_are_case_insensitive_but_path_and_content_values_are_not() {
        let q = LogQuery::parse("AUTHOR:Jane Path:README.md Content:Foo");
        assert_eq!(q.authors, strings(&["jane"]));
        assert_eq!(q.paths, strings(&["README.md"]));
        assert_eq!(q.contents, strings(&["Foo"]));
    }

    #[test]
    fn unknown_keys_and_quoted_colons_are_plain_text() {
        let q = LogQuery::parse(r#"fixup:abc "re: thing" http://x.y"#);
        assert_eq!(q.text, strings(&["fixup:abc", "re: thing", "http://x.y"]));
    }

    #[test]
    fn empty_values_are_dropped_not_searched_for() {
        let q = LogQuery::parse(r#"author: path: content:"" after: before: """#);
        assert_eq!(q, LogQuery::default());
        assert!(q.is_empty());
        assert!(LogQuery::parse("   ").is_empty());
    }

    #[test]
    fn unclosed_quote_runs_to_the_end() {
        let q = LogQuery::parse(r#"content:"foo bar"#);
        assert_eq!(q.contents, strings(&["foo bar"]));
    }

    #[test]
    fn dates_bound_the_range_and_bad_dates_fall_back_to_text() {
        let q = LogQuery::parse("after:2024-01-01 before:2024-02-01 after:2023-06-01");
        assert_eq!(
            q.after,
            Some(1_704_067_200),
            "the later of two after:s wins"
        );
        assert_eq!(q.before, Some(1_706_745_600));

        let q = LogQuery::parse("after:yesterday before:2024-13-01");
        assert_eq!(q.after, None);
        assert_eq!(q.before, None);
        assert_eq!(q.text, strings(&["after:yesterday", "before:2024-13-01"]));
    }

    #[test]
    fn parses_calendar_dates() {
        assert_eq!(parse_date("1970-01-01"), Some(0));
        assert_eq!(parse_date("2000-03-01"), Some(951_868_800));
        assert_eq!(parse_date("2024-02-29"), Some(1_709_164_800), "leap day");
        assert_eq!(parse_date("2023-02-29"), None, "not a leap year");
        assert_eq!(parse_date("2024-1-01"), None);
        assert_eq!(parse_date("2024-01-01-01"), None);
    }
}
