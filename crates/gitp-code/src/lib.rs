//! The Code tab's engine: an ignore-aware walk of the working tree, a
//! tree-sitter symbol index with name- and scope-based navigation, and
//! full-text search on the ripgrep crates. No git, no Tauri: `gitp-gui`
//! bridges it to the frontend.

pub mod files;
pub mod lang;
