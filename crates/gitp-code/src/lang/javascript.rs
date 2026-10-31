use super::{DefCell, Lang, LangDef};

pub(crate) static DEF: DefCell = DefCell::new();

pub(crate) fn load() -> LangDef {
    LangDef::load(
        Lang::JavaScript,
        tree_sitter_javascript::LANGUAGE.into(),
        include_str!("javascript/defs.scm"),
        include_str!("javascript/refs.scm"),
    )
}
