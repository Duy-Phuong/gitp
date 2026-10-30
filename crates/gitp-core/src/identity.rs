//! The commit identity a gitp profile carries: `user.name`, `user.email`, an
//! optional `user.signingkey` and the optional `gpg.format` it is used with.
//!
//! gitp commits (and merges, reverts, cherry-picks…) by running `git`, which
//! takes the author from git's config. So a profile's identity is applied by
//! writing it there — into the user's global config or into one repository's
//! local config — rather than by passing an author to each command.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::repo::Repo;

const NAME: &str = "user.name";
const EMAIL: &str = "user.email";
const SIGNING_KEY: &str = "user.signingkey";
const SIGNING_FORMAT: &str = "gpg.format";

/// Who commits are made as. An empty field is an unset key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub name: String,
    pub email: String,
    /// Empty when the profile signs with nothing of its own: applying it then
    /// removes `user.signingkey`, so the previous profile's key isn't used.
    pub signing_key: String,
    /// `openpgp`, `ssh` or `x509`, or empty for git's default (openpgp) —
    /// applying an empty one removes `gpg.format`, like the key.
    pub signing_format: String,
}

/// The identity git uses outside any repository: global config, falling back
/// to system config, as `git config user.name` would answer it.
pub fn global_identity() -> Result<Identity> {
    read_identity(&git2::Config::open_default()?)
}

/// Write `id` into the user's global config (`~/.gitconfig`, created if
/// missing).
pub fn set_global_identity(id: &Identity) -> Result<()> {
    write_identity(&mut git2::Config::open(&global_config_path()?)?, id)
}

/// The file `git config --global` writes to: the existing global config
/// (`~/.gitconfig` or the XDG one), else a new `~/.gitconfig`.
fn global_config_path() -> Result<PathBuf> {
    if let Ok(path) = git2::Config::find_global().or_else(|_| git2::Config::find_xdg()) {
        return Ok(path);
    }
    let home = std::env::var_os("HOME").ok_or_else(|| Error::Message("HOME is not set".into()))?;
    Ok(PathBuf::from(home).join(".gitconfig"))
}

impl Repo {
    /// Write `id` into this repository's local config, so commits here use it
    /// whatever the global config says. Returns whether anything changed — a
    /// repo that already has it is left untouched (no rewrite of
    /// `.git/config` each time its tab is opened).
    pub fn apply_local_identity(&self, id: &Identity) -> Result<bool> {
        let mut local = self.inner.config()?.open_level(git2::ConfigLevel::Local)?;
        if read_identity(&local)? == *id {
            return Ok(false);
        }
        write_identity(&mut local, id)?;
        Ok(true)
    }
}

fn read_identity(cfg: &git2::Config) -> Result<Identity> {
    let get = |name: &str| match cfg.get_string(name) {
        Ok(v) => Ok(v),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(String::new()),
        Err(e) => Err(e),
    };
    Ok(Identity {
        name: get(NAME)?,
        email: get(EMAIL)?,
        signing_key: get(SIGNING_KEY)?,
        signing_format: get(SIGNING_FORMAT)?,
    })
}

fn write_identity(cfg: &mut git2::Config, id: &Identity) -> Result<()> {
    cfg.set_str(NAME, &id.name)?;
    cfg.set_str(EMAIL, &id.email)?;
    set_or_remove(cfg, SIGNING_KEY, &id.signing_key)?;
    set_or_remove(cfg, SIGNING_FORMAT, &id.signing_format)
}

/// Set `name` to `value`, or remove it when `value` is empty.
fn set_or_remove(cfg: &mut git2::Config, name: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        match cfg.remove(name) {
            Err(e) if e.code() != git2::ErrorCode::NotFound => return Err(e.into()),
            _ => {}
        }
    } else {
        cfg.set_str(name, value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(name: &str, email: &str, key: &str) -> Identity {
        Identity {
            name: name.into(),
            email: email.into(),
            signing_key: key.into(),
            signing_format: String::new(),
        }
    }

    #[test]
    fn writes_an_identity_into_a_config_file_that_did_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gitconfig");
        let id = Identity {
            signing_format: "ssh".into(),
            ..identity("Ada", "ada@example.com", "~/.ssh/id.pub")
        };

        write_identity(&mut git2::Config::open(&path).unwrap(), &id).unwrap();

        assert_eq!(
            read_identity(&git2::Config::open(&path).unwrap()).unwrap(),
            id
        );
    }

    #[test]
    fn a_profile_without_a_signing_key_removes_the_previous_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gitconfig");
        let mut cfg = git2::Config::open(&path).unwrap();
        let work = Identity {
            signing_format: "x509".into(),
            ..identity("Ada", "ada@work.com", "WORKKEY")
        };
        write_identity(&mut cfg, &work).unwrap();

        let home = identity("Ada", "ada@home.org", "");
        write_identity(&mut cfg, &home).unwrap();

        assert_eq!(
            read_identity(&git2::Config::open(&path).unwrap()).unwrap(),
            home
        );
        // Its format went with it, so git falls back to openpgp.
        assert!(git2::Config::open(&path)
            .unwrap()
            .get_string("gpg.format")
            .is_err());
    }
}
