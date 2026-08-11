//! Reading and editing git config, with per-entry scope provenance.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::repo::Repo;

/// Which config file a value comes from / is written to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigScope {
    /// The repository's `.git/config`.
    Local,
    /// The user's global config (`~/.gitconfig` or XDG).
    Global,
    /// System-wide config (`/etc/gitconfig`).
    System,
    /// Any other level (program data, app-specific, …).
    Other,
}

impl From<git2::ConfigLevel> for ConfigScope {
    fn from(level: git2::ConfigLevel) -> Self {
        match level {
            git2::ConfigLevel::Local => ConfigScope::Local,
            git2::ConfigLevel::Global | git2::ConfigLevel::XDG => ConfigScope::Global,
            git2::ConfigLevel::System | git2::ConfigLevel::ProgramData => ConfigScope::System,
            _ => ConfigScope::Other,
        }
    }
}

impl ConfigScope {
    fn to_level(self) -> Option<git2::ConfigLevel> {
        match self {
            ConfigScope::Local => Some(git2::ConfigLevel::Local),
            ConfigScope::Global => Some(git2::ConfigLevel::Global),
            ConfigScope::System => Some(git2::ConfigLevel::System),
            ConfigScope::Other => None,
        }
    }
}

/// A single `name = value` config entry, tagged with where it came from.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigEntry {
    pub name: String,
    pub value: String,
    pub scope: ConfigScope,
}

impl Repo {
    /// Read the effective config (all levels merged), each entry tagged with the
    /// scope it originated from.
    pub fn read_config(&self) -> Result<Vec<ConfigEntry>> {
        let cfg = self.inner.config()?;
        let mut out = Vec::new();

        let entries = cfg.entries(None)?;
        entries.for_each(|entry| {
            out.push(ConfigEntry {
                name: entry.name().unwrap_or("").to_string(),
                value: entry.value().unwrap_or("").to_string(),
                scope: entry.level().into(),
            });
        })?;

        Ok(out)
    }

    /// Set `name = value` in the config file for `scope`. Creates the key if it
    /// doesn't exist, replaces it if it does.
    pub fn set_config(&self, scope: ConfigScope, name: &str, value: &str) -> Result<()> {
        let level = scope
            .to_level()
            .ok_or_else(|| git2::Error::from_str("cannot write to this config scope"))?;
        let cfg = self.inner.config()?;
        let mut leveled = cfg.open_level(level)?;
        leveled.set_str(name, value)?;
        Ok(())
    }
}
