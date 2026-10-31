//! Where a name under the caret is defined, where a definition is used, and
//! who calls whom — by name and scope, ranked, never by type.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;

use crate::index::{Range, RefKind, Reference, Symbol, SymbolId, SymbolIndex};

/// A use of a symbol. `certain` when scope or an import ties it to this very
/// definition; otherwise the names merely match.
#[derive(Clone, Debug, Serialize)]
pub struct UsageHit {
    pub reference: Reference,
    pub certain: bool,
}

/// One level of a call hierarchy: the call site, and the symbol on the other
/// end of it when the index knows one.
#[derive(Clone, Debug, Serialize)]
pub struct HierarchyNode {
    pub symbol: Option<Symbol>,
    pub reference: Reference,
    pub certain: bool,
}

/// The definitions the identifier at `(line, col)` in `path` may mean, best
/// first. A strict winner — a local, or the file's own import — comes alone;
/// otherwise the caller shows the list.
pub fn definition(index: &SymbolIndex, path: &str, line: u32, col: u32) -> Vec<Symbol> {
    let Some(file) = index.file(path) else { return vec![] };
    // A caret right after the last character still means that name (an
    // editor's position is between characters); a strict hit comes first.
    let at = |r: &Range| contains(r, line, col);
    let strict = file.symbols.iter().any(|s| at(&s.name_range)) || file.refs.iter().any(|x| at(&x.range));
    let after = |r: &Range| !strict && (r.end_line, r.end_col) == (line, col);
    if let Some(s) = file.symbols.iter().find(|s| at(&s.name_range) || after(&s.name_range)) {
        return vec![s.clone()];
    }
    let Some(r) = file.refs.iter().find(|r| at(&r.range) || after(&r.range)) else { return vec![] };
    if r.kind == RefKind::Import {
        return vec![];
    }
    let imports: Vec<&Reference> = file.refs.iter().filter(|r| r.kind == RefKind::Import).collect();
    let scope = chain(index, r.enclosing);
    let mut cands: Vec<(u8, &Symbol)> = index
        .definitions_named(&r.name)
        .filter(|s| s.lang.family() == file.lang.family())
        .map(|s| (rank(s, path, &scope, &imports), s))
        .collect();
    cands.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.path.cmp(&b.1.path)).then_with(|| a.1.range.start_byte.cmp(&b.1.range.start_byte)));
    if cands.len() > 1 && cands[0].0 <= 1 && cands[0].0 < cands[1].0 {
        cands.truncate(1);
    }
    cands.into_iter().map(|(_, s)| s.clone()).collect()
}

/// The best definition for the identifier at the caret, if any.
pub fn symbol_at(index: &SymbolIndex, path: &str, line: u32, col: u32) -> Option<Symbol> {
    definition(index, path, line, col).into_iter().next()
}

/// 0 = defined in a scope around the use, in the same file; 1 = in a file
/// this one imports; 2 = same file; 3 = same directory; 4 = anywhere.
fn rank(s: &Symbol, path: &str, scope: &[SymbolId], imports: &[&Reference]) -> u8 {
    if s.path.as_ref() == path && s.container.is_none_or(|c| scope.contains(&c)) {
        return 0;
    }
    if imports.iter().any(|i| names_file(&i.name, &s.path)) {
        return 1;
    }
    if s.path.as_ref() == path {
        return 2;
    }
    if dir(&s.path) == dir(path) {
        return 3;
    }
    4
}

/// Every use of `s` by name (imports excluded), at most `limit`; the flag
/// says whether more were cut off.
pub fn references(index: &SymbolIndex, s: &Symbol, limit: usize) -> (Vec<UsageHit>, bool) {
    let mut hits = Vec::new();
    let mut truncated = false;
    // Whether a file imports s's file: one scan per file, not per hit.
    let mut imports_it: HashMap<Arc<str>, bool> = HashMap::new();
    for r in index.references_named(&s.name).filter(|r| r.kind != RefKind::Import) {
        let Some(file) = index.file(&r.path) else { continue };
        if file.lang.family() != s.lang.family() {
            continue;
        }
        if hits.len() == limit {
            truncated = true;
            break;
        }
        let imported = *imports_it
            .entry(r.path.clone())
            .or_insert_with(|| file.refs.iter().any(|i| i.kind == RefKind::Import && names_file(&i.name, &s.path)));
        let certain = r.path == s.path
            || imported
            || (matches!(r.receiver.as_deref(), Some("this" | "self")) && s.container.is_some_and(|c| chain(index, r.enclosing).contains(&c)));
        hits.push(UsageHit { reference: r.clone(), certain });
    }
    (hits, truncated)
}

/// Who calls `s`: each call site with the symbol whose body it sits in, at
/// most `limit`; the flag says whether more were cut off.
pub fn callers(index: &SymbolIndex, s: &Symbol, limit: usize) -> (Vec<HierarchyNode>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    for r in index.references_named(&s.name).filter(|r| r.kind == RefKind::Call) {
        let Some(file) = index.file(&r.path) else { continue };
        if file.lang.family() != s.lang.family() {
            continue;
        }
        if out.len() == limit {
            truncated = true;
            break;
        }
        let certain = r.path == s.path || file.refs.iter().any(|i| i.kind == RefKind::Import && names_file(&i.name, &s.path));
        out.push(HierarchyNode { symbol: r.enclosing.and_then(|id| index.symbol(id)).cloned(), reference: r.clone(), certain });
    }
    (out, truncated)
}

/// What `s` calls: every call inside its body, resolved to the best
/// definition; a library call stays a leaf without one.
pub fn callees(index: &SymbolIndex, s: &Symbol) -> Vec<HierarchyNode> {
    let Some(file) = index.file(&s.path) else { return vec![] };
    file.refs
        .iter()
        .filter(|r| r.kind == RefKind::Call && r.range.start_byte >= s.range.start_byte && r.range.end_byte <= s.range.end_byte)
        .map(|r| {
            let symbol = symbol_at(index, &s.path, r.range.start_line, r.range.start_col);
            HierarchyNode { certain: symbol.is_some(), symbol, reference: r.clone() }
        })
        .collect()
}

/// `id` and every container above it.
fn chain(index: &SymbolIndex, id: Option<SymbolId>) -> Vec<SymbolId> {
    let mut out = Vec::new();
    let mut cur = id;
    while let Some(c) = cur {
        if out.contains(&c) {
            break;
        }
        out.push(c);
        cur = index.symbol(c).and_then(|s| s.container);
    }
    out
}

fn contains(r: &Range, line: u32, col: u32) -> bool {
    (r.start_line, r.start_col) <= (line, col) && (line, col) < (r.end_line, r.end_col)
}

fn dir(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Whether an import's text names the file: `./b` and `b.ts`, `.money` and
/// `money.py`, `com.x.Y` and `src/main/java/com/x/Y.java`.
fn names_file(import: &str, path: &str) -> bool {
    // "./b" vs "ab.ts" must not match: the import names a whole path segment.
    let stem = path.rsplit_once('.').map_or(path, |(s, _)| s);
    let dotted = stem.replace('/', ".");
    let mut import = import;
    while let Some(rest) = import.strip_prefix("./").or_else(|| import.strip_prefix("../")) {
        import = rest;
    }
    let import = import.trim_start_matches('.').trim_end_matches(".js");
    let import_dotted = import.replace('/', ".");
    !import_dotted.is_empty() && (dotted == import_dotted || dotted.ends_with(&format!(".{import_dotted}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::walk;
    use crate::index::{RefKind, SymbolIndex, SymbolKind};

    fn index() -> (SymbolIndex, std::path::PathBuf) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/resolve");
        (SymbolIndex::build(&root, &walk(&root).unwrap()), root)
    }

    /// Line and UTF-16 column of the `nth` occurrence of `needle` in the fixture file.
    fn pos(root: &std::path::Path, path: &str, needle: &str, nth: usize) -> (u32, u32) {
        let src = std::fs::read_to_string(root.join(path)).unwrap();
        let byte = src.match_indices(needle).nth(nth).map(|(i, _)| i).unwrap();
        let line = src[..byte].matches('\n').count();
        let line_start = src[..byte].rfind('\n').map_or(0, |i| i + 1);
        (line as u32, src[line_start..byte].encode_utf16().count() as u32)
    }

    #[test]
    fn names_file_matches_whole_segments() {
        assert!(names_file("./b", "b.ts"));
        assert!(names_file("./b", "src/b.ts"));
        assert!(!names_file("./b", "ab.ts"));
        assert!(names_file(".money", "money.py"));
        assert!(names_file("com.x.Y", "src/main/java/com/x/Y.java"));
        assert!(!names_file("com.x.Y", "src/main/java/com/x/YZ.java"));
        assert!(names_file("../util/money.js", "util/money.ts"));
    }

    #[test]
    fn local_beats_global() {
        let (index, root) = index();
        let (l, c) = pos(&root, "a.ts", "fmt(x)", 0);
        let found = definition(&index, "a.ts", l, c);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].path.as_ref(), found[0].kind), ("a.ts", SymbolKind::Function));
    }

    #[test]
    fn import_beats_same_name_elsewhere() {
        let (index, root) = index();
        let (l, c) = pos(&root, "a.ts", "money(x)", 0);
        let found = definition(&index, "a.ts", l, c);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path.as_ref(), "b.ts");
    }

    #[test]
    fn ambiguous_returns_ranked_list() {
        let (index, root) = index();
        let (l, c) = pos(&root, "java/Third.java", "save()", 0);
        let found = definition(&index, "java/Third.java", l, c);
        let paths: Vec<&str> = found.iter().map(|s| s.path.as_ref()).collect();
        assert_eq!(paths, ["java/Dup.java", "java/other/Far.java"]);
    }

    #[test]
    fn definition_outside_an_identifier_is_empty() {
        let (index, root) = index();
        assert!(definition(&index, "java/Dup.java", 0, 0).is_empty(), "the `class` keyword");
        let (l, c) = pos(&root, "a.ts", "\"fmt\"", 0);
        assert!(definition(&index, "a.ts", l, c + 1).is_empty(), "inside a string");
        assert!(definition(&index, "missing.ts", 0, 0).is_empty());
    }

    #[test]
    fn caret_just_past_an_identifier_still_finds_it() {
        let (index, root) = index();
        let (l, c) = pos(&root, "a.ts", "money(x)", 0);
        let found = definition(&index, "a.ts", l, c + 5); // right after "money"
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path.as_ref(), "b.ts");
        assert!(definition(&index, "a.ts", l, c + 6).is_empty(), "inside the parenthesis is not the name");
    }

    #[test]
    fn callers_are_capped() {
        let (index, root) = index();
        let (l, c) = pos(&root, "b.ts", "money", 0);
        let money = symbol_at(&index, "b.ts", l, c).unwrap();
        let (nodes, truncated) = callers(&index, &money, 1);
        assert_eq!((nodes.len(), truncated), (1, true));
        let (nodes, truncated) = callers(&index, &money, 100);
        assert_eq!((nodes.len(), truncated), (2, false));
    }

    #[test]
    fn definition_on_a_definition_returns_itself() {
        let (index, root) = index();
        let (l, c) = pos(&root, "b.ts", "money", 0);
        let found = definition(&index, "b.ts", l, c + 2);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].path.as_ref(), found[0].name.as_ref()), ("b.ts", "money"));
    }

    #[test]
    fn references_marks_certain_and_possible() {
        let (index, root) = index();
        let (l, c) = pos(&root, "b.ts", "money", 0);
        let money = symbol_at(&index, "b.ts", l, c).unwrap();
        let (hits, truncated) = references(&index, &money, 100);
        assert!(!truncated);
        let mut by_path: Vec<(&str, bool)> = hits.iter().map(|h| (h.reference.path.as_ref(), h.certain)).collect();
        by_path.sort();
        assert_eq!(by_path, [("a.ts", true), ("d.ts", false)]);
        assert!(hits.iter().all(|h| h.reference.kind != RefKind::Import));
    }

    #[test]
    fn references_truncates_at_limit() {
        let (index, root) = index();
        let (l, c) = pos(&root, "b.ts", "money", 0);
        let money = symbol_at(&index, "b.ts", l, c).unwrap();
        let (hits, truncated) = references(&index, &money, 1);
        assert_eq!((hits.len(), truncated), (1, true));
    }

    #[test]
    fn callers_group_by_enclosing_symbol() {
        let (index, root) = index();
        let (l, c) = pos(&root, "b.ts", "money", 0);
        let money = symbol_at(&index, "b.ts", l, c).unwrap();
        let mut callers: Vec<(String, String)> = callers(&index, &money, 100)
            .0
            .into_iter()
            .map(|n| (n.symbol.map(|s| s.name.to_string()).unwrap_or_default(), n.reference.path.to_string()))
            .collect();
        callers.sort();
        assert_eq!(callers, [("report".to_string(), "d.ts".to_string()), ("total".to_string(), "a.ts".to_string())]);
    }

    #[test]
    fn callees_resolve_inside_the_body() {
        let (index, root) = index();
        let (l, c) = pos(&root, "a.ts", "total", 0);
        let total = symbol_at(&index, "a.ts", l, c).unwrap();
        let callees = callees(&index, &total);
        let fmt = callees.iter().find(|n| n.reference.name.as_ref() == "fmt").unwrap();
        assert_eq!(fmt.symbol.as_ref().map(|s| s.path.as_ref()), Some("a.ts"));
        assert!(fmt.certain);
        let money = callees.iter().find(|n| n.reference.name.as_ref() == "money").unwrap();
        assert_eq!(money.symbol.as_ref().map(|s| s.path.as_ref()), Some("b.ts"));
    }

    #[test]
    fn callees_unresolved_library_call_has_no_symbol() {
        let (index, root) = index();
        let (l, c) = pos(&root, "a.ts", "total", 0);
        let total = symbol_at(&index, "a.ts", l, c).unwrap();
        let log = callees(&index, &total).into_iter().find(|n| n.reference.name.as_ref() == "log").unwrap();
        assert!(log.symbol.is_none());
        assert!(!log.certain);
    }
}
