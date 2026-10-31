use super::{DefCell, Lang, LangDef};

pub(crate) static DEF: DefCell = DefCell::new();

pub(crate) fn load() -> LangDef {
    LangDef::load(
        Lang::Python,
        tree_sitter_python::LANGUAGE.into(),
        include_str!("python/defs.scm"),
        include_str!("python/refs.scm"),
    )
}
