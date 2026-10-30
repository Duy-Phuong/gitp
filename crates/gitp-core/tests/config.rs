mod common;

use common::FixtureRepo;
use gitp_core::{ConfigScope, Repo};

#[test]
fn reads_local_entries_tagged_with_local_scope() {
    let fixture = FixtureRepo::init();
    {
        let mut cfg = fixture.repo.config().unwrap();
        cfg.set_str("gitp.greeting", "hello").unwrap();
    }

    let repo = Repo::open(fixture.path()).unwrap();
    let entries = repo.read_config().unwrap();

    let entry = entries
        .iter()
        .find(|e| e.name == "gitp.greeting")
        .expect("greeting should be present");
    assert_eq!(entry.value, "hello");
    assert_eq!(entry.scope, ConfigScope::Local);
}

#[test]
fn sets_a_local_value_and_reads_it_back() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();

    repo.set_config(ConfigScope::Local, "gitp.editor", "vim")
        .unwrap();

    let entries = repo.read_config().unwrap();
    let entry = entries
        .iter()
        .find(|e| e.name == "gitp.editor")
        .expect("editor should be present after set");
    assert_eq!(entry.value, "vim");
    assert_eq!(entry.scope, ConfigScope::Local);
}

#[test]
fn overwrites_an_existing_local_value() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();

    repo.set_config(ConfigScope::Local, "gitp.editor", "vim")
        .unwrap();
    repo.set_config(ConfigScope::Local, "gitp.editor", "hx")
        .unwrap();

    let entries = repo.read_config().unwrap();
    let matches: Vec<_> = entries.iter().filter(|e| e.name == "gitp.editor").collect();
    assert_eq!(matches.len(), 1, "value replaced, not duplicated");
    assert_eq!(matches[0].value, "hx");
}

#[test]
fn commit_template_is_none_when_unset() {
    let fixture = FixtureRepo::init();
    let repo = Repo::open(fixture.path()).unwrap();

    assert_eq!(repo.commit_template().unwrap(), None);
}

#[test]
fn commit_template_reads_an_absolute_path() {
    let fixture = FixtureRepo::init();
    let tmpl = fixture.path().join("msg.txt");
    std::fs::write(&tmpl, "feat: \n# hint\n").unwrap();
    let repo = Repo::open(fixture.path()).unwrap();
    repo.set_config(
        ConfigScope::Local,
        "commit.template",
        tmpl.to_str().unwrap(),
    )
    .unwrap();

    assert_eq!(
        repo.commit_template().unwrap().as_deref(),
        Some("feat: \n# hint\n")
    );
}

#[test]
fn commit_template_resolves_a_relative_path_from_the_working_directory() {
    let fixture = FixtureRepo::init();
    std::fs::create_dir(fixture.path().join(".github")).unwrap();
    std::fs::write(fixture.path().join(".github/msg.txt"), "fix: ").unwrap();
    let repo = Repo::open(fixture.path()).unwrap();
    repo.set_config(ConfigScope::Local, "commit.template", ".github/msg.txt")
        .unwrap();

    assert_eq!(repo.commit_template().unwrap().as_deref(), Some("fix: "));
}
