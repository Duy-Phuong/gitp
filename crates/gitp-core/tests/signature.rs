//! Commit signatures: verification status for the detail pane, and signing
//! commits made from the commit box. Uses a throwaway SSH signing key, so it
//! needs only `ssh-keygen` (not gpg); skipped where `ssh-keygen` is missing.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::FixtureRepo;
use gitp_core::{Repo, SignatureStatus};

/// A temp ed25519 key pair (`key`, `key.pub`), or `None` without ssh-keygen.
fn ssh_key(dir: &Path, name: &str) -> Option<PathBuf> {
    let key = dir.join(name);
    let ok = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", name, "-f"])
        .arg(&key)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ok.then_some(key)
}

fn set(fx: &FixtureRepo, name: &str, value: &str) {
    fx.repo.config().unwrap().set_str(name, value).unwrap();
}

/// A repo configured to sign with a fresh SSH key that its allowed-signers
/// file trusts, plus a second key that file doesn't list. `None` (skip) when
/// ssh-keygen isn't available.
fn ssh_signing_repo() -> Option<(FixtureRepo, tempfile::TempDir, PathBuf)> {
    let keys = tempfile::TempDir::new().unwrap();
    let Some(trusted) = ssh_key(keys.path(), "trusted") else {
        eprintln!("ssh-keygen not available; skipping");
        return None;
    };
    let stranger = ssh_key(keys.path(), "stranger")?;
    let pubkey = std::fs::read_to_string(trusted.with_extension("pub")).unwrap();
    let allowed = keys.path().join("allowed_signers");
    std::fs::write(&allowed, format!("author@example.com {pubkey}")).unwrap();

    let fx = FixtureRepo::init();
    set(&fx, "gpg.format", "ssh");
    set(&fx, "user.signingkey", trusted.to_str().unwrap());
    set(&fx, "gpg.ssh.allowedSignersFile", allowed.to_str().unwrap());
    fx.commit_file("a.txt", "one\n", "c1");
    Some((fx, keys, stranger))
}

fn git(fx: &FixtureRepo, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(fx.path())
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
}

#[test]
fn an_unsigned_commit_has_no_signature() {
    let fx = FixtureRepo::init();
    let c = fx.commit_file("a.txt", "one\n", "c1");
    let repo = Repo::open(fx.path()).unwrap();

    assert!(repo.commit_signature(&c.to_string()).unwrap().is_none());
}

#[test]
fn a_commit_signed_by_a_trusted_key_verifies_as_good() {
    let Some((fx, _keys, _)) = ssh_signing_repo() else {
        return;
    };
    git(
        &fx,
        &["commit", "-q", "--allow-empty", "-S", "-m", "signed"],
    );
    let repo = Repo::open(fx.path()).unwrap();

    let sig = repo.commit_signature("HEAD").unwrap().expect("signed");
    assert_eq!(sig.status, SignatureStatus::Good);
    assert_eq!(sig.signer, "author@example.com");
    assert!(
        sig.key.starts_with("SHA256:"),
        "key fingerprint: {}",
        sig.key
    );
}

#[test]
fn a_commit_signed_by_a_key_not_in_allowed_signers_is_unknown() {
    let Some((fx, _keys, stranger)) = ssh_signing_repo() else {
        return;
    };
    let key = format!("user.signingkey={}", stranger.display());
    git(
        &fx,
        &["-c", &key, "commit", "-q", "--allow-empty", "-S", "-m", "x"],
    );
    let repo = Repo::open(fx.path()).unwrap();

    let sig = repo.commit_signature("HEAD").unwrap().expect("signed");
    assert_eq!(sig.status, SignatureStatus::UnknownKey);
}

#[test]
fn a_signature_git_cannot_check_is_reported_as_unverifiable() {
    let Some((fx, _keys, _)) = ssh_signing_repo() else {
        return;
    };
    git(
        &fx,
        &["commit", "-q", "--allow-empty", "-S", "-m", "signed"],
    );
    // No allowed-signers file: git can't even start verifying an SSH signature.
    fx.repo
        .config()
        .unwrap()
        .remove("gpg.ssh.allowedSignersFile")
        .unwrap();
    let repo = Repo::open(fx.path()).unwrap();

    let sig = repo.commit_signature("HEAD").unwrap().expect("signed");
    assert_eq!(sig.status, SignatureStatus::Unverifiable);
    assert!(!sig.detail.is_empty(), "carries git's reason");
}

#[test]
fn committing_with_sign_on_makes_a_good_signature() {
    let Some((fx, _keys, _)) = ssh_signing_repo() else {
        return;
    };
    std::fs::write(fx.path().join("a.txt"), "two\n").unwrap();
    let repo = Repo::open(fx.path()).unwrap();
    repo.stage_all().unwrap();

    repo.commit("signed", "", false, Some(true), false).unwrap();

    let sig = repo.commit_signature("HEAD").unwrap().expect("signed");
    assert_eq!(sig.status, SignatureStatus::Good);
}

#[test]
fn committing_with_sign_off_overrides_commit_gpgsign() {
    let Some((fx, _keys, _)) = ssh_signing_repo() else {
        return;
    };
    set(&fx, "commit.gpgsign", "true");
    let repo = Repo::open(fx.path()).unwrap();

    repo.commit("unsigned", "", true, Some(false), false)
        .unwrap();
    assert!(repo.commit_signature("HEAD").unwrap().is_none());

    // No explicit choice: git's own config applies, as before.
    repo.commit("signed", "", true, None, false).unwrap();
    assert!(repo.commit_signature("HEAD").unwrap().is_some());
}

#[test]
fn signing_config_reports_the_default_and_whether_a_key_is_set() {
    let fx = FixtureRepo::init();
    // Pin everything locally so the user's global config can't leak in.
    set(&fx, "user.signingkey", "");
    set(&fx, "gpg.format", "openpgp");
    set(&fx, "commit.gpgsign", "false");
    let repo = Repo::open(fx.path()).unwrap();
    let cfg = repo.signing_config().unwrap();
    assert!(!cfg.can_sign && !cfg.sign_by_default);

    set(&fx, "user.signingkey", "ABCDEF0123456789");
    set(&fx, "commit.gpgsign", "true");
    let repo = Repo::open(fx.path()).unwrap();
    let cfg = repo.signing_config().unwrap();
    assert!(cfg.can_sign && cfg.sign_by_default);
}

#[test]
fn a_missing_verifier_program_is_reported_as_unverifiable() {
    let Some((fx, _keys, _)) = ssh_signing_repo() else {
        return;
    };
    git(
        &fx,
        &["commit", "-q", "--allow-empty", "-S", "-m", "signed"],
    );
    set(&fx, "gpg.ssh.program", "/nonexistent/ssh-keygen");
    let repo = Repo::open(fx.path()).unwrap();

    let sig = repo.commit_signature("HEAD").unwrap().expect("signed");
    assert_eq!(sig.status, SignatureStatus::Unverifiable);
}
