//! What one file defines and what it refers to, pulled out of its syntax
//! tree, and the index over all of them.

use std::collections::HashSet;

use serde::Serialize;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Parser, Point, QueryCursor};

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
    pub name: String,
    pub kind: SymbolKind,
    pub path: String,
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
    pub name: String,
    pub kind: RefKind,
    pub path: String,
    pub range: Range,
    /// The symbol whose body contains it.
    pub enclosing: Option<SymbolId>,
    /// `foo` in `foo.save()`; `this` / `self` kept as written.
    pub receiver: Option<String>,
}

pub struct FileIndex {
    pub path: String,
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
            name: text(name),
            kind,
            path: path.to_string(),
            range: lines.range(body),
            name_range: lines.range(name),
            container: None,
            lang,
        });
    }
    // Outer definitions first; the innermost other symbol around each is its container.
    symbols.sort_by_key(|s| (s.range.start_byte, std::cmp::Reverse(s.range.end_byte)));
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
            name: text(name),
            kind,
            path: path.to_string(),
            range,
            enclosing: enclosing(range.start_byte, range.end_byte, None),
            receiver,
        });
    }
    // One reference per identifier: the most specific kind, with a receiver
    // when any match had one.
    refs.sort_by_key(|r| (r.range.start_byte, r.range.end_byte, specificity(r.kind), r.receiver.is_none()));
    refs.dedup_by(|b, a| (a.range.start_byte, a.range.end_byte) == (b.range.start_byte, b.range.end_byte));

    FileIndex { path: path.to_string(), lang, symbols, refs, mtime_ms: 0 }
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
            .find(|s| s.name == name && s.kind == kind)
            .unwrap_or_else(|| panic!("no {kind:?} {name}"))
    }

    #[test]
    fn java_definitions() {
        use SymbolKind::*;
        let fi = java();
        let names: Vec<(&str, SymbolKind)> = fi.symbols.iter().map(|s| (s.name.as_str(), s.kind)).collect();
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
        let deposit = fi.refs.iter().find(|r| r.name == "deposit").unwrap();
        assert_eq!(deposit.kind, RefKind::Call);
        assert_eq!(deposit.receiver.as_deref(), Some("this"));
        assert_eq!(deposit.enclosing, Some(audit));
        let log = fi.refs.iter().find(|r| r.name == "log").unwrap();
        assert_eq!(log.receiver.as_deref(), Some("Logger"));
        let import = fi.refs.iter().find(|r| r.kind == RefKind::Import).unwrap();
        assert_eq!(import.name, "java.util.List");
        let new = fi.refs.iter().find(|r| r.name == "ArrayList").unwrap();
        assert_eq!(new.kind, RefKind::Call);
        let list = fi.refs.iter().find(|r| r.name == "List" && r.kind == RefKind::Ident).unwrap();
        assert_eq!(list.enclosing, Some(audit));
        // The field's own declaration is a definition, not a reference.
        assert!(!fi.refs.iter().any(|r| r.name == "balance" && r.range.start_line == 5));
        // The constructor's `this.balance` is a member access.
        let field = fi.refs.iter().find(|r| r.name == "balance").unwrap();
        assert_eq!((field.kind, field.receiver.as_deref()), (RefKind::Ident, Some("this")));
    }

    #[test]
    fn columns_are_utf16() {
        let fi = java();
        let log = fi.refs.iter().find(|r| r.name == "log").unwrap();
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
        assert_eq!(fi.refs.iter().filter(|r| r.name == "deposit").count(), 1);
        assert_eq!(fi.refs.iter().filter(|r| r.name == "ArrayList").count(), 1);
        let mut spans: Vec<(u32, u32)> = fi.refs.iter().map(|r| (r.range.start_byte, r.range.end_byte)).collect();
        let n = spans.len();
        spans.sort();
        spans.dedup();
        assert_eq!(spans.len(), n, "every reference spans a distinct identifier");
    }
}
