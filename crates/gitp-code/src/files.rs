//! The files of a working tree, as the explorer, quick open, the index and
//! the search see them: gitignore honoured, `.git` skipped, dotfiles shown.

use std::path::Path;

use serde::Serialize;

use crate::lang::Lang;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileEntry {
    /// Repository-relative, `/`-separated.
    pub path: String,
    pub size: u64,
    pub lang: Option<Lang>,
    /// Last modification, milliseconds since the epoch.
    pub mtime_ms: u64,
}

/// Every file under `root` that git would not ignore, sorted by path.
pub fn walk(root: &Path) -> Result<Vec<FileEntry>, String> {
    let mut files = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // gone between listing and stat
        };
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        files.push(FileEntry {
            lang: Lang::from_path(&rel),
            path: rel,
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// A file's modification time in milliseconds since the epoch; 0 when the
/// platform doesn't say.
pub fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::create_dir_all(root.join(".github")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
        std::fs::write(root.join("src/a.java"), "class A {}").unwrap();
        std::fs::write(root.join("build/x.class"), "x").unwrap();
        std::fs::write(root.join("run.log"), "x").unwrap();
        std::fs::write(root.join(".github/ci.yml"), "x").unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        dir
    }

    #[test]
    fn lists_files_and_skips_gitignored_and_dot_git() {
        let dir = tree();
        let paths: Vec<String> = walk(dir.path()).unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(paths, vec![".github/ci.yml", ".gitignore", "src/a.java"]);
    }

    #[test]
    fn tags_language_and_size() {
        let dir = tree();
        let files = walk(dir.path()).unwrap();
        let java = files.iter().find(|f| f.path == "src/a.java").unwrap();
        assert_eq!(java.lang, Some(Lang::Java));
        assert_eq!(java.size, 10);
        assert!(java.mtime_ms > 0);
        let ignore = files.iter().find(|f| f.path == ".gitignore").unwrap();
        assert_eq!(ignore.lang, None);
    }

    #[test]
    fn lang_from_path_covers_the_four_languages() {
        assert_eq!(Lang::from_path("x.tsx"), Some(Lang::Tsx));
        assert_eq!(Lang::from_path("x.mjs"), Some(Lang::JavaScript));
        assert_eq!(Lang::from_path("a/b.ts"), Some(Lang::TypeScript));
        assert_eq!(Lang::from_path("x.pyi"), Some(Lang::Python));
        assert_eq!(Lang::from_path("x.rs"), None);
        assert_eq!(Lang::from_path("Makefile"), None);
    }
}
