//! Settings: the repository's git config, and the user's dotfiles.

use std::path::Path;

use gitp_core::{ConfigEntry, ConfigScope, Identity};
use serde::Deserialize;
use tauri::State;

use crate::state::{to_message, with_repo, RepoState};
use crate::template;

fn get_config_impl(state: &RepoState) -> Result<Vec<ConfigEntry>, String> {
    with_repo(state, |repo| repo.read_config())
}

fn set_config_impl(
    state: &RepoState,
    scope: ConfigScope,
    name: String,
    value: String,
) -> Result<(), String> {
    with_repo(state, |repo| repo.set_config(scope, &name, &value))
}

fn unset_config_impl(state: &RepoState, scope: ConfigScope, name: String) -> Result<(), String> {
    with_repo(state, |repo| repo.unset_config(scope, &name))
}

// --- Profile identity (user.name / user.email / user.signingkey) -----------
// The local side writes the active repo; the global side needs no open repo:
// the first-run "Default" profile is read from it, and a profile switch can
// write it with every tab closed.

fn apply_local_identity_impl(state: &RepoState, identity: Identity) -> Result<bool, String> {
    with_repo(state, |repo| repo.apply_local_identity(&identity))
}

// --- User dotfiles (~/.gitconfig, ~/.tigrc) ---------------------------------
// Deliberately scoped to exactly these two named files, resolved server-side
// from $HOME — the frontend picks a `DotfileKind`, never a path. A generic
// "read/write any path" command would let any webview code touch arbitrary
// files on disk; this doesn't need that power, so it doesn't have it. No repo
// needs to be open: these aren't repo-scoped.

/// One of the two dotfiles the Settings "Dotfiles" panel edits.
#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) enum DotfileKind {
    GitConfig,
    Tigrc,
}

impl DotfileKind {
    fn file_name(self) -> &'static str {
        match self {
            DotfileKind::GitConfig => ".gitconfig",
            DotfileKind::Tigrc => ".tigrc",
        }
    }
}

fn dotfile_path(kind: DotfileKind) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(Path::new(&home).join(kind.file_name()))
}

/// The file's current content, or an empty string if it doesn't exist yet
/// (Save will create it).
fn read_dotfile_impl(kind: DotfileKind) -> Result<String, String> {
    match std::fs::read_to_string(dotfile_path(kind)?) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Overwrite the file with `content` verbatim — no syntax validation, no
/// backup. The frontend confirms with the user before calling this.
fn write_dotfile_impl(kind: DotfileKind, content: String) -> Result<(), String> {
    std::fs::write(dotfile_path(kind)?, content).map_err(|e| e.to_string())
}

// --- Config templates (export / apply ~/.gitconfig + ~/.tigrc) --------------
// The frontend picks the file with the native save/open dialog (same
// plugin-dialog route as "Browse…"), and only that path crosses IPC; the home
// side is always resolved here from $HOME, so the webview can't point apply
// at an arbitrary directory. Logic lives in `template.rs` on an explicit home
// path so it's testable against a tempdir.

fn home_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(std::path::PathBuf::from(home))
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn get_config(state: State<RepoState>) -> Result<Vec<ConfigEntry>, String> {
    get_config_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn set_config(
    scope: ConfigScope,
    name: String,
    value: String,
    state: State<RepoState>,
) -> Result<(), String> {
    set_config_impl(&state, scope, name, value)
}

#[tauri::command(async)]
pub(crate) fn unset_config(
    scope: ConfigScope,
    name: String,
    state: State<RepoState>,
) -> Result<(), String> {
    unset_config_impl(&state, scope, name)
}

#[tauri::command(async)]
pub(crate) fn get_global_identity() -> Result<Identity, String> {
    gitp_core::global_identity().map_err(to_message)
}

#[tauri::command(async)]
pub(crate) fn set_global_identity(identity: Identity) -> Result<(), String> {
    gitp_core::set_global_identity(&identity).map_err(to_message)
}

/// Write the profile's identity into the active repo's local config; true when
/// it wasn't already there.
#[tauri::command(async)]
pub(crate) fn apply_local_identity(
    identity: Identity,
    state: State<RepoState>,
) -> Result<bool, String> {
    apply_local_identity_impl(&state, identity)
}

#[tauri::command(async)]
pub(crate) fn read_dotfile(kind: DotfileKind) -> Result<String, String> {
    read_dotfile_impl(kind)
}

#[tauri::command(async)]
pub(crate) fn write_dotfile(kind: DotfileKind, content: String) -> Result<(), String> {
    write_dotfile_impl(kind, content)
}

/// Write a version-1 template of the current dotfiles to `dest`.
#[tauri::command(async)]
pub(crate) fn export_config_template(dest: String) -> Result<(), String> {
    template::export_to_file(&home_dir()?, Path::new(&dest), std::time::SystemTime::now())
}

/// Apply the template at `src` to $HOME, backing up whatever it overwrites.
#[tauri::command(async)]
pub(crate) fn apply_config_template(src: String) -> Result<template::ApplyTemplateResult, String> {
    template::apply_from_file(&home_dir()?, Path::new(&src), std::time::SystemTime::now())
}
