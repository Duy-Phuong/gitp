//! What one file defines and what it refers to, pulled out of its syntax
//! tree, and the index over all of them.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, RwLock};

use rayon::prelude::*;

use serde::Serialize;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Parser, Point, QueryCursor};

use crate::files::FileEntry;
use crate::lang::Lang;

/// A definition's identity: the file it is in and where it starts. Stable
/// across parses as long as the definition starts at the same byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub struct SymbolId {
    pub file: u32,
    pub byte: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Interface,
    Enum,
    Variable,
    Field,
}

/// A span of text. Lines are 0-based; columns are UTF-16 code units, which is
/// what the editor's positions are in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Range {
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub start_byte: u32,
    pub end_byte: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Symbol {
    pub id: SymbolId,
    pub name: Arc<str>,
    pub kind: SymbolKind,
    /// Shared with every symbol and reference of the file: a 20k-file repo
    /// has millions of these, and a `String` each would be most of its memory.
    pub path: Arc<str>,
    /// The whole definition.
    pub range: Range,
    /// Just the identifier: where the caret lands.
    pub name_range: Range,
    /// The enclosing class or function.
    pub container: Option<SymbolId>,
    pub lang: Lang,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Call,
    Ident,
    Import,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Reference {
    pub name: Arc<str>,
    pub kind: RefKind,
    pub path: Arc<str>,
    pub range: Range,
    /// The symbol whose body contains it.
    pub enclosing: Option<SymbolId>,
    /// `foo` in `foo.save()`; `this` / `self` kept as written.
    pub receiver: Option<String>,
}

pub struct FileIndex {
    pub path: Arc<str>,
    pub lang: Lang,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Reference>,
    pub mtime_ms: u64,
}

/// Parse `source` and pull out its definitions and references.
pub fn index_file(file_id: u32, path: &str, lang: Lang, source: &[u8]) -> FileIndex {
    let def = lang.def();
    let mut parser = Parser::new();
    parser.set_language(&def.language).expect("grammar matches the tree-sitter version");
    let tree = parser.parse(source, None).expect("parse without a timeout never fails");
    let root = tree.root_node();
    let lines = LineTable::new(source);
    let path: Arc<str> = Arc::from(path);
    // One allocation per distinct name in the file, however often it occurs.
    let mut names: HashMap<&[u8], Arc<str>> = HashMap::new();
    let mut intern = |n: Node| -> Arc<str> {
        let bytes = &source[n.byte_range()];
        names.entry(bytes).or_insert_with(|| Arc::from(String::from_utf8_lossy(bytes).as_ref())).clone()
    };
    let text = |n: Node| String::from_utf8_lossy(&source[n.byte_range()]).into_owned();

    let mut symbols: Vec<Symbol> = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&def.defs, root, source);
    while let Some(m) = matches.next() {
        let mut name = None;
        let mut body = None;
        for c in m.captures {
            let cap = &def.defs.capture_names()[c.index as usize];
            match cap.strip_prefix("def.") {
                Some(kind) => body = Some((symbol_kind(kind), c.node)),
                None if *cap == "name" => name = Some(c.node),
                None => {}
            }
        }
        let (Some(name), Some((kind, body))) = (name, body) else { continue };
        symbols.push(Symbol {
            id: SymbolId { file: file_id, byte: body.start_byte() as u32 },
            name: intern(name),
            kind,
            path: path.clone(),
            range: lines.range(body),
            name_range: lines.range(name),
            container: None,
            lang,
        });
    }
    // Outer definitions first; the innermost other symbol around each is its
    // container. A span matched twice (`const f = () => …` is a variable and
    // a function) keeps the more specific kind.
    symbols.sort_by_key(|s| (s.range.start_byte, std::cmp::Reverse(s.range.end_byte), kind_rank(s.kind)));
    symbols.dedup_by_key(|s| s.id);
    // Only scopes contain things: a variable's declaration spans its
    // initializer, but nothing is "inside" a variable.
    let spans: Vec<(u32, u32, SymbolId)> = symbols
        .iter()
        .filter(|s| !matches!(s.kind, SymbolKind::Variable | SymbolKind::Field))
        .map(|s| (s.range.start_byte, s.range.end_byte, s.id))
        .collect();
    let enclosing = |start: u32, end: u32, not: Option<SymbolId>| {
        spans
            .iter()
            .rev()
            .find(|(a, b, id)| Some(*id) != not && *a <= start && end <= *b && (*a, *b) != (start, end))
            .map(|(_, _, id)| *id)
    };
    for s in &mut symbols {
        s.container = enclosing(s.range.start_byte, s.range.end_byte, Some(s.id));
    }
    // A function directly inside a class is a method (Python's `def` says no
    // more than that).
    let classes: HashSet<SymbolId> = symbols.iter().filter(|s| s.kind == SymbolKind::Class).map(|s| s.id).collect();
    for s in &mut symbols {
        if s.kind == SymbolKind::Function && s.container.is_some_and(|c| classes.contains(&c)) {
            s.kind = SymbolKind::Method;
        }
    }

    let def_names: HashSet<(u32, u32)> = symbols.iter().map(|s| (s.name_range.start_byte, s.name_range.end_byte)).collect();
    let mut refs: Vec<Reference> = Vec::new();
    let mut matches = cursor.matches(&def.refs, root, source);
    while let Some(m) = matches.next() {
        let mut name = None;
        let mut kind = None;
        let mut receiver = None;
        for c in m.captures {
            let cap = &def.refs.capture_names()[c.index as usize];
            match *cap {
                "name" => name = Some(c.node),
                "receiver" => receiver = Some(text(c.node)),
                "ref.call" => kind = Some(RefKind::Call),
                "ref.import" => kind = Some(RefKind::Import),
                "ref.ident" => kind = Some(RefKind::Ident),
                _ => {}
            }
        }
        let (Some(name), Some(kind)) = (name, kind) else { continue };
        let range = lines.range(name);
        if def_names.contains(&(range.start_byte, range.end_byte)) {
            continue; // a definition's own name
        }
        refs.push(Reference {
            name: intern(name),
            kind,
            path: path.clone(),
            range,
            enclosing: enclosing(range.start_byte, range.end_byte, None),
            receiver,
        });
    }
    // One reference per identifier: the most specific kind, with a receiver
    // when any match had one.
    refs.sort_by_key(|r| (r.range.start_byte, r.range.end_byte, specificity(r.kind), r.receiver.is_none()));
    refs.dedup_by(|b, a| (a.range.start_byte, a.range.end_byte) == (b.range.start_byte, b.range.end_byte));

    FileIndex { path, lang, symbols, refs, mtime_ms: 0 }
}

/// Lower sorts first when two patterns match the same span.
fn kind_rank(kind: SymbolKind) -> u8 {
    match kind {
        SymbolKind::Class | SymbolKind::Interface | SymbolKind::Enum => 0,
        SymbolKind::Function | SymbolKind::Method => 1,
        SymbolKind::Field => 2,
        SymbolKind::Variable => 3,
    }
}

fn symbol_kind(name: &str) -> SymbolKind {
    match name {
        "function" => SymbolKind::Function,
        "method" => SymbolKind::Method,
        "class" => SymbolKind::Class,
        "interface" => SymbolKind::Interface,
        "enum" => SymbolKind::Enum,
        "field" => SymbolKind::Field,
        _ => SymbolKind::Variable,
    }
}

/// Lower sorts first: Call beats Import beats Ident when captures overlap.
fn specificity(kind: RefKind) -> u8 {
    match kind {
        RefKind::Call => 0,
        RefKind::Import => 1,
        RefKind::Ident => 2,
    }
}

/// Byte offsets of line starts, for turning a node's byte columns into
/// UTF-16 ones.
struct LineTable<'a> {
    source: &'a [u8],
    starts: Vec<usize>,
}

impl<'a> LineTable<'a> {
    fn new(source: &'a [u8]) -> Self {
        let mut starts = vec![0];
        starts.extend(source.iter().enumerate().filter(|(_, b)| **b == b'\n').map(|(i, _)| i + 1));
        LineTable { source, starts }
    }

    fn col(&self, point: Point, byte: usize) -> u32 {
        let start = self.starts[point.row];
        String::from_utf8_lossy(&self.source[start..byte]).encode_utf16().count() as u32
    }

    fn range(&self, n: Node) -> Range {
        let (s, e) = (n.start_position(), n.end_position());
        Range {
            start_line: s.row as u32,
            start_col: self.col(s, n.start_byte()),
            end_line: e.row as u32,
            end_col: self.col(e, n.end_byte()),
            start_byte: n.start_byte() as u32,
            end_byte: n.end_byte() as u32,
        }
    }
}

/// Every indexed file's definitions and references, with name lookups
/// across them.
#[derive(Default)]
pub struct SymbolIndex {
    files: HashMap<String, FileIndex>,
    /// File ids, assigned on first sight and never reused, so a symbol's id
    /// survives a reindex of its file.
    ids: HashMap<String, u32>,
    paths: Vec<String>,
    by_name: HashMap<Arc<str>, Vec<SymbolId>>,
    /// `(path, index into that file's refs)`.
    refs_by_name: HashMap<Arc<str>, Vec<(Arc<str>, usize)>>,
}

impl SymbolIndex {
    /// Index every supported file in `files`, in parallel.
    pub fn build(root: &Path, files: &[FileEntry]) -> SymbolIndex {
        let mut index = SymbolIndex::default();
        let supported: Vec<(u32, &FileEntry, Lang)> = files
            .iter()
            .filter_map(|f| f.lang.map(|lang| (index.id_for(&f.path), f, lang)))
            .collect();
        let parsed: Vec<FileIndex> = supported
            .par_iter()
            .filter_map(|(id, f, lang)| {
                let src = std::fs::read(root.join(&f.path)).ok()?;
                let mut fi = index_file(*id, &f.path, *lang, &src);
                fi.mtime_ms = f.mtime_ms;
                Some(fi)
            })
            .collect();
        for fi in parsed {
            index.insert(fi);
        }
        index
    }

    /// Parse `path` again (or for the first time); a missing or unsupported
    /// file is dropped from the index.
    pub fn reindex(&mut self, root: &Path, path: &str) {
        self.remove(path);
        let Some(lang) = Lang::from_path(path) else { return };
        let full = root.join(path);
        let (Ok(src), Ok(meta)) = (std::fs::read(&full), std::fs::metadata(&full)) else { return };
        let id = self.id_for(path);
        let mut fi = index_file(id, path, lang, &src);
        fi.mtime_ms = crate::files::mtime_ms(&meta);
        self.insert(fi);
    }

    pub fn remove(&mut self, path: &str) {
        let Some(old) = self.files.remove(path) else { return };
        let file = old.symbols.first().map(|s| s.id.file);
        let names: HashSet<&Arc<str>> = old.symbols.iter().map(|s| &s.name).collect();
        for name in names {
            if let Some(v) = self.by_name.get_mut(name) {
                v.retain(|id| Some(id.file) != file);
                if v.is_empty() {
                    self.by_name.remove(name);
                }
            }
        }
        let names: HashSet<&Arc<str>> = old.refs.iter().map(|r| &r.name).collect();
        for name in names {
            if let Some(v) = self.refs_by_name.get_mut(name) {
                v.retain(|(p, _)| p.as_ref() != path);
                if v.is_empty() {
                    self.refs_by_name.remove(name);
                }
            }
        }
    }

    /// Forget a file's mtime so the next refresh parses it again.
    pub fn mark_stale(&mut self, path: &str) {
        if let Some(f) = self.files.get_mut(path) {
            f.mtime_ms = 0;
        }
    }

    /// Assign (or look up) the id for `path`, for a parse done outside the lock.
    pub fn prepare(&mut self, path: &str) -> u32 {
        self.id_for(path)
    }

    /// Put a parse done outside the lock in place of the file's old entry.
    pub fn apply(&mut self, fi: FileIndex) {
        self.remove(&fi.path);
        self.insert(fi);
    }

    pub fn file(&self, path: &str) -> Option<&FileIndex> {
        self.files.get(path)
    }

    pub fn symbol(&self, id: SymbolId) -> Option<&Symbol> {
        let path = self.paths.get(id.file as usize)?;
        self.files.get(path)?.symbols.iter().find(|s| s.id == id)
    }

    pub fn definitions_named(&self, name: &str) -> impl Iterator<Item = &Symbol> {
        self.by_name.get(name).into_iter().flatten().filter_map(move |id| self.symbol(*id))
    }

    pub fn references_named(&self, name: &str) -> impl Iterator<Item = &Reference> {
        self.refs_by_name
            .get(name)
            .into_iter()
            .flatten()
            .filter_map(move |(p, i)| self.files.get(p.as_ref()).and_then(|f| f.refs.get(*i)))
    }

    pub fn symbol_count(&self) -> usize {
        self.files.values().map(|f| f.symbols.len()).sum()
    }

    pub fn file_symbols(&self, path: &str) -> Vec<Symbol> {
        self.files.get(path).map(|f| f.symbols.clone()).unwrap_or_default()
    }

    /// Supported files whose mtime differs from the indexed one or that the
    /// index hasn't seen, plus indexed files no longer in `files`.
    pub fn stale_files(&self, files: &[FileEntry]) -> Vec<String> {
        let mut stale: Vec<String> = files
            .iter()
            .filter(|f| f.lang.is_some())
            .filter(|f| self.files.get(&f.path).is_none_or(|fi| fi.mtime_ms != f.mtime_ms))
            .map(|f| f.path.clone())
            .collect();
        let present: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
        stale.extend(self.files.keys().filter(|p| !present.contains(p.as_str())).cloned());
        stale
    }

    fn id_for(&mut self, path: &str) -> u32 {
        if let Some(id) = self.ids.get(path) {
            return *id;
        }
        let id = self.paths.len() as u32;
        self.paths.push(path.to_string());
        self.ids.insert(path.to_string(), id);
        id
    }

    fn insert(&mut self, fi: FileIndex) {
        for s in &fi.symbols {
            self.by_name.entry(s.name.clone()).or_default().push(s.id);
        }
        for (i, r) in fi.refs.iter().enumerate() {
            self.refs_by_name.entry(r.name.clone()).or_default().push((fi.path.clone(), i));
        }
        self.files.insert(fi.path.to_string(), fi);
    }
}

/// Reindex `paths` with the lock held only to assign ids and to swap the
/// results in; the parsing — the slow part — runs in parallel outside it, so
/// saves and queries are not blocked by a batch of changed files.
pub fn reindex_many(lock: &RwLock<SymbolIndex>, root: &Path, paths: &[String]) {
    let mut jobs = Vec::new();
    let mut gone = Vec::new();
    {
        let mut index = lock.write().unwrap();
        for p in paths {
            let full = root.join(p);
            match (Lang::from_path(p), std::fs::metadata(&full)) {
                (Some(lang), Ok(meta)) if meta.is_file() => jobs.push((index.prepare(p), p.clone(), lang, crate::files::mtime_ms(&meta))),
                _ => gone.push(p.clone()),
            }
        }
    }
    let parsed: Vec<FileIndex> = jobs
        .par_iter()
        .filter_map(|(id, p, lang, mtime)| {
            let src = std::fs::read(root.join(p)).ok()?;
            let mut fi = index_file(*id, p, *lang, &src);
            fi.mtime_ms = *mtime;
            Some(fi)
        })
        .collect();
    let mut index = lock.write().unwrap();
    for p in &gone {
        index.remove(p);
    }
    for fi in parsed {
        index.apply(fi);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JAVA: &str = include_str!("../tests/fixtures/java/Account.java");

    fn java() -> FileIndex {
        index_file(0, "Account.java", Lang::Java, JAVA.as_bytes())
    }

    fn sym<'a>(fi: &'a FileIndex, name: &str, kind: SymbolKind) -> &'a Symbol {
        fi.symbols
            .iter()
            .find(|s| s.name.as_ref() == name && s.kind == kind)
            .unwrap_or_else(|| panic!("no {kind:?} {name}"))
    }

    #[test]
    fn java_definitions() {
        use SymbolKind::*;
        let fi = java();
        let names: Vec<(&str, SymbolKind)> = fi.symbols.iter().map(|s| (s.name.as_ref(), s.kind)).collect();
        assert_eq!(
            names,
            [
                ("Account", Class),
                ("balance", Field),
                ("Account", Method),
                ("initial", Variable),
                ("deposit", Method),
                ("amount", Variable),
                ("audit", Method),
                ("café", Variable),
                ("all", Variable),
            ]
        );
        assert_eq!(sym(&fi, "deposit", Method).container, Some(sym(&fi, "Account", Class).id));
        assert_eq!(sym(&fi, "amount", Variable).container, Some(sym(&fi, "deposit", Method).id));
        assert_eq!(sym(&fi, "Account", Class).container, None);
        assert_eq!(sym(&fi, "deposit", Method).name_range.start_line, 11);
        assert_eq!(sym(&fi, "deposit", Method).name_range.start_col, 16);
        assert_eq!(sym(&fi, "deposit", Method).range.start_line, 11);
        assert_eq!(sym(&fi, "deposit", Method).range.end_line, 13);
    }

    #[test]
    fn java_references() {
        let fi = java();
        let audit = sym(&fi, "audit", SymbolKind::Method).id;
        let deposit = fi.refs.iter().find(|r| r.name.as_ref() == "deposit").unwrap();
        assert_eq!(deposit.kind, RefKind::Call);
        assert_eq!(deposit.receiver.as_deref(), Some("this"));
        assert_eq!(deposit.enclosing, Some(audit));
        let log = fi.refs.iter().find(|r| r.name.as_ref() == "log").unwrap();
        assert_eq!(log.receiver.as_deref(), Some("Logger"));
        let import = fi.refs.iter().find(|r| r.kind == RefKind::Import).unwrap();
        assert_eq!(import.name.as_ref(), "java.util.List");
        let new = fi.refs.iter().find(|r| r.name.as_ref() == "ArrayList").unwrap();
        assert_eq!(new.kind, RefKind::Call);
        let list = fi.refs.iter().find(|r| r.name.as_ref() == "List" && r.kind == RefKind::Ident).unwrap();
        assert_eq!(list.enclosing, Some(audit));
        // The field's own declaration is a definition, not a reference.
        assert!(!fi.refs.iter().any(|r| r.name.as_ref() == "balance" && r.range.start_line == 5));
        // The constructor's `this.balance` is a member access.
        let field = fi.refs.iter().find(|r| r.name.as_ref() == "balance").unwrap();
        assert_eq!((field.kind, field.receiver.as_deref()), (RefKind::Ident, Some("this")));
    }

    #[test]
    fn columns_are_utf16() {
        let fi = java();
        let log = fi.refs.iter().find(|r| r.name.as_ref() == "log").unwrap();
        let line = JAVA.lines().nth(16).unwrap();
        let byte = line.find("log(").unwrap();
        let utf16 = line[..byte].encode_utf16().count();
        assert_eq!(byte - utf16, 1, "one é, two bytes, precedes the call");
        assert_eq!(log.range.start_col as usize, utf16);
        assert_eq!(log.range.end_col as usize, utf16 + 3);
        assert_eq!(log.range.start_byte as usize, JAVA.find("log(").unwrap());
    }

    #[test]
    fn overlapping_captures_are_deduped() {
        let fi = java();
        assert_eq!(fi.refs.iter().filter(|r| r.name.as_ref() == "deposit").count(), 1);
        assert_eq!(fi.refs.iter().filter(|r| r.name.as_ref() == "ArrayList").count(), 1);
        let mut spans: Vec<(u32, u32)> = fi.refs.iter().map(|r| (r.range.start_byte, r.range.end_byte)).collect();
        let n = spans.len();
        spans.sort();
        spans.dedup();
        assert_eq!(spans.len(), n, "every reference spans a distinct identifier");
    }
}

#[cfg(test)]
mod lang_tests {
    use super::*;
    use SymbolKind::*;

    const JS: &str = include_str!("../tests/fixtures/js/cart.js");
    const TS: &str = include_str!("../tests/fixtures/ts/cart.ts");
    const TSX: &str = include_str!("../tests/fixtures/tsx/Cart.tsx");
    const PY: &str = include_str!("../tests/fixtures/py/cart.py");

    fn names(fi: &FileIndex) -> Vec<(&str, SymbolKind)> {
        fi.symbols.iter().map(|s| (s.name.as_ref(), s.kind)).collect()
    }

    #[test]
    fn js_definitions() {
        let fi = index_file(0, "cart.js", Lang::JavaScript, JS.as_bytes());
        assert_eq!(
            names(&fi),
            [
                ("Cart", Class),
                ("constructor", Method),
                ("add", Method),
                ("item", Variable),
                ("total", Function),
                ("cart", Variable),
                ("x", Variable),
                ("c", Variable),
                ("fmt", Function),
                ("n", Variable),
            ]
        );
        let add = fi.symbols.iter().find(|s| s.name.as_ref() == "add").unwrap();
        let cart = fi.symbols.iter().find(|s| s.name.as_ref() == "Cart").unwrap();
        assert_eq!(add.container, Some(cart.id));
    }

    #[test]
    fn ts_definitions() {
        let fi = index_file(0, "cart.ts", Lang::TypeScript, TS.as_bytes());
        assert_eq!(
            names(&fi),
            [
                ("Props", Interface),
                ("count", Field),
                ("Cart", Class),
                ("items", Field),
                ("add", Method),
                ("item", Variable),
                ("total", Function),
                ("cart", Variable),
                ("x", Variable),
                ("c", Variable),
                ("fmt", Function),
                ("n", Variable),
            ]
        );
    }

    #[test]
    fn tsx_parses_jsx() {
        let fi = index_file(0, "Cart.tsx", Lang::Tsx, TSX.as_bytes());
        assert!(fi.symbols.iter().any(|s| s.name.as_ref() == "View" && s.kind == Function));
        let view = fi.symbols.iter().find(|s| s.name.as_ref() == "View").unwrap();
        let fmt_call = fi.refs.iter().find(|r| r.name.as_ref() == "fmt" && r.kind == RefKind::Call).unwrap();
        assert_eq!(fmt_call.enclosing, Some(view.id));
        let props = fi.refs.iter().find(|r| r.name.as_ref() == "Props").unwrap();
        assert_eq!(props.kind, RefKind::Ident);
    }

    #[test]
    fn py_definitions() {
        let fi = index_file(0, "cart.py", Lang::Python, PY.as_bytes());
        assert_eq!(
            names(&fi),
            [
                ("RATE", Variable),
                ("Cart", Class),
                ("__init__", Method),
                ("self", Variable),
                ("add", Method),
                ("self", Variable),
                ("item", Variable),
                ("total", Function),
                ("cart", Variable),
                ("x", Variable),
            ]
        );
        assert!(!fi.symbols.iter().any(|s| s.name.as_ref() == "items"), "self.items is an attribute, not a definition");
    }

    #[test]
    fn each_lang_finds_the_call_and_the_import() {
        for (path, lang, src) in [
            ("cart.js", Lang::JavaScript, JS),
            ("cart.ts", Lang::TypeScript, TS),
            ("Cart.tsx", Lang::Tsx, TSX),
            ("cart.py", Lang::Python, PY),
        ] {
            let fi = index_file(0, path, lang, src.as_bytes());
            let total = fi.symbols.iter().find(|s| s.name.as_ref() == "total").unwrap();
            let add = fi.refs.iter().find(|r| r.name.as_ref() == "add" && r.kind == RefKind::Call).unwrap_or_else(|| panic!("{path}: cart.add"));
            assert_eq!(add.receiver.as_deref(), Some("cart"), "{path}");
            assert_eq!(add.enclosing, Some(total.id), "{path}");
            let new = fi.refs.iter().find(|r| r.name.as_ref() == "Cart" && r.kind == RefKind::Call).unwrap_or_else(|| panic!("{path}: new Cart"));
            assert_eq!(new.enclosing, Some(total.id), "{path}");
            assert!(fi.refs.iter().any(|r| r.name.as_ref() == "money" && r.kind == RefKind::Import), "{path}: import money");
            assert!(fi.refs.iter().any(|r| r.name.as_ref() == "money" && r.kind == RefKind::Call), "{path}: money(...)");
            let spans: Vec<(u32, u32)> = fi.refs.iter().map(|r| (r.range.start_byte, r.range.end_byte)).collect();
            let mut uniq = spans.clone();
            uniq.sort();
            uniq.dedup();
            assert_eq!(uniq.len(), spans.len(), "{path}: refs deduped");
        }
    }
}

#[cfg(test)]
mod index_tests {
    use super::*;
    use crate::files::walk;

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "export function alpha() { beta(); }\n").unwrap();
        std::fs::write(dir.path().join("b.ts"), "export function beta() {}\n").unwrap();
        std::fs::write(dir.path().join("c.py"), "def gamma():\n    beta()\n").unwrap();
        std::fs::write(dir.path().join("notes.md"), "# not code\n").unwrap();
        dir
    }

    fn build(dir: &tempfile::TempDir) -> SymbolIndex {
        SymbolIndex::build(dir.path(), &walk(dir.path()).unwrap())
    }

    #[test]
    fn build_indexes_three_files() {
        let dir = workspace();
        let index = build(&dir);
        assert_eq!(index.symbol_count(), 3);
        assert!(index.file("notes.md").is_none());
        let beta: Vec<&Symbol> = index.definitions_named("beta").collect();
        assert_eq!(beta.len(), 1);
        assert_eq!(beta[0].path.as_ref(), "b.ts");
        assert_eq!(index.references_named("beta").count(), 2);
        assert_eq!(index.file_symbols("c.py").len(), 1);
        assert!(index.file("a.ts").unwrap().mtime_ms > 0);
    }

    #[test]
    fn reindex_replaces_a_files_symbols() {
        let dir = workspace();
        let mut index = build(&dir);
        std::fs::write(dir.path().join("b.ts"), "export function beta2() {}\n").unwrap();
        index.reindex(dir.path(), "b.ts");
        assert_eq!(index.definitions_named("beta").count(), 0);
        assert_eq!(index.definitions_named("beta2").count(), 1);
        for r in index.references_named("beta") {
            assert!(index.file(&r.path).is_some(), "reference points at an indexed file");
        }
    }

    #[test]
    fn remove_drops_file_and_names() {
        let dir = workspace();
        let mut index = build(&dir);
        index.remove("a.ts");
        assert!(index.file("a.ts").is_none());
        assert_eq!(index.definitions_named("alpha").count(), 0);
        assert_eq!(index.references_named("beta").count(), 1, "only c.py's call is left");
        index.remove("never-there.ts"); // harmless
    }

    #[test]
    fn file_ids_survive_reindex() {
        let dir = workspace();
        let mut index = build(&dir);
        let before = index.definitions_named("beta").next().unwrap().id;
        index.reindex(dir.path(), "b.ts");
        let after = index.definitions_named("beta").next().unwrap().id;
        assert_eq!(before, after);
        assert_eq!(index.symbol(after).map(|s| s.name.as_ref()), Some("beta"));
        std::fs::write(dir.path().join("d.ts"), "export function delta() {}\n").unwrap();
        index.reindex(dir.path(), "d.ts");
        let delta = index.definitions_named("delta").next().unwrap().id;
        assert_ne!(delta.file, after.file, "a new file gets a new id");
        assert_eq!(index.symbol(delta).map(|s| s.path.as_ref()), Some("d.ts"));
    }

    #[test]
    fn reindex_many_parses_outside_the_lock_and_applies_all() {
        let dir = workspace();
        let lock = std::sync::RwLock::new(build(&dir));
        std::fs::write(dir.path().join("b.ts"), "export function beta2() {}\n").unwrap();
        std::fs::write(dir.path().join("d.py"), "def delta():\n    pass\n").unwrap();
        std::fs::remove_file(dir.path().join("c.py")).unwrap();
        reindex_many(&lock, dir.path(), &["b.ts".to_string(), "d.py".to_string(), "c.py".to_string()]);
        let index = lock.read().unwrap();
        assert_eq!(index.definitions_named("beta2").count(), 1);
        assert_eq!(index.definitions_named("delta").count(), 1);
        assert_eq!(index.definitions_named("gamma").count(), 0);
        assert!(index.file("c.py").is_none());
        let before = index.file("b.ts").unwrap().symbols[0].id.file;
        drop(index);
        reindex_many(&lock, dir.path(), &["b.ts".to_string()]);
        assert_eq!(lock.read().unwrap().file("b.ts").unwrap().symbols[0].id.file, before, "ids survive");
    }

    #[test]
    fn stale_files_reports_changed_and_gone() {
        let dir = workspace();
        let mut index = build(&dir);
        // Pretend b.ts was indexed long ago, and a.ts is gone.
        index.files.get_mut("b.ts").unwrap().mtime_ms = 1;
        std::fs::remove_file(dir.path().join("a.ts")).unwrap();
        std::fs::write(dir.path().join("e.py"), "x = 1\n").unwrap();
        let mut stale = index.stale_files(&walk(dir.path()).unwrap());
        stale.sort();
        assert_eq!(stale, ["a.ts", "b.ts", "e.py"]);
    }
}
