//! Working-tree files for the in-app editor: read one as text, write it back
//! with the line breaks it had, create a new file, delete one, and list the
//! files there are to pick from.
//!
//! The paths come from the frontend — a status row, a picker, or what the user
//! typed into "Create File" — so each is checked to be a plain path inside the
//! working tree before anything touches the disk.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::repo::Repo;

/// Files bigger than this aren't opened: a `<textarea>` holding megabytes of
/// text is slow to the point of looking hung, and such a file is rarely one to
/// edit by hand.
pub const EDIT_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// A text file as the editor holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextFile {
    /// The content with every line break as `\n` — what a `<textarea>` keeps
    /// anyway, whatever it is given.
    pub text: String,
    /// The file's line breaks are `\r\n` (most of them, when `mixed`). Saving
    /// writes them back that way.
    pub crlf: bool,
    /// The line breaks aren't all one kind (or some are a lone `\r`), so saving
    /// can't reproduce them exactly: they all become the `crlf` kind.
    pub mixed: bool,
}

impl Repo {
    /// `path` as text, or `None` when it doesn't exist. Refuses a file over
    /// [`EDIT_MAX_BYTES`], a binary one, and one that isn't valid text in the
    /// repo's encoding (see `encoding.rs`).
    pub fn read_text_file(&self, path: &str) -> Result<Option<TextFile>> {
        let full = self.edit_path(path)?;
        let meta = match fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::Message(format!("can't read {path}: {e}"))),
        };
        regular_file(path, &meta)?;
        if meta.len() > EDIT_MAX_BYTES {
            return Err(Error::Message(format!(
                "{path} is too large to edit here ({:.1} MB; the limit is {} MB)",
                meta.len() as f64 / (1024.0 * 1024.0),
                EDIT_MAX_BYTES / (1024 * 1024)
            )));
        }
        let bytes =
            fs::read(&full).map_err(|e| Error::Message(format!("can't read {path}: {e}")))?;
        let enc = self.text_encoding();
        // git's own test for binary: a NUL byte in the first 8000.
        if enc.nul_means_binary() && bytes.iter().take(8000).any(|&b| b == 0) {
            return Err(Error::Message(format!("{path} is a binary file")));
        }
        let raw = enc
            .decode(&bytes)
            .ok_or_else(|| Error::Message(format!("{path} isn't {} text", enc.name())))?;
        Ok(Some(split_line_breaks(&raw)))
    }

    /// Write `text` (line breaks as `\n`) to `path`, turning them into `\r\n`
    /// when `crlf`, in the repo's encoding. Creates the file when it's
    /// missing, but not its folder. Refuses text with a character the
    /// encoding can't hold, rather than writing it some other way.
    pub fn write_text_file(&self, path: &str, text: &str, crlf: bool) -> Result<()> {
        let full = self.edit_path(path)?;
        if let Ok(meta) = fs::symlink_metadata(&full) {
            regular_file(path, &meta)?;
        }
        let enc = self.text_encoding();
        let text = join_line_breaks(text, crlf);
        let bytes = enc.encode(&text).ok_or_else(|| {
            Error::Message(format!(
                "{path} has characters that {} can't represent, so it wasn't saved",
                enc.name()
            ))
        })?;
        fs::write(&full, bytes).map_err(|e| Error::Message(format!("can't write {path}: {e}")))
    }

    /// Create `path` as an empty file, with any folders it needs. Refuses one
    /// that already exists.
    pub fn create_file(&self, path: &str) -> Result<()> {
        let full = self.edit_path(path)?;
        if fs::symlink_metadata(&full).is_ok() {
            return Err(Error::Message(format!("{path} already exists")));
        }
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| Error::Message(format!("can't create the folder for {path}: {e}")))?;
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)
            .map(|_| ())
            .map_err(|e| Error::Message(format!("can't create {path}: {e}")))
    }

    /// Delete the file `path` from the working tree. The index is left alone,
    /// so a tracked file shows up as deleted, ready to stage.
    pub fn delete_file(&self, path: &str) -> Result<()> {
        let full = self.edit_path(path)?;
        let meta = fs::symlink_metadata(&full)
            .map_err(|e| Error::Message(format!("can't delete {path}: {e}")))?;
        regular_file(path, &meta)?;
        fs::remove_file(&full).map_err(|e| Error::Message(format!("can't delete {path}: {e}")))
    }

    /// Every file in the working tree that isn't ignored — the tracked ones
    /// and the untracked ones — sorted.
    pub fn list_work_files(&self) -> Result<Vec<String>> {
        let raw = self.run_git_raw(&[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])?;
        let mut files: Vec<String> = raw
            .split(|&b| b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        files.sort();
        // A conflicted file is listed once per stage.
        files.dedup();
        Ok(files)
    }

    /// The absolute path of the repo-relative `path`, refusing anything that
    /// could land outside the working tree: an absolute path or `..` (which
    /// `Path::join` would follow), a folder on the way that is a symlink to
    /// somewhere else, and git's own `.git` — a hook written there would run.
    fn edit_path(&self, path: &str) -> Result<PathBuf> {
        let outside = || Error::Message(format!("not a path inside the repository: {path}"));
        let rel = Path::new(path);
        let plain = !rel.as_os_str().is_empty()
            && rel
                .components()
                .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
        let in_git_dir = rel
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"));
        if !plain || in_git_dir || rel.file_name().is_none() {
            return Err(outside());
        }
        let workdir = self.workdir_path()?;
        let full = workdir.join(rel);
        // What exists of the folders on the way must resolve inside the
        // working tree; anything missing below that is created as a real
        // folder by `create_file`.
        let root = workdir
            .canonicalize()
            .map_err(|e| Error::Message(format!("can't resolve the working tree: {e}")))?;
        let existing = full
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .find(|a| fs::symlink_metadata(a).is_ok())
            .ok_or_else(outside)?;
        match existing.canonicalize() {
            Ok(real) if real.starts_with(&root) => Ok(full),
            _ => Err(outside()),
        }
    }
}

/// Refuse what isn't a regular file: a symlink's content in git is its
/// target's name, and following it could reach outside the repository.
fn regular_file(path: &str, meta: &fs::Metadata) -> Result<()> {
    if meta.is_file() {
        Ok(())
    } else {
        Err(Error::Message(format!("{path} is not a regular file")))
    }
}

/// `raw` with its line breaks as `\n`, and which kind it had.
fn split_line_breaks(raw: &str) -> TextFile {
    let crlf = raw.matches("\r\n").count();
    let lf = raw.matches('\n').count() - crlf;
    let cr = raw.matches('\r').count() - crlf;
    TextFile {
        text: raw.replace("\r\n", "\n").replace('\r', "\n"),
        crlf: crlf > lf + cr,
        mixed: (crlf > 0 && lf > 0) || cr > 0,
    }
}

/// `text` with its line breaks as `\r\n` when `crlf`, else `\n`. Whatever
/// `\r` it carries is folded in first, so a stray one can't double up.
fn join_line_breaks(text: &str, crlf: bool) -> String {
    let lf = text.replace("\r\n", "\n").replace('\r', "\n");
    if crlf {
        lf.replace('\n', "\r\n")
    } else {
        lf
    }
}
