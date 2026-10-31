//! TypeScript and TSX: two grammars, one pair of queries.

use super::{DefCell, Lang, LangDef};

pub(crate) static DEF: DefCell = DefCell::new();
pub(crate) static DEF_TSX: DefCell = DefCell::new();

pub(crate) fn load_ts() -> LangDef {
    LangDef::load(
        Lang::TypeScript,
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        include_str!("typescript/defs.scm"),
        include_str!("typescript/refs.scm"),
    )
}

pub(crate) fn load_tsx() -> LangDef {
    LangDef::load(
        Lang::Tsx,
        tree_sitter_typescript::LANGUAGE_TSX.into(),
        include_str!("typescript/defs.scm"),
        include_str!("typescript/refs.scm"),
    )
}
