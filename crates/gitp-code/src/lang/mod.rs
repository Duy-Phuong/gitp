//! The languages the index understands.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Java,
    JavaScript,
    TypeScript,
    Tsx,
    Python,
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
}
