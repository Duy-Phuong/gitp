//! The languages the index understands: a tree-sitter grammar each, with a
//! query for definitions (`defs.scm`) and one for references (`refs.scm`).
//!
//! Capture names are the contract between the queries and `index.rs`:
//! `@name` is the identifier; one of `@def.class`, `@def.interface`,
//! `@def.enum`, `@def.function`, `@def.method`, `@def.field`,
//! `@def.variable` spans a whole definition; one of `@ref.call`,
//! `@ref.import`, `@ref.ident` marks a reference, with `@receiver` on the
//! object of a member call when there is one.

use std::sync::OnceLock;

use serde::Serialize;
use tree_sitter::{Language, Query};

pub mod java;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Java,
    JavaScript,
    TypeScript,
    Tsx,
    Python,
}

/// Languages whose files refer to each other: JS, TS and TSX are one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Java,
    Js,
    Python,
}

pub struct LangDef {
    pub lang: Lang,
    pub language: Language,
    pub defs: Query,
    pub refs: Query,
}

impl LangDef {
    fn load(lang: Lang, language: Language, defs: &str, refs: &str) -> LangDef {
        let defs = Query::new(&language, defs).unwrap_or_else(|e| panic!("{lang:?} defs.scm: {e}"));
        let refs = Query::new(&language, refs).unwrap_or_else(|e| panic!("{lang:?} refs.scm: {e}"));
        LangDef { lang, language, defs, refs }
    }
}

impl Lang {
    /// The language a file's extension says it is.
    pub fn from_path(path: &str) -> Option<Lang> {
        let name = path.rsplit('/').next()?;
        let (_, ext) = name.rsplit_once('.')?;
        Some(match ext {
            "java" => Lang::Java,
            "js" | "mjs" | "cjs" | "jsx" => Lang::JavaScript,
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "py" | "pyi" => Lang::Python,
            _ => return None,
        })
    }

    pub fn family(self) -> Family {
        match self {
            Lang::Java => Family::Java,
            Lang::JavaScript | Lang::TypeScript | Lang::Tsx => Family::Js,
            Lang::Python => Family::Python,
        }
    }

    /// The grammar and queries, compiled once per process.
    pub fn def(self) -> &'static LangDef {
        match self {
            Lang::Java => java::DEF.get_or_init(java::load),
            _ => unimplemented!("grammar for {self:?}"),
        }
    }
}

pub(crate) type DefCell = OnceLock<LangDef>;
