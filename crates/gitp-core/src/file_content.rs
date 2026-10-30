//! One side of a changed file as raw bytes — a revision's version, the
//! index's, or the working tree's — for what a text diff can't show (images).

use std::fs;
use std::path::{Component, Path};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::repo::Repo;

/// Where to read a file from.
#[derive(Debug, Clone, Deserialize)]
pub enum FileSide {
    /// The file in a revision's tree — any rev git understands (`abc123^`).
    Rev(String),
    /// The staged version.
    Index,
    /// The file on disk.
    WorkTree,
}

/// A file's content, base64-encoded for the frontend — or only its size, when
/// that is over the caller's cap.
#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub size: u64,
    /// `None` when `size` is over the cap.
    pub base64: Option<String>,
}

/// The cap for previews: base64 grows a file by a third, and the webview then
/// holds it as a `data:` URL.
pub const PREVIEW_MAX_BYTES: u64 = 10 * 1024 * 1024;

impl Repo {
    /// `path` as it is on `side`, or `None` when it doesn't exist there.
    /// Content over `max_bytes` isn't read, only its size reported.
    pub fn file_content(
        &self,
        side: &FileSide,
        path: &str,
        max_bytes: u64,
    ) -> Result<Option<FileContent>> {
        let id = match side {
            FileSide::WorkTree => return self.workfile_content(path, max_bytes),
            FileSide::Index => {
                // Reload: staging runs the `git` CLI, behind git2's cached index.
                let mut index = self.inner.index()?;
                index.read(true)?;
                match index.get_path(Path::new(path), 0) {
                    Some(entry) => entry.id,
                    None => return Ok(None),
                }
            }
            FileSide::Rev(rev) => {
                let tree = self.inner.revparse_single(rev)?.peel_to_tree()?;
                match tree.get_path(Path::new(path)) {
                    Ok(entry) => entry.id(),
                    Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
                    Err(e) => return Err(e.into()),
                }
            }
        };
        // The header gives the size without inflating the object.
        let (size, _) = self.inner.odb()?.read_header(id)?;
        let size = size as u64;
        if size > max_bytes {
            return Ok(Some(FileContent { size, base64: None }));
        }
        Ok(Some(encode(self.inner.find_blob(id)?.content())))
    }

    fn workfile_content(&self, path: &str, max_bytes: u64) -> Result<Option<FileContent>> {
        // Only a plain relative path: `..` or an absolute path would read
        // outside the working tree.
        let rel = Path::new(path);
        if rel.as_os_str().is_empty()
            || !rel
                .components()
                .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(Error::Message(format!("not a path inside the repository: {path}")));
        }
        let full = self.workdir_path()?.join(rel);
        let meta = match fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::Message(format!("can't read {path}: {e}"))),
        };
        // git stores a symlink as its target's name, not the target's content —
        // and following it could read a file outside the repository.
        if !meta.is_file() {
            return Err(Error::Message(format!("{path} is not a regular file")));
        }
        if meta.len() > max_bytes {
            return Ok(Some(FileContent {
                size: meta.len(),
                base64: None,
            }));
        }
        let bytes = fs::read(&full).map_err(|e| Error::Message(format!("can't read {path}: {e}")))?;
        Ok(Some(encode(&bytes)))
    }
}

fn encode(bytes: &[u8]) -> FileContent {
    FileContent {
        size: bytes.len() as u64,
        base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
    }
}
