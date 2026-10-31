# Code view: an in-app workspace viewer with IDE-style navigation

Date: 2026-10-31

## Goal

A **Code** tab in gitp that works as a quick IDE for the open repository, so
you read, edit and navigate the checked-out project without opening IntelliJ
or VS Code. It must work on any machine with nothing installed beside gitp.

Not a replacement IDE: no build, no debugger, no refactoring, no completion.
If a day's work needs those, you open the real IDE; this is for the ten-minute
look, the small fix, and the "where is this used" question that comes up while
reviewing a diff.

## Decisions made in the conversation

By Phuong:

- **Zero setup.** Navigation comes from parsers bundled in the app, never from
  language servers on the machine.
- **A new top-level Code tab**, next to History and Config, with the file tree
  on the left and the editor on the right.
- Languages: **Java, JavaScript, TypeScript, Python** (TSX/JSX included).
- Features: file tree that follows the filesystem; quick open by fuzzy filename
  (`Cmd/Ctrl+P`); in-memory editing with debounced auto-save, `Cmd/Ctrl+S` and
  an unsaved dot; go to definition (`Cmd/Ctrl+click`, `F12`); back / forward
  through caret history (`Cmd/Ctrl+Alt+Left/Right`); find usages and a
  caller / callee hierarchy; full-text search with regex that skips gitignored
  files, with results that jump to file, line and column.

My calls (say so if any is wrong):

- **Editor: CodeMirror 6, not Monaco.** The webui is plain TypeScript on Vite
  inside a Tauri webview with no framework. Monaco is ~5 MB, wants its own
  worker bundling, and brings a second theme system; CodeMirror is a few
  hundred KB, has maintained Java / JS / TS / Python grammars, and can be
  themed to match gitp's existing highlight.js colours.
- **Symbols: tree-sitter in Rust**, in a new crate `gitp-code`, indexed once
  per repository and kept fresh by the watcher gitp already runs. Navigation is
  name and scope based, so an ambiguous name shows a pick list, as IntelliJ
  does for overloads.
- **Full-text search: the ripgrep crates** (`ignore`, `grep-regex`,
  `grep-searcher`), so gitignore handling, binary detection and speed come
  for free.
- **Auto-save is on and not configurable.** The dot shows between the edit and
  the write. Code-view saves do **not** go through gitp's Undo stack (a save
  every 1.5 s would bury it); recovery is the existing Local History feature.
- **Several files open at once**, as a row of editor tabs above the editor. A
  quick IDE with one file open at a time is not quick.
- **No LSP in this version**, but the index is behind one trait so an LSP
  provider can be added per language later without touching the UI.

## Goals, non-goals, anti-goals

Goals:

- Open any text file in the repository in under 100 ms after the first index.
- Go to definition and find usages answer within 50 ms on a 20k-file repo.
- Edits are never lost: auto-save, local history, and a "changed on disk"
  banner instead of a silent overwrite.
- Everything works offline, on a fresh machine, with no PATH lookups.

Non-goals:

- Completion, diagnostics, rename, formatting, debugging, running tests.
- Type-accurate resolution across files (a method called `save` in three
  classes gives three candidates; that is accepted).
- Languages beyond the four. Other files open with plain-text highlighting and
  no navigation.
- Editing files larger than `EDIT_MAX_BYTES` (same limit as today's editor).

Anti-goals (it has failed even if it works):

- The History tab gets slower because the index runs on the same thread or
  lock as git operations.
- A keystroke lags because indexing or search blocks the webview.
- A navigation jump lands on the wrong line after an edit (stale ranges).

## Constraints

- Tauri 2, Rust backend, TypeScript webui without a framework, Vite build,
  vitest with happy-dom for frontend tests, `cargo test` for the backend.
- Backend needs a C compiler already (vendored libgit2); tree-sitter grammars
  add C sources but no new toolchain.
- All backend file access goes through the repository's workdir; paths are
  repository-relative strings as everywhere else in gitp.
- Keep the gitp shortcut rules: avoid Cmd combos WebKit owns (see
  `shortcuts.ts`). `Cmd+P` (print) is safe to take over in the webview;
  `Cmd+K` stays Quick Launch.

## Architecture

```
 webui (TypeScript)                              backend (Rust)
 ┌─────────────────────────────────────┐          ┌─────────────────────────────┐
 │ views/code.ts        Code tab shell │  invoke  │ gitp-gui/src/code.rs        │
 │  ├ code/explorer.ts  file tree      │ ───────► │  Tauri commands, per-repo   │
 │  ├ code/editor.ts    CodeMirror     │          │  CodeState (index + files)  │
 │  ├ code/tabs.ts      open files     │ ◄─────── │                             │
 │  ├ code/nav-stack.ts back/forward   │  events  │ gitp-code crate             │
 │  ├ code/quick-open.ts Cmd+P         │          │  ├ files.rs   walk + ignore │
 │  ├ code/search.ts    Cmd+Shift+F    │          │  ├ index.rs   SymbolIndex   │
 │  ├ code/usages.ts    usages + tree  │          │  ├ lang/      tree-sitter   │
 │  └ code/shortcuts.ts key bindings   │          │  ├ resolve.rs definition    │
 │ api.ts  (+ code* wrappers)          │          │  └ grep.rs    full-text     │
 └─────────────────────────────────────┘          └─────────────────────────────┘
                                                   watch.rs ──► reindex(paths)
```

### Why local AST parsing instead of LSP (the recommendation)

| | LSP servers | tree-sitter in-process |
|---|---|---|
| Setup | per-language binary on PATH, JDT needs a JDK | nothing |
| Accuracy | type-aware | syntax + scope heuristics |
| Cold start | pyright ~1 s, tsserver ~2 s, jdtls 5–30 s | full index of 20k files in ~1–2 s, then incremental |
| Memory | 200 MB–1 GB per server | tens of MB |
| Multi-language | one client per server, four processes | one index, four grammars |

For "quick IDE, no setup" the right side wins. The one place accuracy hurts
(same method name in several classes) is handled with a candidate list ranked
by scope, imports and proximity, which is what IntelliJ shows for overloads
anyway. The `SymbolProvider` trait keeps the door open: a later
`LspProvider` can wrap the same `definition / references / hierarchy` calls
when a server is present and fall back to the index when it is not.

### Backend: `crates/gitp-code`

A library crate with no git or Tauri dependency, so it tests in isolation.

**`files.rs`** — walk the workdir with `ignore::WalkBuilder` (gitignore,
global excludes, `.git/info/exclude`; dotfiles shown, only `.git` itself skipped).
Returns `Vec<FileEntry { path, size, lang: Option<Lang> }>`. Used for the
explorer, quick open, the first index, and as the search file set.

**`lang/`** — one module per language with the tree-sitter grammar and two
queries written as `.scm` files compiled in with `include_str!`:

- `defs.scm`: definitions. Captures `@def.function`, `@def.method`,
  `@def.class`, `@def.interface`, `@def.enum`, `@def.variable`,
  `@def.field`, each with `@name` and the node that spans the whole body.
- `refs.scm`: references. `@ref.call` (call expressions, `new`), `@ref.ident`
  (other identifiers), `@ref.import` (import paths / module names).

`Lang::from_path` maps extensions: `.java`; `.js .mjs .cjs .jsx`; `.ts .mts
.cts .tsx` (two grammars: `typescript`, `tsx`); `.py .pyi`.

**`index.rs`** — `SymbolIndex`:

```rust
pub struct Symbol {
    pub id: SymbolId,            // (file_id, byte_offset) — stable per parse
    pub name: String,
    pub kind: SymbolKind,        // Function | Method | Class | Interface | Enum | Variable | Field
    pub path: String,            // repo-relative
    pub range: Range,            // whole definition, line/col (0-based) + byte
    pub name_range: Range,       // just the identifier, where the caret lands
    pub container: Option<SymbolId>, // enclosing class / function
    pub lang: Lang,
}

pub struct Reference {
    pub name: String,
    pub kind: RefKind,           // Call | Ident | Import
    pub path: String,
    pub range: Range,
    pub enclosing: Option<SymbolId>, // the symbol whose body contains it
    pub receiver: Option<String>,    // `foo` in `foo.save()`, `self`/`this` kept
}

pub struct FileIndex {
    pub path: String,
    pub lang: Lang,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Reference>,
    pub imports: Vec<Import>,    // what the file pulls in and from where
    pub mtime: SystemTime,
}

pub struct SymbolIndex {
    files: HashMap<String, FileIndex>,
    by_name: HashMap<String, Vec<SymbolId>>,   // definitions
    refs_by_name: HashMap<String, Vec<RefId>>, // references
}
```

Build: parse every supported file on a rayon pool, each producing a
`FileIndex`; merge into the maps. Update: `reindex(paths)` re-parses only
those files and replaces their entries (remove old ids from the name maps,
insert new). Delete: drop the file. Tree-sitter's incremental parse is **not**
used; files are re-parsed whole on save, which is a few ms for any file we
would open.

**`resolve.rs`** — `definition(path, line, col) -> Vec<Symbol>`:

1. Find the identifier under the caret in `files[path].refs` (or a definition,
   in which case return it).
2. Candidates = `by_name[name]`.
3. Rank, best first:
   - defined in the same file, innermost enclosing scope that contains the
     caret (local variables, same-class methods);
   - defined in a file the current file imports, when the import names it
     (`import { X } from "./y"`, `from a.b import X`, `import com.x.Y`), or
     when a Java import's package maps to the directory by the usual
     `src/main/java/com/x/Y.java` convention;
   - same directory;
   - same language;
   - everything else, alphabetical by path.
4. When the top candidate is a strict winner (local, or named by an import),
   return just it; otherwise return the ranked list and the UI shows a picker.

`references(symbol) -> Vec<Reference>`: `refs_by_name[name]`, filtered to the
same language, with `receiver` kept so the UI can group "certain" (same file,
imported, or `this`/`self` inside the container) from "possible" (name match
only).

`callers(symbol)`: references of kind `Call` from `references()`, grouped by
`enclosing`. `callees(symbol)`: `Call` refs whose range lies inside
`symbol.range`, resolved with `definition` (top candidate only) — unresolved
calls (library code) are listed as leaves with no children.

**`grep.rs`** — `search(root, query: Query, limit) -> SearchResult`:

```rust
pub struct Query { pub pattern: String, pub regex: bool, pub case_sensitive: bool, pub whole_word: bool, pub include_glob: Option<String> }
pub struct Hit { pub path: String, pub line: u32, pub col: u32, pub end_col: u32, pub text: String }  // text = the whole line, trimmed to 400 chars
pub struct SearchResult { pub hits: Vec<Hit>, pub truncated: bool, pub files_searched: u32 }
```

`grep-regex` builds the matcher (`regex_syntax::escape` when not regex),
`grep-searcher` runs it per file from the `ignore` walk in parallel; binary
files are skipped by the searcher's default NUL detection. Stops at `limit`
hits (2 000) and reports `truncated`. A `CancelToken` (an `AtomicBool`) is
checked per file so a newer query aborts the older one.

### Backend: `crates/gitp-gui/src/code.rs`

One `CodeState` per open repository, held beside `RepoState`, created lazily
the first time the Code tab opens (so repositories you never browse cost
nothing):

```rust
pub(crate) struct CodeState {
    index: Arc<RwLock<SymbolIndex>>,
    files: Arc<RwLock<Vec<FileEntry>>>,
    indexing: Arc<AtomicBool>,
    search_cancel: Arc<AtomicBool>,
}
```

Commands (all take the active repo from `RepoState` like every other command):

| command | returns | notes |
|---|---|---|
| `code_open_workspace` | `{ files: FileEntry[], indexing: true }` | starts the index on a thread; emits `code-index-ready { symbols, files, ms }` when done |
| `code_list_files` | `FileEntry[]` | after a watcher change |
| `code_read_file(path)` | `TextFile \| null` | existing `Repo::read_text_file` |
| `code_write_file(path, text, crlf)` | `()` | `Repo::write_text_file` **without** `with_recorded_files`, then `reindex([path])` |
| `code_definition(path, line, col)` | `Symbol[]` | ranked |
| `code_references(path, line, col)` | `{ symbol, refs: Reference[] }` | |
| `code_callers(symbolId)` / `code_callees(symbolId)` | `HierarchyNode[]` | one level; UI expands lazily |
| `code_search(query, limit)` | `SearchResult` | cancels the previous |
| `code_file_symbols(path)` | `Symbol[]` | for the editor's breadcrumb and `Cmd+Shift+O` later; cheap, include now |

Watcher: `watch.rs` already classifies `Change::Worktree(path)`. Add a second
sink: when a `CodeState` exists for the repo, hand the batch's worktree paths
to it — `reindex` for supported files, refresh `files` when a path was
created or deleted — then emit `code-files-changed { paths }` so the
explorer, open tabs and the index-dependent panels refresh. The existing
`repo-changed` event is untouched.

### Frontend

**`views/code.ts`** — the tab: three-column layout (explorer | editor with
tabs | bottom panel for search / usages / hierarchy, collapsible), wired
into `showView("code")`, `View` union, and a `data-tab="code"` button in
`index.html`. Uses the existing `resizers.ts` for the splitters.

**`code/explorer.ts`** — lazy tree built from `FileEntry[]`: folders expand on
click, files open on click, the open file is revealed and highlighted
(IntelliJ's "autoscroll from source"). Folders sorted before files,
case-insensitive. A gitignored folder is simply absent (the walk skipped it).
Not `views/tree.ts`: that one is the checkbox tree for staging and shares no
behaviour.

**`code/editor.ts`** — one `EditorView` per open file, kept alive in a
`Map<path, EditorState>` so switching tabs restores scroll and caret.
Extensions: `basicSetup` minus autocompletion and lint, the language
extension by `Lang`, a theme built from gitp's CSS variables, `EditorView.
updateListener` for dirty tracking and the auto-save debounce (1 500 ms
idle), a `Cmd/Ctrl+click` handler and `F12` keymap for definition, a
`ViewPlugin` that underlines the identifier under the pointer while the
modifier is held. Line endings: keep `TextFile.crlf` and pass it back on
write, as `file-editor.ts` does.

**`code/tabs.ts`** — ordered open files, active one, dirty set, "changed on
disk" set. Middle-click or `×` closes; closing a dirty tab saves first
(auto-save is on, so there is nothing to ask). A file deleted on disk keeps
its tab with a strikethrough name and read-only editor until closed.

**`code/nav-stack.ts`** — `Location { path, line, col }`, a `history[]`
with a `cursor`. Push on every jump (definition, usage, search hit, quick
open, explorer click) and on a caret move of more than 10 lines inside one
file (IntelliJ's rule, so scrolling and reading leave breadcrumbs but
typing does not). Pushing truncates anything after the cursor. Back /
forward move the cursor and open the location without pushing. Entries for
a closed file stay; opening them reopens the file. Cap: 100.

**`code/quick-open.ts`** — `Cmd/Ctrl+P`: overlay with the fuzzy filter from
Quick Launch's filtering (lifted into `fuzzy.ts` so both share it: subsequence
match, scored by consecutive runs, path-segment starts and filename matches
over directory matches). Shows the 50 best with the matched characters
bold. Enter opens, `Cmd/Ctrl+Enter` opens and reveals in the explorer.

**`code/search.ts`** — `Cmd/Ctrl+Shift+F`: query box with Regex, Match
case, Whole word toggles and an include glob; results grouped by file with
the match highlighted inside the line; click or Enter jumps and selects the
match. Debounced 250 ms; a newer query drops older responses by a sequence
number even when the backend has not cancelled yet. "2 000 hits, narrowed"
when truncated.

**`code/usages.ts`** — Find Usages (`Alt+F7`, and the context menu) lists
`Reference`s grouped by file, "certain" above "possible". Call Hierarchy
(`Ctrl+Alt+H`) shows a tree with a Callers / Callees switch, each node
expanded lazily by `code_callers` / `code_callees`, cycle-safe by marking a
symbol already on the path as a leaf.

**`code/shortcuts.ts`** — bindings scoped to the Code tab, added to the
existing `SHORTCUTS` pack under a new group "Code" so the cheat sheet lists
them. The pack's `Keys` gains an optional `alt?: boolean` and arrow keys.

| action | keys |
|---|---|
| Quick open file | `Mod+P` |
| Find in files | `Mod+Shift+F` |
| Save | `Mod+S` |
| Go to definition | `F12`, `Mod+click` |
| Back / forward | `Mod+Alt+Left` / `Mod+Alt+Right` |
| Find usages | `Alt+F7` |
| Call hierarchy | `Ctrl+Alt+H` |
| Close tab | `Mod+W` is owned by the window; use `Mod+Shift+W` |
| Code tab | `Mod+Shift+E` (next to History `Mod+Shift+H`, Changes `Mod+Shift+C`) |

### Data flow for one "go to definition"

1. `Cmd+click` → editor gives `(path, line, col)`.
2. `api.codeDefinition` → backend `resolve::definition`.
3. One result: `navStack.push(current)`, `tabs.open(result.path)`,
   `editor.reveal(result.name_range)`.
4. Several: a small popup at the caret (reuse `choice-dialog` style, keyboard
   navigable), with `path:line` and the container; pick → step 3.
5. None: a toast "No definition found for `name`".

## Step-by-step implementation plan

Each step ends with a check a reviewer can run.

1. **Crate `gitp-code` with `files.rs`** → `cargo test -p gitp-code`: a temp
   dir with a `.gitignore` lists the right files, skips `.git` and `node_modules`.
2. **Language modules and queries** for the four grammars → tests parse a
   fixture per language and assert the symbols and references extracted
   (function, method, class, field, call, import).
3. **`SymbolIndex` build and `reindex`** → test: index three files, edit one,
   reindex, the old symbol is gone and the new one found; `by_name` has no
   dangling ids.
4. **`resolve.rs`** → tests for each rank rule: local wins over global,
   import wins over same-name elsewhere, ambiguous returns a ranked list,
   callers / callees for a small Java and a small TS fixture.
5. **`grep.rs`** → tests: literal, regex, case, whole word, gitignored file
   not searched, binary skipped, limit truncates, cancel stops early.
6. **`code.rs` commands and `CodeState`**, registered in `lib.rs`; watcher
   sink → a command-layer test (like `test_support.rs` ones) opens a fixture
   repo, writes a file, and sees the index updated.
7. **CodeMirror setup** (`npm i codemirror @codemirror/lang-java
   @codemirror/lang-javascript @codemirror/lang-python`), `code/editor.ts`
   with highlighting, dirty dot, auto-save, `Cmd+S` → vitest for the dirty /
   save state machine (editor behind an interface so happy-dom suffices).
8. **Code tab shell, explorer, tabs** → vitest for explorer tree building and
   tab ordering; manual check that the tab opens, files open, edits save.
9. **Nav stack + go to definition + picker** → vitest for the stack rules
   (push, truncate, 10-line rule, cap); manual check `Cmd+click`, `F12`,
   back / forward.
10. **Quick open with shared `fuzzy.ts`** → vitest for scoring order; Quick
    Launch's existing tests still pass after the lift.
11. **Find in files panel** → vitest for grouping and stale-response
    dropping; manual check regex and jump-to-column.
12. **Usages and call hierarchy panel** → vitest for the tree model (lazy
    expand, cycle guard); manual check on gitp's own webui.
13. **Shortcuts, cheat sheet, settings-free polish**, "changed on disk"
    banner, deleted-file tab → `npm run typecheck && npm run lint && npm test`,
    `cargo test --workspace`.

Steps 1–5 are pure library work and can run in parallel with 7–8 once the
`FileEntry` / `Symbol` / `Reference` / `Hit` shapes in `types.ts` are agreed
(they are, above).

## Scaffolding

Reference code the builder starts from. It compiles in spirit, not
necessarily to the byte; names are the ones used above.

### `crates/gitp-code/Cargo.toml`

```toml
[package]
name = "gitp-code"
version = "0.1.0"
edition = "2021"

[dependencies]
ignore = "0.4"
grep-regex = "0.1"
grep-searcher = "0.1"
grep-matcher = "0.1"
rayon = "1"
serde = { version = "1", features = ["derive"] }
tree-sitter = "0.25"
tree-sitter-java = "0.23"
tree-sitter-javascript = "0.23"
tree-sitter-typescript = "0.23"
tree-sitter-python = "0.23"

[dev-dependencies]
tempfile = "3"
```

### `crates/gitp-code/src/lang/mod.rs`

```rust
use tree_sitter::{Language, Query};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang { Java, JavaScript, TypeScript, Tsx, Python }

pub struct LangDef {
    pub lang: Lang,
    pub language: Language,
    pub defs: Query,
    pub refs: Query,
}

impl Lang {
    pub fn from_path(path: &str) -> Option<Lang> {
        let ext = path.rsplit('.').next()?;
        Some(match ext {
            "java" => Lang::Java,
            "js" | "mjs" | "cjs" | "jsx" => Lang::JavaScript,
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "py" | "pyi" => Lang::Python,
            _ => return None,
        })
    }

    pub fn def(self) -> &'static LangDef {
        // One OnceLock per language; queries are compiled once per process.
        match self {
            Lang::Java => java::DEF.get_or_init(java::load),
            Lang::JavaScript => javascript::DEF.get_or_init(javascript::load),
            Lang::TypeScript => typescript::DEF.get_or_init(typescript::load_ts),
            Lang::Tsx => typescript::DEF_TSX.get_or_init(typescript::load_tsx),
            Lang::Python => python::DEF.get_or_init(python::load),
        }
    }
}

pub mod java {
    use super::*;
    use std::sync::OnceLock;
    pub static DEF: OnceLock<LangDef> = OnceLock::new();
    pub fn load() -> LangDef {
        let language: Language = tree_sitter_java::LANGUAGE.into();
        LangDef {
            lang: Lang::Java,
            defs: Query::new(&language, include_str!("java/defs.scm")).expect("java defs.scm"),
            refs: Query::new(&language, include_str!("java/refs.scm")).expect("java refs.scm"),
            language,
        }
    }
}
// javascript, typescript (two grammars), python follow the same shape.
```

### `crates/gitp-code/src/lang/java/defs.scm`

```scheme
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @def.field
(local_variable_declaration declarator: (variable_declarator name: (identifier) @name)) @def.variable
(formal_parameter name: (identifier) @name) @def.variable
```

### `crates/gitp-code/src/lang/java/refs.scm`

```scheme
(method_invocation name: (identifier) @name object: (_)? @receiver) @ref.call
(object_creation_expression type: (type_identifier) @name) @ref.call
(import_declaration (scoped_identifier) @name) @ref.import
(type_identifier) @name @ref.ident
(identifier) @name @ref.ident
```

TypeScript's `defs.scm` captures `function_declaration`, `method_definition`,
`class_declaration`, `interface_declaration`, `enum_declaration`,
`type_alias_declaration`, `variable_declarator` (with `arrow_function` /
`function` values counted as functions), `public_field_definition`;
`refs.scm` captures `call_expression function: (identifier)`,
`call_expression function: (member_expression property: …)`,
`new_expression`, `import_statement`. Python: `function_definition`,
`class_definition`, `assignment left: (identifier)` at module or class level,
`parameters`; refs: `call function: (identifier | attribute)`,
`import_statement`, `import_from_statement`.

### `crates/gitp-code/src/index.rs` (core of the extractor)

```rust
use std::collections::HashMap;
use tree_sitter::{Parser, QueryCursor, StreamingIterator};
use crate::lang::Lang;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
pub struct SymbolId { pub file: u32, pub byte: u32 }

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind { Function, Method, Class, Interface, Enum, Variable, Field }

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Range { pub start_line: u32, pub start_col: u32, pub end_line: u32, pub end_col: u32, pub start_byte: u32, pub end_byte: u32 }

#[derive(Clone, Debug, serde::Serialize)]
pub struct Symbol {
    pub id: SymbolId,
    pub name: String,
    pub kind: SymbolKind,
    pub path: String,
    pub range: Range,
    pub name_range: Range,
    pub container: Option<SymbolId>,
    pub lang: Lang,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind { Call, Ident, Import }

#[derive(Clone, Debug, serde::Serialize)]
pub struct Reference {
    pub name: String,
    pub kind: RefKind,
    pub path: String,
    pub range: Range,
    pub enclosing: Option<SymbolId>,
    pub receiver: Option<String>,
}

pub struct FileIndex {
    pub path: String,
    pub lang: Lang,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Reference>,
}

pub fn index_file(file_id: u32, path: &str, lang: Lang, source: &[u8]) -> FileIndex {
    let def = lang.def();
    let mut parser = Parser::new();
    parser.set_language(&def.language).expect("grammar");
    let tree = parser.parse(source, None).expect("parse never fails without a timeout");
    let root = tree.root_node();

    let name_idx = |q: &tree_sitter::Query| q.capture_index_for_name("name").unwrap();
    let mut symbols = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&def.defs, root, source);
    while let Some(m) = matches.next() {
        let Some(name_cap) = m.captures.iter().find(|c| c.index == name_idx(&def.defs)) else { continue };
        let Some(body_cap) = m.captures.iter().find(|c| c.index != name_idx(&def.defs)) else { continue };
        let kind = match def.defs.capture_names()[body_cap.index as usize] {
            "def.function" => SymbolKind::Function,
            "def.method" => SymbolKind::Method,
            "def.class" => SymbolKind::Class,
            "def.interface" => SymbolKind::Interface,
            "def.enum" => SymbolKind::Enum,
            "def.field" => SymbolKind::Field,
            _ => SymbolKind::Variable,
        };
        symbols.push(Symbol {
            id: SymbolId { file: file_id, byte: body_cap.node.start_byte() as u32 },
            name: name_cap.node.utf8_text(source).unwrap_or("").to_string(),
            kind,
            path: path.to_string(),
            range: range_of(body_cap.node),
            name_range: range_of(name_cap.node),
            container: None, // filled below
            lang,
        });
    }
    // Containers: the innermost other symbol whose range strictly contains this one.
    symbols.sort_by_key(|s| (s.range.start_byte, std::cmp::Reverse(s.range.end_byte)));
    let spans: Vec<(u32, u32, SymbolId)> = symbols.iter().map(|s| (s.range.start_byte, s.range.end_byte, s.id)).collect();
    for s in &mut symbols {
        s.container = spans.iter().rev()
            .find(|(a, b, id)| *id != s.id && *a <= s.range.start_byte && s.range.end_byte <= *b)
            .map(|(_, _, id)| *id);
    }
    let enclosing = |byte: u32| spans.iter().rev().find(|(a, b, _)| *a <= byte && byte < *b).map(|(_, _, id)| *id);

    let mut refs = Vec::new();
    let mut matches = cursor.matches(&def.refs, root, source);
    while let Some(m) = matches.next() {
        let Some(name_cap) = m.captures.iter().find(|c| c.index == name_idx(&def.refs)) else { continue };
        let kind = m.captures.iter().find_map(|c| match def.refs.capture_names()[c.index as usize] {
            "ref.call" => Some(RefKind::Call),
            "ref.import" => Some(RefKind::Import),
            "ref.ident" => Some(RefKind::Ident),
            _ => None,
        }).unwrap_or(RefKind::Ident);
        let receiver = m.captures.iter()
            .find(|c| def.refs.capture_names()[c.index as usize] == "receiver")
            .and_then(|c| c.node.utf8_text(source).ok())
            .map(str::to_string);
        refs.push(Reference {
            name: name_cap.node.utf8_text(source).unwrap_or("").to_string(),
            kind,
            path: path.to_string(),
            range: range_of(name_cap.node),
            enclosing: enclosing(name_cap.node.start_byte() as u32),
            receiver,
        });
    }
    // An identifier that is itself a definition's name is not a reference.
    let def_names: std::collections::HashSet<(u32, u32)> =
        symbols.iter().map(|s| (s.name_range.start_byte, s.name_range.end_byte)).collect();
    refs.retain(|r| !def_names.contains(&(r.range.start_byte, r.range.end_byte)));

    FileIndex { path: path.to_string(), lang, symbols, refs }
}

fn range_of(n: tree_sitter::Node) -> Range {
    let (s, e) = (n.start_position(), n.end_position());
    Range { start_line: s.row as u32, start_col: s.column as u32, end_line: e.row as u32, end_col: e.column as u32,
            start_byte: n.start_byte() as u32, end_byte: n.end_byte() as u32 }
}

#[derive(Default)]
pub struct SymbolIndex {
    files: HashMap<String, FileIndex>,
    ids: HashMap<String, u32>,
    by_name: HashMap<String, Vec<SymbolId>>,
    refs_by_name: HashMap<String, Vec<(String, usize)>>, // (path, index into refs)
}

impl SymbolIndex {
    pub fn build(root: &std::path::Path, files: &[crate::files::FileEntry]) -> Self {
        use rayon::prelude::*;
        let parsed: Vec<FileIndex> = files.par_iter().enumerate()
            .filter_map(|(i, f)| {
                let lang = f.lang?;
                let src = std::fs::read(root.join(&f.path)).ok()?;
                Some(index_file(i as u32, &f.path, lang, &src))
            })
            .collect();
        let mut index = SymbolIndex::default();
        for fi in parsed { index.insert(fi); }
        index
    }

    pub fn reindex(&mut self, root: &std::path::Path, path: &str) {
        self.remove(path);
        let Some(lang) = Lang::from_path(path) else { return };
        let Ok(src) = std::fs::read(root.join(path)) else { return };
        let id = *self.ids.entry(path.to_string()).or_insert_with(|| self.ids.len() as u32);
        self.insert(index_file(id, path, lang, &src));
    }

    pub fn remove(&mut self, path: &str) {
        let Some(old) = self.files.remove(path) else { return };
        for s in &old.symbols {
            if let Some(v) = self.by_name.get_mut(&s.name) { v.retain(|id| *id != s.id); }
        }
        for r in &old.refs {
            if let Some(v) = self.refs_by_name.get_mut(&r.name) { v.retain(|(p, _)| p != path); }
        }
    }

    fn insert(&mut self, fi: FileIndex) {
        for s in &fi.symbols { self.by_name.entry(s.name.clone()).or_default().push(s.id); }
        for (i, r) in fi.refs.iter().enumerate() { self.refs_by_name.entry(r.name.clone()).or_default().push((fi.path.clone(), i)); }
        self.files.insert(fi.path.clone(), fi);
    }

    pub fn symbol(&self, id: SymbolId) -> Option<&Symbol> {
        self.files.values().find(|f| f.symbols.first().is_some_and(|s| s.id.file == id.file))
            .and_then(|f| f.symbols.iter().find(|s| s.id == id))
    }
    pub fn file(&self, path: &str) -> Option<&FileIndex> { self.files.get(path) }
    pub fn definitions_named(&self, name: &str) -> impl Iterator<Item = &Symbol> {
        self.by_name.get(name).into_iter().flatten().filter_map(move |id| self.symbol(*id))
    }
    pub fn references_named(&self, name: &str) -> impl Iterator<Item = &Reference> {
        self.refs_by_name.get(name).into_iter().flatten()
            .filter_map(move |(p, i)| self.files.get(p).and_then(|f| f.refs.get(*i)))
    }
}
```

(`symbol()` as written scans files; the builder keeps a `HashMap<u32,
String>` from file id to path to make it O(1). Left in for brevity.)

### `crates/gitp-code/src/resolve.rs`

```rust
use crate::index::{Reference, RefKind, Symbol, SymbolId, SymbolIndex};

pub fn definition(index: &SymbolIndex, path: &str, line: u32, col: u32) -> Vec<Symbol> {
    let Some(file) = index.file(path) else { return vec![] };
    // A click on a definition's own name goes nowhere but itself.
    if let Some(s) = file.symbols.iter().find(|s| contains(&s.name_range, line, col)) {
        return vec![s.clone()];
    }
    let Some(r) = file.refs.iter().find(|r| contains(&r.range, line, col)) else { return vec![] };
    let imports: Vec<&Reference> = file.refs.iter().filter(|r| r.kind == RefKind::Import).collect();
    let mut cands: Vec<(u8, &Symbol)> = index.definitions_named(&r.name)
        .filter(|s| s.lang.family() == file.lang.family())
        .map(|s| (rank(s, path, r, &imports), s))
        .collect();
    cands.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.path.cmp(&b.1.path)));
    // A strict local or import winner stands alone.
    if cands.len() > 1 && cands[0].0 <= 1 && cands[1].0 > 1 { cands.truncate(1); }
    cands.into_iter().map(|(_, s)| s.clone()).collect()
}

/// 0 = same file & encloses the use, 1 = named by an import, 2 = same file,
/// 3 = same directory, 4 = anywhere.
fn rank(s: &Symbol, path: &str, r: &Reference, imports: &[&Reference]) -> u8 {
    if s.path == path && s.container.map_or(true, |c| r.enclosing == Some(c)) { return 0; }
    if imports.iter().any(|i| names_file(&i.name, &s.path) || i.name.ends_with(&s.name)) { return 1; }
    if s.path == path { return 2; }
    if dir(&s.path) == dir(path) { return 3; }
    4
}

pub fn references<'a>(index: &'a SymbolIndex, s: &Symbol) -> Vec<&'a Reference> {
    index.references_named(&s.name).filter(|r| r.kind != RefKind::Import).collect()
}

pub fn callers(index: &SymbolIndex, s: &Symbol) -> Vec<(Option<SymbolId>, Reference)> {
    references(index, s).into_iter().filter(|r| r.kind == RefKind::Call).map(|r| (r.enclosing, r.clone())).collect()
}

pub fn callees(index: &SymbolIndex, s: &Symbol) -> Vec<(Reference, Option<Symbol>)> {
    let Some(file) = index.file(&s.path) else { return vec![] };
    file.refs.iter()
        .filter(|r| r.kind == RefKind::Call && r.range.start_byte >= s.range.start_byte && r.range.end_byte <= s.range.end_byte)
        .map(|r| (r.clone(), definition(index, &s.path, r.range.start_line, r.range.start_col).into_iter().next()))
        .collect()
}

fn contains(r: &crate::index::Range, line: u32, col: u32) -> bool {
    (r.start_line, r.start_col) <= (line, col) && (line, col) < (r.end_line, r.end_col)
}
fn dir(p: &str) -> &str { p.rsplit_once('/').map_or("", |(d, _)| d) }
/// `./y`, `a.b.y`, `com.x.Y` name the file `…/y.ts`, `a/b/y.py`, `com/x/Y.java`.
fn names_file(import: &str, path: &str) -> bool {
    let stem = path.rsplit_once('.').map_or(path, |(s, _)| s);
    let dotted = stem.replace('/', ".");
    dotted.ends_with(import.trim_start_matches("./")) || import.trim_start_matches("./").ends_with(stem.rsplit('/').next().unwrap_or(stem))
}
```

### `crates/gitp-code/src/grep.rs`

```rust
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::UTF8, BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;

#[derive(serde::Deserialize)]
pub struct Query { pub pattern: String, pub regex: bool, pub case_sensitive: bool, pub whole_word: bool, pub include_glob: Option<String> }
#[derive(serde::Serialize, Clone)]
pub struct Hit { pub path: String, pub line: u32, pub col: u32, pub end_col: u32, pub text: String }
#[derive(serde::Serialize)]
pub struct SearchResult { pub hits: Vec<Hit>, pub truncated: bool, pub files_searched: u32 }

pub fn search(root: &std::path::Path, q: &Query, limit: usize, cancel: Arc<AtomicBool>) -> Result<SearchResult, String> {
    let mut pattern = if q.regex { q.pattern.clone() } else { regex_syntax::escape(&q.pattern) };
    if q.whole_word { pattern = format!(r"\b(?:{pattern})\b"); }
    let matcher = RegexMatcherBuilder::new().case_insensitive(!q.case_sensitive).build(&pattern).map_err(|e| e.to_string())?;
    let hits = Arc::new(Mutex::new(Vec::<Hit>::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let files = Arc::new(AtomicUsize::new(0));
    let mut walk = WalkBuilder::new(root);
    walk.hidden(true).git_ignore(true).git_global(true).git_exclude(true);
    if let Some(g) = &q.include_glob {
        let mut ov = ignore::overrides::OverrideBuilder::new(root);
        ov.add(g).map_err(|e| e.to_string())?;
        walk.overrides(ov.build().map_err(|e| e.to_string())?);
    }
    walk.build_parallel().run(|| {
        let (matcher, hits, count, files, cancel) = (matcher.clone(), hits.clone(), count.clone(), files.clone(), cancel.clone());
        let mut searcher = SearcherBuilder::new().binary_detection(BinaryDetection::quit(b'\x00')).line_number(true).build();
        Box::new(move |entry| {
            use ignore::WalkState::*;
            if cancel.load(Ordering::Relaxed) || count.load(Ordering::Relaxed) >= limit { return Quit; }
            let Ok(entry) = entry else { return Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) { return Continue; }
            files.fetch_add(1, Ordering::Relaxed);
            let rel = entry.path().strip_prefix(root).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
            let _ = searcher.search_path(&matcher, entry.path(), UTF8(|line_no, line| {
                use grep_matcher::Matcher;
                let mut start = 0;
                while let Ok(Some(m)) = matcher.find_at(line.as_bytes(), start) {
                    if count.fetch_add(1, Ordering::Relaxed) >= limit { return Ok(false); }
                    hits.lock().unwrap().push(Hit {
                        path: rel.clone(), line: line_no as u32 - 1,
                        col: line[..m.start()].chars().count() as u32,
                        end_col: line[..m.end()].chars().count() as u32,
                        text: line.trim_end().chars().take(400).collect(),
                    });
                    start = m.end().max(start + 1);
                }
                Ok(true)
            }));
            Continue
        })
    });
    let mut hits = Arc::try_unwrap(hits).map(|m| m.into_inner().unwrap()).unwrap_or_default();
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)).then(a.col.cmp(&b.col)));
    let truncated = hits.len() > limit;
    hits.truncate(limit);
    Ok(SearchResult { hits, truncated, files_searched: files.load(Ordering::Relaxed) as u32 })
}
```

### `crates/gitp-gui/src/code.rs` (command bridge)

```rust
//! The Code tab's commands: workspace files, the symbol index, definition /
//! usages / call hierarchy, and full-text search. One `CodeState` per open
//! repository, made the first time the tab opens.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use gitp_code::{files::FileEntry, grep, index::{Symbol, SymbolIndex}, resolve};
use tauri::{AppHandle, Emitter, State};
use crate::state::{with_repo, RepoState};

pub(crate) struct CodeState {
    pub(crate) index: Arc<RwLock<SymbolIndex>>,
    pub(crate) files: Arc<RwLock<Vec<FileEntry>>>,
    pub(crate) search_cancel: Arc<AtomicBool>,
}

#[derive(serde::Serialize)]
pub(crate) struct Workspace { files: Vec<FileEntry>, indexing: bool }

#[tauri::command]
pub(crate) fn code_open_workspace(app: AppHandle, state: State<'_, RepoState>) -> Result<Workspace, String> {
    let root = with_repo(&state, |repo| repo.workdir_path().map(|p| p.to_path_buf()))?;
    let code = state.code_state_or_init();           // creates CodeState once per repo
    let files = gitp_code::files::walk(&root)?;
    *code.files.write().unwrap() = files.clone();
    let (index, files_for_thread) = (code.index.clone(), files.clone());
    std::thread::spawn(move || {
        let t = std::time::Instant::now();
        let built = SymbolIndex::build(&root, &files_for_thread);
        let symbols = built.symbol_count();
        *index.write().unwrap() = built;
        let _ = app.emit("code-index-ready", serde_json::json!({ "symbols": symbols, "files": files_for_thread.len(), "ms": t.elapsed().as_millis() }));
    });
    Ok(Workspace { files, indexing: true })
}

#[tauri::command]
pub(crate) fn code_definition(state: State<'_, RepoState>, path: String, line: u32, col: u32) -> Result<Vec<Symbol>, String> {
    let code = state.code_state().ok_or("Code tab not open")?;
    let index = code.index.read().unwrap();
    Ok(resolve::definition(&index, &path, line, col))
}

#[tauri::command]
pub(crate) fn code_search(state: State<'_, RepoState>, query: grep::Query, limit: usize) -> Result<grep::SearchResult, String> {
    let root = with_repo(&state, |repo| repo.workdir_path().map(|p| p.to_path_buf()))?;
    let code = state.code_state_or_init();
    code.search_cancel.store(true, Ordering::Relaxed);       // stop the one before
    let cancel = Arc::new(AtomicBool::new(false));
    code.set_search_cancel(cancel.clone());
    grep::search(&root, &query, limit, cancel)
}

/// Called from watch.rs with a batch's worktree paths.
pub(crate) fn on_worktree_changed(app: &AppHandle, code: &CodeState, root: &std::path::Path, paths: &[String]) {
    let mut index = code.index.write().unwrap();
    for p in paths {
        if root.join(p).is_file() { index.reindex(root, p) } else { index.remove(p) }
    }
    drop(index);
    if let Ok(files) = gitp_code::files::walk(root) { *code.files.write().unwrap() = files; }
    let _ = app.emit("code-files-changed", serde_json::json!({ "paths": paths }));
}
```

`code_read_file` / `code_write_file` wrap `Repo::read_text_file` and
`Repo::write_text_file` (no undo recording), then `reindex`. `code_references`,
`code_callers`, `code_callees`, `code_file_symbols` are one-liners over
`resolve`. All are added to `generate_handler!` in `lib.rs`.

### `webui/src/code/editor.ts` — CodeMirror setup

```ts
// One CodeMirror view hosting whichever file is active; each open file keeps
// its EditorState so switching tabs restores caret, scroll and undo history.
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, ViewPlugin, Decoration } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import type { Lang, Location } from "../types";

export interface CodeEditorDeps {
  save: (path: string, text: string) => Promise<void>;
  gotoDefinition: (loc: Location) => void;
  onDirty: (path: string, dirty: boolean) => void;
  onCaretMoved: (loc: Location) => void;   // feeds the nav stack's 10-line rule
}

const AUTOSAVE_MS = 1500;

export function languageFor(lang: Lang | null) {
  switch (lang) {
    case "java": return java();
    case "javascript": return javascript({ jsx: true });
    case "typescript": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "python": return python();
    default: return [];
  }
}

export class CodeEditor {
  readonly view: EditorView;
  private states = new Map<string, EditorState>();
  private active: string | null = null;
  private language = new Compartment();
  private timers = new Map<string, number>();

  constructor(host: HTMLElement, private deps: CodeEditorDeps) {
    this.view = new EditorView({ parent: host, state: this.blankState() });
  }

  private baseExtensions() {
    return [
      lineNumbers(), highlightActiveLine(), drawSelection(), history(), bracketMatching(), indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        { key: "Mod-s", run: () => { void this.saveNow(); return true; } },
        { key: "F12", run: () => { this.jump(); return true; } },
        indentWithTab, ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.domEventHandlers({
        mousedown: (e, view) => {
          if (!(e.metaKey || e.ctrlKey)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          this.deps.gotoDefinition({ path: this.active!, line: line.number - 1, col: pos - line.from });
          return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (!this.active) return;
        if (u.docChanged) this.markDirty(this.active);
        if (u.selectionSet && !u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          this.deps.onCaretMoved({ path: this.active, line: line.number - 1, col: head - line.from });
        }
      }),
      this.language.of([]),
      modifierUnderline,
    ];
  }

  private blankState() { return EditorState.create({ doc: "", extensions: [...this.baseExtensions(), EditorState.readOnly.of(true)] }); }

  open(path: string, text: string, lang: Lang | null): void {
    if (this.active) this.states.set(this.active, this.view.state);
    const state = this.states.get(path)
      ?? EditorState.create({ doc: text, extensions: [...this.baseExtensions(), this.language.of(languageFor(lang))] });
    this.active = path;
    this.view.setState(state);
  }

  reveal(loc: Location): void {
    const line = this.view.state.doc.line(loc.line + 1);
    const pos = Math.min(line.from + loc.col, line.to);
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    this.view.focus();
  }

  caret(): Location | null {
    if (!this.active) return null;
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { path: this.active, line: line.number - 1, col: head - line.from };
  }

  private jump(): void { const c = this.caret(); if (c) this.deps.gotoDefinition(c); }

  private markDirty(path: string): void {
    this.deps.onDirty(path, true);
    window.clearTimeout(this.timers.get(path));
    this.timers.set(path, window.setTimeout(() => void this.saveNow(path), AUTOSAVE_MS));
  }

  async saveNow(path = this.active): Promise<void> {
    if (!path) return;
    window.clearTimeout(this.timers.get(path));
    const state = path === this.active ? this.view.state : this.states.get(path);
    if (!state) return;
    await this.deps.save(path, state.doc.toString());
    this.deps.onDirty(path, false);
  }

  close(path: string): void { this.states.delete(path); this.timers.delete(path); if (this.active === path) { this.active = null; this.view.setState(this.blankState()); } }
}

// Underline the word under the pointer while Cmd/Ctrl is held, like an IDE link.
const linkMark = Decoration.mark({ class: "cm-def-link" });
const modifierUnderline = ViewPlugin.fromClass(class {
  decorations = Decoration.none;
  constructor(private view: EditorView) {
    view.dom.addEventListener("mousemove", (e) => this.track(e));
    view.dom.addEventListener("keyup", () => this.set(Decoration.none));
  }
  private track(e: MouseEvent) {
    if (!(e.metaKey || e.ctrlKey)) { if (this.decorations.size) this.set(Decoration.none); return; }
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
    const word = pos == null ? null : this.view.state.wordAt(pos);
    this.set(word ? Decoration.set([linkMark.range(word.from, word.to)]) : Decoration.none);
  }
  private set(d: typeof this.decorations) { this.decorations = d; this.view.requestMeasure(); }
}, { decorations: (p) => p.decorations });
```

### `webui/src/code/nav-stack.ts`

```ts
// IntelliJ-style navigation history: every jump and every "significant"
// caret move (more than 10 lines) is a stop; back and forward walk them.
import type { Location } from "../types";

const MAX = 100;
const SIGNIFICANT_LINES = 10;

export class NavStack {
  private history: Location[] = [];
  private cursor = -1;          // index of the current stop
  private suppress = false;     // set while back/forward moves the caret

  /// A jump the user asked for: record where they were, then where they land.
  push(from: Location | null, to: Location): void {
    if (from) this.record(from);
    this.record(to);
  }

  /// A caret move inside the editor; only the big ones become stops.
  caretMoved(loc: Location): void {
    if (this.suppress) return;
    const cur = this.history[this.cursor];
    if (!cur) { this.record(loc); return; }
    if (cur.path === loc.path && Math.abs(cur.line - loc.line) <= SIGNIFICANT_LINES) {
      this.history[this.cursor] = loc;   // same stop, fresher caret
      return;
    }
    this.record(loc);
  }

  back(): Location | null { return this.cursor > 0 ? this.history[--this.cursor] : null; }
  forward(): Location | null { return this.cursor < this.history.length - 1 ? this.history[++this.cursor] : null; }
  canBack(): boolean { return this.cursor > 0; }
  canForward(): boolean { return this.cursor < this.history.length - 1; }

  /// Run `fn` (which moves the caret) without recording the move as a stop.
  silently(fn: () => void): void { this.suppress = true; try { fn(); } finally { this.suppress = false; } }

  private record(loc: Location): void {
    const cur = this.history[this.cursor];
    if (cur && cur.path === loc.path && cur.line === loc.line) { this.history[this.cursor] = loc; return; }
    this.history.length = this.cursor + 1;           // drop the forward branch
    this.history.push(loc);
    if (this.history.length > MAX) this.history.shift();
    this.cursor = this.history.length - 1;
  }
}
```

### `webui/src/code/shortcuts.ts` and `fuzzy.ts`

```ts
// Keys the Code tab answers to. Only while the tab is showing; the global
// pack in shortcuts.ts keeps its bindings and lists these in the cheat sheet.
export type CodeAction = "quickOpen" | "findInFiles" | "goToDefinition" | "back" | "forward" | "findUsages" | "callHierarchy" | "closeTab";

const IS_MAC = navigator.platform.startsWith("Mac");

export function codeActionFor(e: KeyboardEvent): CodeAction | null {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && e.altKey && key === "ArrowLeft") return "back";
  if (mod && e.altKey && key === "ArrowRight") return "forward";
  if (mod && !e.shiftKey && key === "p") return "quickOpen";
  if (mod && e.shiftKey && key === "f") return "findInFiles";
  if (mod && e.shiftKey && key === "w") return "closeTab";
  if (key === "F12" && !mod) return "goToDefinition";
  if (e.altKey && key === "F7") return "findUsages";
  if (e.ctrlKey && e.altKey && key === "h") return "callHierarchy";
  return null;
}

export function setupCodeShortcuts(isCodeTab: () => boolean, run: (a: CodeAction) => void): void {
  document.addEventListener("keydown", (e) => {
    if (!isCodeTab()) return;
    const action = codeActionFor(e);
    if (!action) return;
    e.preventDefault();
    run(action);
  }, { capture: true });
}
```

```ts
// fuzzy.ts — subsequence match with a score, shared by Quick Launch and
// quick open. Higher is better; null when the query isn't a subsequence.
export interface FuzzyMatch { score: number; positions: number[] }

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const positions: number[] = [];
  let score = 0, ti = 0, prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx < 0) return null;
    positions.push(idx);
    if (idx === prev + 1) score += 8;                                   // consecutive run
    if (idx === 0 || "/._-".includes(t[idx - 1])) score += 6;            // segment start
    const lastSlash = t.lastIndexOf("/");
    if (idx > lastSlash) score += 4;                                     // in the file name
    score -= Math.min(idx - ti, 4);                                      // gap penalty
    prev = idx; ti = idx + 1;
  }
  return { score: score - Math.min(text.length, 64) / 16, positions };
}

export function rankFuzzy<T>(query: string, items: T[], text: (i: T) => string, limit = 50): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) { const m = fuzzyMatch(query, text(item)); if (m) out.push({ item, match: m }); }
  out.sort((a, b) => b.match.score - a.match.score || text(a.item).length - text(b.item).length);
  return out.slice(0, limit);
}
```

### `webui/src/types.ts` additions

```ts
export type Lang = "java" | "javascript" | "typescript" | "tsx" | "python";
export interface FileEntry { path: string; size: number; lang: Lang | null }
export interface Location { path: string; line: number; col: number }   // 0-based
export interface Range { start_line: number; start_col: number; end_line: number; end_col: number; start_byte: number; end_byte: number }
export type SymbolKind = "function" | "method" | "class" | "interface" | "enum" | "variable" | "field";
export interface SymbolId { file: number; byte: number }
export interface Symbol { id: SymbolId; name: string; kind: SymbolKind; path: string; range: Range; name_range: Range; container: SymbolId | null; lang: Lang }
export interface Reference { name: string; kind: "call" | "ident" | "import"; path: string; range: Range; enclosing: SymbolId | null; receiver: string | null }
export interface SearchQuery { pattern: string; regex: boolean; case_sensitive: boolean; whole_word: boolean; include_glob: string | null }
export interface SearchHit { path: string; line: number; col: number; end_col: number; text: string }
export interface SearchResult { hits: SearchHit[]; truncated: boolean; files_searched: number }
export interface HierarchyNode { symbol: Symbol | null; reference: Reference; certain: boolean }
```

## Left to the builder

- Exact `.scm` queries for JS / TS / TSX / Python (the Java ones above are
  the pattern); check each against the grammar's `node-types.json`.
- The CodeMirror theme: map gitp's CSS variables to a `HighlightStyle` that
  matches the highlight.js colours used in diffs.
- Layout CSS for the three columns and the bottom panel; splitter sizes
  persisted in `prefs.ts` like other panels.
- How the explorer handles 50k+ files (virtualise the visible rows, or cap
  folder expansion); the walk itself is fast, the DOM is the cost.
- Whether `Mod+Shift+E` is free on every platform; pick another if not.
- Preview-mode mocks in `api.ts` for all `code*` wrappers, as every other
  command has.

## Points settled during the builder check

A reviewer read the document as the builder and asked these. Each answer is
my call; the scaffolding above is reference, and where it disagrees with
this section, this section wins.

1. **How the index learns which files changed.** `watch.rs` today collapses
   a batch into kind flags and keeps no paths. Change it so that, while a
   `CodeState` exists for the repo, the batch also accumulates the set of
   worktree paths (relative, already filtered by the ignore cache). A batch
   with **up to 500 paths** is applied per path: reindex or remove each, and
   patch the `files` list in place (add / remove entries) without a new walk.
   A larger batch (a checkout, `npm install`) does one new walk and a full
   rebuild on the index thread. The `files::walk` call in the scaffold's
   `on_worktree_changed` goes away.
2. **Inactive repository tabs.** Only the active tab's watcher is live, so a
   `CodeState` of an inactive tab goes stale. On activating a repo tab that
   has a `CodeState`, and on opening the Code tab, run a **refresh**: new walk,
   compare each file's mtime with the one stored in `FileIndex`, reindex the
   changed ones, drop the gone ones. A `CodeState` is dropped with its repo
   tab.
3. **Buffer versus disk, and column units.** Every navigation query on a
   **dirty** file first awaits `saveNow` for that file, so the index always
   reflects what the user sees; auto-save makes this the common case anyway.
   On the wire every column (`Range`, `Hit`, `Location`) is in **UTF-16 code
   units**, which is what CodeMirror positions use; the Rust side converts
   tree-sitter's byte columns and grep's byte offsets with
   `line[..byte].encode_utf16().count()`.
4. **External changes while dirty.** `code_read_file` returns the file's
   `mtime` (ms since epoch) beside the text; `code_write_file` takes
   `expected_mtime` and refuses with a typed error `changed_on_disk` when the
   file's mtime differs. The editor then shows a banner on that tab with two
   buttons: **Reload** (drop the buffer, read again) and **Keep mine**
   (write again with the current mtime). `CodeState` remembers the mtime of
   every file it just wrote, so when the watcher echoes that write back it is
   reindexed but raises no banner; any other watcher change to an open,
   non-dirty file reloads it silently, and to a dirty file raises the banner.
5. **Hidden and ignored files.** The walk shows **dotfiles and dot-folders**
   (`.github`, `.gitignore`, `.env.example`); only `.git` itself is skipped.
   **Gitignored** paths stay absent from the explorer, quick open, search and
   the index, as the search requirement says and as IDEs mark them excluded.
   The walk uses `hidden(false)` and `git_ignore(true)`.
6. **The existing editor and conflict flows.** The Code tab **coexists** with
   `file-editor.ts`; nothing there changes. A file open in both is fine: both
   write with the mtime check, so the second save sees `changed_on_disk`. No
   special handling during a merge or rebase; conflict markers are text, and
   the Conflicts view remains the place to resolve them.
7. **Index not ready, and oversized answers.** Navigation commands before
   `code-index-ready` return a typed error `indexing`; the UI shows a toast
   "Still indexing…" and the panels stay empty. Reference lists are **capped at
   2 000**, with a "narrowed" note like search. Plain `(identifier)` references
   are **not stored** in the index: it keeps calls, `new`, imports,
   type names and member accesses (`a.b`, `a::b`). Find Usages of a
   function, method, class, interface or enum uses the index; of a variable
   or field it runs a whole-word `grep` over files of the same language and
   shows those hits as "possible". The timing numbers in Goals are targets
   to measure against, not acceptance gates.
8. **`SymbolId` stability.** File ids come from one `ids: HashMap<String,
   u32>` used by both `build` and `reindex`, assigned on first sight and never
   reused, and `symbol()` is a lookup through `id → path`. A symbol's id
   survives a reindex only if its definition starts at the same byte; the UI
   therefore refreshes an open hierarchy or usages panel from its root
   symbol's `(path, name_range)` after `code-files-changed`, not from ids.
   Overlapping captures in `refs.scm` (a `method_invocation` name also matching
   a bare identifier) are deduplicated by `(start_byte, end_byte)`, keeping
   the most specific kind.
