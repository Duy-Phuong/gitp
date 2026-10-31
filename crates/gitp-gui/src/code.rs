//! The Code tab's commands: the workspace's files, the symbol index,
//! definition / usages / call hierarchy, reading and saving files, and
//! full-text search. One `CodeState` per open repository, made the first
//! time the tab opens there, so repositories never browsed cost nothing.
//!
//! Two errors the frontend matches by text: `indexing` (a navigation query
//! before the first index is built) and `changed_on_disk` (a save whose
//! expected mtime no longer matches the file).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use gitp_code::files::{walk, FileEntry};
use gitp_code::grep::{self, Query, SearchResult};
use gitp_code::lang::{Family, Lang};
use gitp_code::index::{reindex_many, RefKind, Reference, Range, Symbol, SymbolIndex, SymbolKind};
use gitp_code::resolve::{self, HierarchyNode, UsageHit};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{to_message, RepoState};

pub(crate) const INDEX_READY_EVENT: &str = "code-index-ready";
pub(crate) const FILES_CHANGED_EVENT: &str = "code-files-changed";

/// The cap on usages returned at once.
const USAGES_LIMIT: usize = 2000;

pub(crate) struct CodeState {
    pub(crate) index: Arc<RwLock<SymbolIndex>>,
    pub(crate) files: Arc<RwLock<Vec<FileEntry>>>,
    /// The first index has been built.
    pub(crate) ready: Arc<AtomicBool>,
    /// The first build is running (so a second open doesn't start another).
    indexing: Arc<AtomicBool>,
    /// Raised to stop the search in flight when a newer one starts.
    search_cancel: Mutex<Arc<AtomicBool>>,
    /// The mtime each file had right after the Code tab last saved it, so
    /// the watcher's echo of that write is not reported as an external change.
    pub(crate) own_writes: Mutex<HashMap<String, u64>>,
}

impl CodeState {
    fn new() -> Self {
        CodeState {
            index: Arc::new(RwLock::new(SymbolIndex::default())),
            files: Arc::new(RwLock::new(Vec::new())),
            ready: Arc::new(AtomicBool::new(false)),
            indexing: Arc::new(AtomicBool::new(false)),
            search_cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            own_writes: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct Workspace {
    files: Vec<FileEntry>,
    indexing: bool,
}

/// A file as the editor holds it, with the mtime a save must present.
#[derive(Serialize)]
pub(crate) struct CodeFile {
    text: String,
    crlf: bool,
    mixed: bool,
    mtime_ms: u64,
}

#[derive(Serialize, Debug)]
pub(crate) struct UsagesResult {
    symbol: Symbol,
    hits: Vec<UsageHit>,
    truncated: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct IndexReady {
    symbols: usize,
    files: usize,
    ms: u128,
}

/// What a batch of watcher changes did to the Code tab's view of the tree.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct FilesChanged {
    pub(crate) paths: Vec<String>,
    /// The subset not written by the Code tab itself.
    pub(crate) external: Vec<String>,
    /// The file list's patch: entries new or changed, and paths gone.
    pub(crate) entries: Vec<FileEntry>,
    pub(crate) removed: Vec<String>,
    /// Too many paths to patch: everything was rebuilt; fetch the list again.
    pub(crate) rebuilt: bool,
}

/// Something that takes an event name and payload: the app handle, or
/// nothing in tests.
pub(crate) type Emit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

#[cfg(test)]
fn no_emit() -> Emit {
    Arc::new(|_, _| {})
}

fn app_emit(app: &AppHandle) -> Emit {
    let app = app.clone();
    Arc::new(move |name, payload| {
        let _ = app.emit(name, payload);
    })
}

/// The active repository's `CodeState` (made now if it has none) and its
/// working directory.
pub(crate) fn code_state_or_init(state: &RepoState) -> Result<(Arc<CodeState>, PathBuf), String> {
    let mut guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &mut guard.sessions[idx];
    let root = session.repo.workdir_path().map_err(to_message)?;
    let code = session.code.get_or_insert_with(|| Arc::new(CodeState::new())).clone();
    Ok((code, root))
}

/// The active repository's `CodeState`, if the Code tab has opened there.
fn code_state(state: &RepoState) -> Result<(Arc<CodeState>, PathBuf), String> {
    let guard = state.workspace();
    let idx = guard.active.ok_or("no repository is open")?;
    let session = &guard.sessions[idx];
    let root = session.repo.workdir_path().map_err(to_message)?;
    let code = session.code.clone().ok_or("Code tab not open")?;
    Ok((code, root))
}

fn ready_index(state: &RepoState) -> Result<(Arc<CodeState>, PathBuf), String> {
    let (code, root) = code_state(state)?;
    if !code.ready.load(Ordering::SeqCst) {
        return Err("indexing".into());
    }
    Ok((code, root))
}

pub(crate) fn code_open_workspace_impl(state: &RepoState, emit: Emit) -> Result<Workspace, String> {
    let (code, root) = code_state_or_init(state)?;
    let files = walk(&root)?;
    *code.files.write().unwrap() = files.clone();
    if code.ready.load(Ordering::SeqCst) {
        // Back from another repository tab, whose watcher was not live: the
        // files that changed meanwhile are parsed again.
        refresh_stale(&code, &root, &files);
        return Ok(Workspace { files, indexing: false });
    }
    if code.indexing.swap(true, Ordering::SeqCst) {
        return Ok(Workspace { files, indexing: true }); // a build is on its way
    }
    let (index, ready, indexing, files_for_thread) = (code.index.clone(), code.ready.clone(), code.indexing.clone(), files.clone());
    std::thread::spawn(move || {
        let t = std::time::Instant::now();
        let built = SymbolIndex::build(&root, &files_for_thread);
        let symbols = built.symbol_count();
        *index.write().unwrap() = built;
        ready.store(true, Ordering::SeqCst);
        indexing.store(false, Ordering::SeqCst);
        // A file saved during the build may have been read before the save.
        if let Ok(files) = walk(&root) {
            let stale = index.read().unwrap().stale_files(&files);
            reindex_many(&index, &root, &stale);
        }
        let payload = IndexReady { symbols, files: files_for_thread.len(), ms: t.elapsed().as_millis() };
        emit(INDEX_READY_EVENT, serde_json::to_value(payload).unwrap_or_default());
    });
    Ok(Workspace { files, indexing: true })
}

/// Walk again and reindex what changed since: the repo tab was inactive, or
/// the Code tab just opened for a second time.
pub(crate) fn code_refresh_impl(state: &RepoState) -> Result<Vec<FileEntry>, String> {
    let (code, root) = code_state_or_init(state)?;
    let files = walk(&root)?;
    if code.ready.load(Ordering::SeqCst) {
        refresh_stale(&code, &root, &files);
    }
    *code.files.write().unwrap() = files.clone();
    Ok(files)
}

/// Parse again whatever changed since it was indexed, outside the lock.
fn refresh_stale(code: &CodeState, root: &Path, files: &[FileEntry]) {
    let stale = code.index.read().unwrap().stale_files(files);
    if !stale.is_empty() {
        reindex_many(&code.index, root, &stale);
    }
}

pub(crate) fn code_read_file_impl(state: &RepoState, path: String) -> Result<Option<CodeFile>, String> {
    let (_, root) = code_state_or_init(state)?;
    let text = crate::state::with_repo(state, |repo| repo.read_text_file(&path))?;
    let Some(text) = text else { return Ok(None) };
    let mtime_ms = std::fs::metadata(root.join(&path)).map(|m| gitp_code::files::mtime_ms(&m)).unwrap_or(0);
    Ok(Some(CodeFile { text: text.text, crlf: text.crlf, mixed: text.mixed, mtime_ms }))
}

/// Save `text` to `path` unless the file changed since it was read; the new
/// mtime is remembered as the Code tab's own write. No Undo entry: Local
/// History is the safety net for these.
pub(crate) fn code_write_file_impl(
    state: &RepoState,
    path: String,
    text: String,
    crlf: bool,
    expected_mtime_ms: u64,
) -> Result<u64, String> {
    let (code, root) = code_state_or_init(state)?;
    let full = root.join(&path);
    let on_disk = std::fs::metadata(&full).map(|m| gitp_code::files::mtime_ms(&m)).unwrap_or(0);
    if on_disk != expected_mtime_ms {
        return Err("changed_on_disk".into());
    }
    crate::state::with_repo(state, |repo| repo.write_text_file(&path, &text, crlf))?;
    let mtime = std::fs::metadata(&full).map(|m| gitp_code::files::mtime_ms(&m)).unwrap_or(0);
    code.own_writes.lock().unwrap().insert(path.clone(), mtime);
    if code.ready.load(Ordering::SeqCst) {
        reindex_many(&code.index, &root, std::slice::from_ref(&path));
    }
    Ok(mtime)
}

pub(crate) fn code_definition_impl(state: &RepoState, path: String, line: u32, col: u32) -> Result<Vec<Symbol>, String> {
    let (code, _) = ready_index(state)?;
    let index = code.index.read().unwrap();
    Ok(resolve::definition(&index, &path, line, col))
}

pub(crate) fn code_references_impl(state: &RepoState, path: String, line: u32, col: u32) -> Result<UsagesResult, String> {
    let (code, root) = ready_index(state)?;
    let symbol = {
        let index = code.index.read().unwrap();
        let symbol = resolve::symbol_at(&index, &path, line, col).ok_or("no_symbol")?;
        if !matches!(symbol.kind, SymbolKind::Variable | SymbolKind::Field) {
            let (hits, truncated) = resolve::references(&index, &symbol, USAGES_LIMIT);
            return Ok(UsagesResult { symbol, hits, truncated });
        }
        symbol
    };
    // Plain identifiers are not indexed (a 20k-file repo has millions): a
    // variable's or field's uses come from a whole-word grep over the same
    // language's files, and are never more than "possible".
    let query = Query {
        pattern: symbol.name.to_string(),
        regex: false,
        case_sensitive: true,
        whole_word: true,
        include_glob: Some(family_glob(symbol.lang.family()).to_string()),
    };
    let found = grep::search(&root, &query, USAGES_LIMIT + 1, Arc::new(AtomicBool::new(false)))?;
    let truncated = found.hits.len() > USAGES_LIMIT;
    let hits = found
        .hits
        .into_iter()
        .take(USAGES_LIMIT)
        .filter(|h| !(h.path == symbol.path.as_ref() && h.line == symbol.name_range.start_line && h.col == symbol.name_range.start_col))
        .map(|h| UsageHit {
            reference: Reference {
                name: symbol.name.clone(),
                kind: RefKind::Ident,
                path: Arc::from(h.path),
                range: Range { start_line: h.line, start_col: h.col, end_line: h.line, end_col: h.end_col, start_byte: 0, end_byte: 0 },
                enclosing: None,
                receiver: None,
            },
            certain: false,
        })
        .collect();
    Ok(UsagesResult { symbol, hits, truncated })
}

fn family_glob(family: Family) -> &'static str {
    match family {
        Family::Java => "*.java",
        Family::Js => "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}",
        Family::Python => "*.{py,pyi}",
    }
}

pub(crate) fn code_callers_impl(state: &RepoState, path: String, line: u32, col: u32) -> Result<Vec<HierarchyNode>, String> {
    let (code, _) = ready_index(state)?;
    let index = code.index.read().unwrap();
    let symbol = resolve::symbol_at(&index, &path, line, col).ok_or("no_symbol")?;
    Ok(resolve::callers(&index, &symbol, USAGES_LIMIT).0)
}

pub(crate) fn code_callees_impl(state: &RepoState, path: String, line: u32, col: u32) -> Result<Vec<HierarchyNode>, String> {
    let (code, _) = ready_index(state)?;
    let index = code.index.read().unwrap();
    let symbol = resolve::symbol_at(&index, &path, line, col).ok_or("no_symbol")?;
    Ok(resolve::callees(&index, &symbol))
}

pub(crate) fn code_file_symbols_impl(state: &RepoState, path: String) -> Result<Vec<Symbol>, String> {
    let (code, _) = ready_index(state)?;
    let index = code.index.read().unwrap();
    Ok(index.file_symbols(&path))
}

pub(crate) fn code_search_impl(state: &RepoState, query: Query, limit: usize) -> Result<SearchResult, String> {
    let (code, root) = code_state_or_init(state)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = code.search_cancel.lock().unwrap();
        slot.store(true, Ordering::Relaxed); // the one before, if still running
        *slot = cancel.clone();
    }
    grep::search(&root, &query, limit, cancel)
}

/// Apply a watcher batch: reindex or drop each path (or rebuild everything
/// past `overflow`), patch the file list, and tell the frontend which paths
/// moved and which of those were not its own saves.
pub(crate) fn on_worktree_changed(emit: &Emit, code: &CodeState, root: &Path, paths: &[String], overflow: bool) {
    if !code.ready.load(Ordering::SeqCst) {
        return; // the first build reads the tree as it is now
    }
    let external: Vec<String> = {
        let own = code.own_writes.lock().unwrap();
        paths
            .iter()
            .filter(|p| {
                let now = std::fs::metadata(root.join(p)).map(|m| gitp_code::files::mtime_ms(&m)).unwrap_or(0);
                own.get(*p) != Some(&now)
            })
            .cloned()
            .collect()
    };
    let mut entries = Vec::new();
    let mut removed = Vec::new();
    let mut removed_under: Vec<String> = Vec::new();
    if overflow {
        if let Ok(files) = walk(root) {
            let built = SymbolIndex::build(root, &files);
            *code.index.write().unwrap() = built;
            *code.files.write().unwrap() = files;
        }
    } else {
        // What each path is now: a file, a directory (notify reports a
        // renamed or moved directory by its path alone), or gone.
        for p in paths {
            match std::fs::metadata(root.join(p)) {
                Ok(meta) if meta.is_file() => entries.push(FileEntry { path: p.clone(), size: meta.len(), lang: Lang::from_path(p), mtime_ms: gitp_code::files::mtime_ms(&meta) }),
                Ok(meta) if meta.is_dir() => {
                    if let Ok(inside) = walk(&root.join(p)) {
                        entries.extend(inside.into_iter().map(|f| FileEntry { path: format!("{p}/{}", f.path), ..f }));
                    }
                }
                _ => removed.push(p.clone()),
            }
        }
        {
            let mut files = code.files.write().unwrap();
            // A gone path takes everything under it: a directory's files
            // were never reported one by one.
            for p in &removed {
                let prefix = format!("{p}/");
                let under: Vec<String> = files.iter().filter(|f| f.path.starts_with(&prefix)).map(|f| f.path.clone()).collect();
                files.retain(|f| f.path != *p && !f.path.starts_with(&prefix));
                removed_under.extend(under);
            }
            for e in &entries {
                match files.binary_search_by(|f| f.path.cmp(&e.path)) {
                    Ok(i) => files[i] = e.clone(),
                    Err(i) => files.insert(i, e.clone()),
                }
            }
        }
        removed.append(&mut removed_under);
        let to_index: Vec<String> = entries.iter().map(|e| e.path.clone()).chain(removed.iter().cloned()).collect();
        reindex_many(&code.index, root, &to_index);
    }
    let payload = FilesChanged { paths: paths.to_vec(), external, entries, removed, rebuilt: overflow };
    emit(FILES_CHANGED_EVENT, serde_json::to_value(payload).unwrap_or_default());
}

/// The watcher's sink for a working-tree batch: hand its paths to the
/// repository's `CodeState`, if the Code tab has one there. The workspace
/// lock is held only to find the state; the reindex runs on the index's own.
pub(crate) fn feed_index(app: &AppHandle, change: &crate::watch::RepoChanged) {
    let found = {
        let state = app.state::<RepoState>();
        let guard = state.workspace();
        guard
            .sessions
            .iter()
            .find(|s| s.path == change.path)
            .and_then(|s| Some((s.code.clone()?, s.repo.workdir_path().ok()?)))
    };
    if let Some((code, root)) = found {
        // Off the watcher thread: a checkout's rebuild must not delay the
        // History tab's refresh, which the same batch triggers.
        let emit = app_emit(app);
        let (paths, overflow) = (change.worktree_paths.clone(), change.worktree_overflow);
        std::thread::spawn(move || on_worktree_changed(&emit, &code, &root, &paths, overflow));
    }
}

// --- Tauri commands --------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn code_open_workspace(app: AppHandle, state: State<RepoState>) -> Result<Workspace, String> {
    code_open_workspace_impl(&state, app_emit(&app))
}

#[tauri::command(async)]
pub(crate) fn code_refresh(state: State<RepoState>) -> Result<Vec<FileEntry>, String> {
    code_refresh_impl(&state)
}

#[tauri::command(async)]
pub(crate) fn code_read_file(path: String, state: State<RepoState>) -> Result<Option<CodeFile>, String> {
    code_read_file_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn code_write_file(path: String, text: String, crlf: bool, expected_mtime_ms: u64, state: State<RepoState>) -> Result<u64, String> {
    code_write_file_impl(&state, path, text, crlf, expected_mtime_ms)
}

#[tauri::command(async)]
pub(crate) fn code_definition(path: String, line: u32, col: u32, state: State<RepoState>) -> Result<Vec<Symbol>, String> {
    code_definition_impl(&state, path, line, col)
}

#[tauri::command(async)]
pub(crate) fn code_references(path: String, line: u32, col: u32, state: State<RepoState>) -> Result<UsagesResult, String> {
    code_references_impl(&state, path, line, col)
}

#[tauri::command(async)]
pub(crate) fn code_callers(path: String, line: u32, col: u32, state: State<RepoState>) -> Result<Vec<HierarchyNode>, String> {
    code_callers_impl(&state, path, line, col)
}

#[tauri::command(async)]
pub(crate) fn code_callees(path: String, line: u32, col: u32, state: State<RepoState>) -> Result<Vec<HierarchyNode>, String> {
    code_callees_impl(&state, path, line, col)
}

#[tauri::command(async)]
pub(crate) fn code_file_symbols(path: String, state: State<RepoState>) -> Result<Vec<Symbol>, String> {
    code_file_symbols_impl(&state, path)
}

#[tauri::command(async)]
pub(crate) fn code_search(query: Query, limit: usize, state: State<RepoState>) -> Result<SearchResult, String> {
    code_search_impl(&state, query, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::make_repo;
    use crate::workspace::open_repo_impl;
    use std::time::Duration;

    fn open(dir: &Path) -> RepoState {
        let state = RepoState::default();
        open_repo_impl(&state, dir.to_str().unwrap().to_string()).expect("open");
        state
    }

    fn wait_ready(state: &RepoState) {
        let (code, _) = code_state(state).unwrap();
        let t = std::time::Instant::now();
        while !code.ready.load(Ordering::SeqCst) {
            assert!(t.elapsed() < Duration::from_secs(10), "index never became ready");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn open_workspace_lists_files_and_indexes() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join("a.ts"), "export function alpha() {}\nalpha();\n").unwrap();
        let state = open(dir.path());
        let ws = code_open_workspace_impl(&state, no_emit()).unwrap();
        assert!(ws.indexing);
        let paths: Vec<&str> = ws.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.ts", "f.txt"]);
        wait_ready(&state);
        let found = code_definition_impl(&state, "a.ts".into(), 1, 0).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name.as_ref(), "alpha");
        // Opening again neither rebuilds nor reports indexing.
        assert!(!code_open_workspace_impl(&state, no_emit()).unwrap().indexing);
    }

    #[test]
    fn definition_before_ready_is_indexing_error() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        code_state_or_init(&state).unwrap(); // a CodeState with no build started
        assert_eq!(code_definition_impl(&state, "f.txt".into(), 0, 0).unwrap_err(), "indexing");
        assert_eq!(code_references_impl(&state, "f.txt".into(), 0, 0).unwrap_err(), "indexing");
    }

    #[test]
    fn write_with_stale_mtime_is_changed_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        let file = code_read_file_impl(&state, "f.txt".into()).unwrap().unwrap();
        let err = code_write_file_impl(&state, "f.txt".into(), "x\n".into(), false, file.mtime_ms + 1).unwrap_err();
        assert_eq!(err, "changed_on_disk");
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "line 0\n");
    }

    #[test]
    fn write_keeps_crlf() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join("w.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        let state = open(dir.path());
        let file = code_read_file_impl(&state, "w.txt".into()).unwrap().unwrap();
        assert!(file.crlf);
        assert_eq!(file.text, "one\ntwo\nthree\n");
        code_write_file_impl(&state, "w.txt".into(), "one\nTWO\nthree\n".into(), file.crlf, file.mtime_ms).unwrap();
        assert_eq!(std::fs::read(dir.path().join("w.txt")).unwrap(), b"one\r\nTWO\r\nthree\r\n");
    }

    #[test]
    fn write_reindexes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join("a.ts"), "export function alpha() {}\n").unwrap();
        let state = open(dir.path());
        code_open_workspace_impl(&state, no_emit()).unwrap();
        wait_ready(&state);
        let file = code_read_file_impl(&state, "a.ts".into()).unwrap().unwrap();
        code_write_file_impl(&state, "a.ts".into(), "export function beta() {}\n".into(), false, file.mtime_ms).unwrap();
        let (code, _) = code_state(&state).unwrap();
        let index = code.index.read().unwrap();
        assert_eq!(index.definitions_named("alpha").count(), 0);
        assert_eq!(index.definitions_named("beta").count(), 1);
    }

    fn ready_state(dir: &Path) -> (RepoState, Arc<CodeState>) {
        let state = open(dir);
        code_open_workspace_impl(&state, no_emit()).unwrap();
        wait_ready(&state);
        let (code, _) = code_state(&state).unwrap();
        (state, code)
    }

    fn capture() -> (Emit, Arc<Mutex<Vec<(String, serde_json::Value)>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let emit: Emit = Arc::new(move |name, payload| record.lock().unwrap().push((name.to_string(), payload)));
        (emit, seen)
    }

    #[test]
    fn on_worktree_changed_reindexes_and_patches_files() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let (_state, code) = ready_state(dir.path());
        let (emit, seen) = capture();

        std::fs::write(dir.path().join("n.ts"), "export function newer() {}\n").unwrap();
        on_worktree_changed(&emit, &code, dir.path(), &["n.ts".into()], false);
        assert_eq!(code.index.read().unwrap().definitions_named("newer").count(), 1);
        let paths: Vec<String> = code.files.read().unwrap().iter().map(|f| f.path.clone()).collect();
        assert_eq!(paths, ["f.txt", "n.ts"], "inserted in order");
        let (name, payload) = seen.lock().unwrap().pop().unwrap();
        assert_eq!(name, FILES_CHANGED_EVENT);
        assert_eq!(payload["external"], serde_json::json!(["n.ts"]));
        assert_eq!(payload["entries"][0]["path"], "n.ts");
        assert_eq!(payload["rebuilt"], false);

        std::fs::remove_file(dir.path().join("n.ts")).unwrap();
        on_worktree_changed(&emit, &code, dir.path(), &["n.ts".into()], false);
        assert_eq!(code.index.read().unwrap().definitions_named("newer").count(), 0);
        assert!(!code.files.read().unwrap().iter().any(|f| f.path == "n.ts"));
        let (_, payload) = seen.lock().unwrap().pop().unwrap();
        assert_eq!(payload["removed"], serde_json::json!(["n.ts"]));
    }

    #[test]
    fn own_write_is_not_external() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let (state, code) = ready_state(dir.path());
        let file = code_read_file_impl(&state, "f.txt".into()).unwrap().unwrap();
        code_write_file_impl(&state, "f.txt".into(), "mine\n".into(), false, file.mtime_ms).unwrap();
        let (emit, seen) = capture();
        on_worktree_changed(&emit, &code, dir.path(), &["f.txt".into()], false);
        let (_, payload) = seen.lock().unwrap().pop().unwrap();
        assert_eq!(payload["paths"], serde_json::json!(["f.txt"]));
        assert_eq!(payload["external"], serde_json::json!([]));
    }

    #[test]
    fn overflow_rebuilds() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let (_state, code) = ready_state(dir.path());
        std::fs::write(dir.path().join("big.py"), "def huge():\n    pass\n").unwrap();
        let (emit, _) = capture();
        on_worktree_changed(&emit, &code, dir.path(), &[], true);
        assert_eq!(code.index.read().unwrap().definitions_named("huge").count(), 1);
        assert!(code.files.read().unwrap().iter().any(|f| f.path == "big.py"));
    }

    #[test]
    fn a_directory_rename_moves_its_files() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/m.ts"), "export function moved() {}\n").unwrap();
        let (_state, code) = ready_state(dir.path());
        std::fs::rename(dir.path().join("src"), dir.path().join("lib")).unwrap();
        let (emit, _) = capture();
        // notify reports the directory paths only.
        on_worktree_changed(&emit, &code, dir.path(), &["lib".into(), "src".into()], false);
        let index = code.index.read().unwrap();
        let moved: Vec<&str> = index.definitions_named("moved").map(|s| s.path.as_ref()).collect();
        assert_eq!(moved, ["lib/m.ts"]);
        assert!(index.file("src/m.ts").is_none());
        let paths: Vec<String> = code.files.read().unwrap().iter().map(|f| f.path.clone()).collect();
        assert_eq!(paths, ["f.txt", "lib/m.ts"]);
    }

    #[test]
    fn reopening_the_workspace_reindexes_stale_files() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join("a.ts"), "export function alpha() {}\n").unwrap();
        let (state, code) = ready_state(dir.path());
        // Edited while this repo's tab was inactive: no watcher batch arrives.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.path().join("a.ts"), "export function alpha2() {}\n").unwrap();
        code.index.write().unwrap().mark_stale("a.ts");
        let ws = code_open_workspace_impl(&state, no_emit()).unwrap();
        assert!(!ws.indexing);
        let index = code.index.read().unwrap();
        assert_eq!(index.definitions_named("alpha").count(), 0);
        assert_eq!(index.definitions_named("alpha2").count(), 1);
    }

    #[test]
    fn usages_of_a_variable_come_from_a_whole_word_grep() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        std::fs::write(dir.path().join("a.ts"), "export const rate = 1;\nconst x = rate + rates;\n").unwrap();
        std::fs::write(dir.path().join("b.py"), "rate = 2\n").unwrap();
        let (state, _code) = ready_state(dir.path());
        let r = code_references_impl(&state, "a.ts".into(), 0, 13).unwrap();
        assert_eq!(r.symbol.name.as_ref(), "rate");
        let hits: Vec<(&str, u32, bool)> = r.hits.iter().map(|h| (h.reference.path.as_ref(), h.reference.range.start_line, h.certain)).collect();
        assert_eq!(hits, [("a.ts", 1, false)], "the use on line 2, not `rates`, not the Python file, not the definition");
        assert_eq!(r.hits[0].reference.range.start_col, 10);
    }

    #[test]
    fn own_write_is_remembered() {
        let dir = tempfile::tempdir().unwrap();
        make_repo(dir.path(), &["c1"]);
        let state = open(dir.path());
        let file = code_read_file_impl(&state, "f.txt".into()).unwrap().unwrap();
        let mtime = code_write_file_impl(&state, "f.txt".into(), "x\n".into(), false, file.mtime_ms).unwrap();
        let (code, _) = code_state(&state).unwrap();
        assert_eq!(code.own_writes.lock().unwrap().get("f.txt"), Some(&mtime));
        let on_disk = gitp_code::files::mtime_ms(&std::fs::metadata(dir.path().join("f.txt")).unwrap());
        assert_eq!(mtime, on_disk);
    }
}
