//! `Repo::search_log`: the commit-search query language over a cached log.

mod common;

use std::path::Path;

use common::FixtureRepo;
use gitp_core::{LogSearch, Repo};

// 2024-01-10, 2024-01-20 and 2024-02-05, midday UTC.
const JAN_10: i64 = 1_704_888_000;
const JAN_20: i64 = 1_705_752_000;
const FEB_05: i64 = 1_707_134_400;

/// Write `files`, stage them and commit on HEAD as `author` at `time`.
fn commit(
    fx: &FixtureRepo,
    files: &[(&str, &str)],
    message: &str,
    author: (&str, &str),
    time: i64,
) -> String {
    let mut index = fx.repo.index().unwrap();
    for (name, contents) in files {
        let full = fx.path().join(name);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, contents).unwrap();
        index.add_path(Path::new(name)).unwrap();
    }
    index.write().unwrap();
    let tree = fx.repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::new(author.0, author.1, &git2::Time::new(time, 0)).unwrap();
    let parent = fx.repo.head().ok().map(|h| h.peel_to_commit().unwrap());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    fx.repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
        .to_string()
}

const ANA: (&str, &str) = ("Ana Lopez", "ana@example.com");
const BEN: (&str, &str) = ("Ben Okafor", "ben@corp.test");

/// Three commits on `main`, newest last:
/// - c1 Ana, Jan 10: adds src/parser.rs and README.md
/// - c2 Ben, Jan 20: edits src/parser.rs, body mentions a ticket
/// - c3 Ana, Feb 05: edits docs/guide.md, adds the string `retry budget`
fn fixture() -> (FixtureRepo, [String; 3]) {
    let fx = FixtureRepo::init();
    let c1 = commit(
        &fx,
        &[
            ("src/parser.rs", "fn parse() {}\n"),
            ("README.md", "# demo\n"),
        ],
        "Add parser",
        ANA,
        JAN_10,
    );
    let c2 = commit(
        &fx,
        &[("src/parser.rs", "fn parse() { todo!() }\n")],
        "Tidy parser\n\nThis closes TICKET-42 and\nsomething else entirely.\n",
        BEN,
        JAN_20,
    );
    let c3 = commit(
        &fx,
        &[("docs/guide.md", "Set the retry budget low.\n")],
        "Document settings",
        ANA,
        FEB_05,
    );
    (fx, [c1, c2, c3])
}

/// The ids matching `query`, in the order the search returned them.
fn search(repo: &Repo, all_branches: bool, query: &str) -> Vec<String> {
    let mut cache = repo.log_cache(all_branches).unwrap();
    let mut search = LogSearch::parse(query);
    repo.search_log(&mut cache, &mut search)
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect()
}

#[test]
fn free_text_searches_subject_body_author_and_id() {
    let (fx, [c1, c2, c3]) = fixture();
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(
        search(&repo, false, "PARSER"),
        vec![c2.clone(), c1.clone()],
        "subject, log order"
    );
    assert_eq!(search(&repo, false, "ticket-42"), vec![c2.clone()], "body");
    assert_eq!(
        search(&repo, false, "entirely"),
        vec![c2.clone()],
        "body past line one"
    );
    assert_eq!(
        search(&repo, false, "okafor"),
        vec![c2.clone()],
        "author name"
    );
    assert_eq!(
        search(&repo, false, "corp.test"),
        vec![c2.clone()],
        "author email"
    );
    assert_eq!(search(&repo, false, &c3[..7]), vec![c3.clone()], "short id");
    assert!(
        !search(&repo, false, &c3[2..9]).contains(&c3),
        "an id matches only by prefix"
    );
    // Words are ANDed, and may match different fields.
    assert_eq!(search(&repo, false, "ana parser"), vec![c1.clone()]);
    // A quoted phrase must match as a whole.
    assert_eq!(search(&repo, false, r#""add parser""#), vec![c1]);
    assert!(search(&repo, false, r#""parser add""#).is_empty());
}

#[test]
fn author_matches_name_or_email_only() {
    let (fx, [c1, c2, c3]) = fixture();
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(
        search(&repo, false, "author:ana"),
        vec![c3.clone(), c1.clone()]
    );
    assert_eq!(search(&repo, false, "author:BEN@CORP"), vec![c2.clone()]);
    assert_eq!(search(&repo, false, r#"author:"ben okafor""#), vec![c2]);
    // Not the message: "parser" is in subjects, but no author is called that.
    assert!(search(&repo, false, "author:parser").is_empty());
}

#[test]
fn path_matches_files_directories_and_globs() {
    let (fx, [c1, c2, c3]) = fixture();
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(
        search(&repo, false, "path:src/parser.rs"),
        vec![c2.clone(), c1.clone()]
    );
    assert_eq!(
        search(&repo, false, "path:docs"),
        vec![c3.clone()],
        "a directory"
    );
    assert_eq!(
        search(&repo, false, "path:*.md"),
        vec![c3.clone(), c1.clone()],
        "a glob"
    );
    assert!(search(&repo, false, "path:nowhere.txt").is_empty());
    // ANDed with the other terms.
    assert_eq!(search(&repo, false, "path:src author:ben"), vec![c2]);
    assert!(search(&repo, false, "path:docs path:README.md").is_empty());
}

#[test]
fn path_and_content_follow_the_all_branches_toggle() {
    let (fx, [_, _, c3]) = fixture();
    let main = fx.repo.head().unwrap().name().unwrap().to_string();
    // A side branch off c3 touching a new file, then back to main.
    fx.repo
        .branch(
            "side",
            &fx.repo
                .find_commit(git2::Oid::from_str(&c3).unwrap())
                .unwrap(),
            false,
        )
        .unwrap();
    fx.repo.set_head("refs/heads/side").unwrap();
    let side = commit(
        &fx,
        &[("side.txt", "only on the side branch\n")],
        "Side work",
        BEN,
        FEB_05 + 60,
    );
    fx.repo.set_head(&main).unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(search(&repo, true, "path:side.txt"), vec![side.clone()]);
    assert!(
        search(&repo, false, "path:side.txt").is_empty(),
        "HEAD-only mode can't see it"
    );
    assert_eq!(search(&repo, true, r#"content:"the side""#), vec![side]);
    assert!(search(&repo, false, r#"content:"the side""#).is_empty());
}

#[test]
fn content_finds_commits_adding_or_removing_a_string() {
    let (fx, [c1, c2, c3]) = fixture();
    // c4 removes the phrase c3 added.
    let c4 = commit(
        &fx,
        &[("docs/guide.md", "Set it low.\n")],
        "Simplify",
        ANA,
        FEB_05 + 60,
    );
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(
        search(&repo, false, r#"content:"retry budget""#),
        vec![c4, c3]
    );
    assert_eq!(search(&repo, false, "-S:todo!"), vec![c2.clone()]);
    // `fn parse` is added by c1; c2 keeps one occurrence, so it doesn't count.
    assert_eq!(search(&repo, false, r#"content:"fn parse""#), vec![c1]);
    // Pickaxe is case-sensitive, like git's.
    assert!(search(&repo, false, "content:TODO!").is_empty());
}

#[test]
fn dates_bound_the_author_date() {
    let (fx, [c1, c2, c3]) = fixture();
    let repo = Repo::open(fx.path()).unwrap();

    assert_eq!(
        search(&repo, false, "after:2024-01-20"),
        vec![c3.clone(), c2.clone()],
        "inclusive"
    );
    assert_eq!(
        search(&repo, false, "before:2024-01-20"),
        vec![c1],
        "exclusive"
    );
    assert_eq!(
        search(&repo, false, "after:2024-01-11 before:2024-02-01"),
        vec![c2]
    );
    assert_eq!(
        search(&repo, false, "after:2024-02-01 author:ana"),
        vec![c3]
    );
    assert!(search(&repo, false, "before:2024-01-01").is_empty());
}

#[test]
fn a_blank_or_keys_only_query_is_empty() {
    assert!(LogSearch::parse("").is_empty());
    assert!(LogSearch::parse("author: path:").is_empty());
    assert!(!LogSearch::parse("path:src").is_empty());
    assert!(LogSearch::parse("path:src").needs_git());
    assert!(!LogSearch::parse("author:ana").needs_git());
}

#[test]
fn bodies_stay_searchable_after_the_cache_is_refreshed() {
    let (fx, [_, c2, _]) = fixture();
    let repo = Repo::open(fx.path()).unwrap();
    let mut cache = repo.log_cache(false).unwrap();
    let mut s = LogSearch::parse("ticket-42");
    assert_eq!(repo.search_log(&mut cache, &mut s).unwrap().len(), 1);

    // A new commit with its own body: the refreshed cache must read it in.
    let c4 = commit(
        &fx,
        &[("x.txt", "x\n")],
        "Chore\n\nRefs TICKET-42 too.\n",
        BEN,
        FEB_05 + 60,
    );
    repo.refresh_log(&mut cache, false).unwrap();
    let mut s = LogSearch::parse("ticket-42");
    let ids: Vec<String> = repo
        .search_log(&mut cache, &mut s)
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, vec![c4, c2]);
}
