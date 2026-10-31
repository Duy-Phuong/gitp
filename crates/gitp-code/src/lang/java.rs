use super::{DefCell, Lang, LangDef};

pub(crate) static DEF: DefCell = DefCell::new();

pub(crate) fn load() -> LangDef {
    LangDef::load(
        Lang::Java,
        tree_sitter_java::LANGUAGE.into(),
        include_str!("java/defs.scm"),
        include_str!("java/refs.scm"),
    )
}
