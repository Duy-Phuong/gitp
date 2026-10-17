//! Commit signatures: whether a commit's GPG / SSH / X.509 signature verifies,
//! and whether (and by default) new commits can be signed.
//!
//! Verification shells out to `git log --format=%G?…` rather than reading the
//! signature with libgit2: git runs the right program for the signature type
//! (`gpg`, `ssh-keygen` with `gpg.ssh.allowedSignersFile`, `gpgsm`) with the
//! user's own config and keyring, which is what `git log --show-signature`
//! in a terminal would say. Signing happens in `Repo::commit`, which already
//! goes through `git commit`.

use std::process::Command;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// How a signed commit's signature checks out — git's `%G?`, folded into the
/// cases the detail pane distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SignatureStatus {
    /// A good signature from a trusted key (`G`).
    Good,
    /// The signature does not match the commit (`B`).
    Bad,
    /// A good signature from a key that isn't trusted (`U`: not in the GPG
    /// trust web / the SSH allowed-signers file), or whose public key is
    /// missing so it can't be checked (`E`).
    UnknownKey,
    /// A good signature that has expired, or was made by an expired key
    /// (`X`, `Y`).
    Expired,
    /// A good signature made by a revoked key (`R`).
    Revoked,
    /// Git couldn't check it at all: the signing program (`gpg`, `ssh-keygen`)
    /// isn't installed / on PATH, or SSH verification isn't configured.
    Unverifiable,
}

/// A commit's signature and what verifying it said.
#[derive(Debug, Clone, Serialize)]
pub struct CommitSignature {
    pub status: SignatureStatus,
    /// Who signed it (`%GS`): the GPG user id, or the SSH allowed-signers
    /// principal. Empty when git couldn't tell.
    pub signer: String,
    /// The signing key's fingerprint (`%GF`), or its id (`%GK`) when there's
    /// no fingerprint. Empty when git couldn't tell.
    pub key: String,
    /// Git's message when verification didn't produce a verdict — why the
    /// signature is `Unverifiable`. Empty otherwise.
    pub detail: String,
}

/// Whether the commit box can sign, and what it should default to.
#[derive(Debug, Clone, Serialize)]
pub struct SigningConfig {
    /// A signing key is configured (`user.signingkey`, or an SSH
    /// `gpg.ssh.defaultKeyCommand`), or signing is already on by config.
    pub can_sign: bool,
    /// The effective `commit.gpgsign`: what `git commit` does with no flag.
    pub sign_by_default: bool,
}

impl Repo {
    /// The signature on the commit named by `rev`, verified; `None` when it
    /// isn't signed. Unsigned commits never run git — the check is a libgit2
    /// header read — so only signed ones pay for running the verifier.
    pub fn commit_signature(&self, rev: &str) -> Result<Option<CommitSignature>> {
        let oid = self.inner.revparse_single(rev)?.peel_to_commit()?.id();
        match self.inner.extract_signature(&oid, None) {
            Ok(_) => {}
            Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }

        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;
        // `--no-show-signature`: a `log.showSignature = true` would otherwise
        // print the verifier's own report into stdout ahead of the format.
        // LC_ALL=C keeps git's error text matchable below.
        let output = Command::new("git")
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .args(["log", "-1", "--no-show-signature"])
            .arg("--format=%G?%x00%GS%x00%GK%x00%GF")
            .arg(oid.to_string())
            .output()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() {
            return Err(Error::Message(stderr));
        }

        let mut fields = stdout.trim_end_matches('\n').split('\0');
        let mut next = || fields.next().unwrap_or("").to_string();
        let (code, signer, key_id, fingerprint) = (next(), next(), next(), next());
        // A missing program shows up as `N` (gpg) or `B` (ssh-keygen) with a
        // "cannot run" / "cannot exec" error; SSH without an allowed-signers
        // file is `N` too. We know the commit *is* signed, so any of these
        // means "couldn't check", not "unsigned" or "forged".
        let program_missing = stderr.contains("cannot run") || stderr.contains("cannot exec");
        let status = match code.as_str() {
            _ if program_missing => SignatureStatus::Unverifiable,
            "G" => SignatureStatus::Good,
            "B" => SignatureStatus::Bad,
            "U" | "E" => SignatureStatus::UnknownKey,
            "X" | "Y" => SignatureStatus::Expired,
            "R" => SignatureStatus::Revoked,
            _ => SignatureStatus::Unverifiable,
        };
        let detail = if status == SignatureStatus::Unverifiable {
            stderr
        } else {
            String::new()
        };
        Ok(Some(CommitSignature {
            status,
            signer,
            key: if fingerprint.is_empty() {
                key_id
            } else {
                fingerprint
            },
            detail,
        }))
    }

    /// The effective signing setup, for the commit box's Sign toggle.
    pub fn signing_config(&self) -> Result<SigningConfig> {
        let cfg = self.inner.config()?.snapshot()?;
        let set = |name: &str| cfg.get_str(name).is_ok_and(|v| !v.trim().is_empty());
        let sign_by_default = cfg.get_bool("commit.gpgsign").unwrap_or(false);
        // Without user.signingkey, SSH signing can still get a key from
        // gpg.ssh.defaultKeyCommand (typically "the first key in ssh-agent").
        let ssh = cfg.get_str("gpg.format").is_ok_and(|f| f == "ssh");
        let has_key = set("user.signingkey") || (ssh && set("gpg.ssh.defaultKeyCommand"));
        Ok(SigningConfig {
            // commit.gpgsign already on means signing works for this user
            // (e.g. gpg picking the key from the committer email), so offer
            // the toggle — if only to turn it off for one commit.
            can_sign: has_key || sign_by_default,
            sign_by_default,
        })
    }
}
