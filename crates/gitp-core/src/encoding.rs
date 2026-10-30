//! The text encoding a repository's files are in (Settings → Git), for repos
//! whose files aren't UTF-8. Diffs, blame and conflict sides are decoded with
//! it, and the in-app editor reads and writes files in it, so saving a file
//! never turns it into UTF-8 behind the user's back.
//!
//! It is kept per repository in the repo's own config (`.git/config`) as
//! `gitp.encoding`, a WHATWG encoding label such as `shift_jis`; unset, or a
//! name gitp doesn't know, is UTF-8. Only the repo's own level counts — it is
//! a fact about that repo's files, not a preference to inherit.
//!
//! git stores and diffs bytes, splitting lines at the 0x0A byte, so a diff can
//! be decoded line by line in any encoding where `\n` is that one byte. UTF-16
//! isn't one: git sees its NUL bytes and treats the file as binary, so in a
//! UTF-16 repo the setting only reaches the editor and blame.

use std::borrow::Cow;

use encoding_rs::Encoding;

use crate::repo::Repo;

/// The repo config key holding the encoding's label.
pub const ENCODING_KEY: &str = "gitp.encoding";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// ISO-8859-1 proper, where each byte is the code point of the same
    /// number. encoding_rs follows the WHATWG standard, which reads that label
    /// as Windows-1252 — the two differ at 0x80–0x9F.
    Latin1,
    /// Any other encoding encoding_rs knows (Windows-1252, Shift_JIS, GBK…).
    Other(&'static Encoding),
}

impl TextEncoding {
    /// The encoding a label names, or `None` for one gitp doesn't know.
    pub fn from_label(label: &str) -> Option<Self> {
        let label = label.trim();
        if label.eq_ignore_ascii_case("iso-8859-1") || label.eq_ignore_ascii_case("latin1") {
            return Some(Self::Latin1);
        }
        let enc = Encoding::for_label(label.as_bytes())?;
        Some(if enc == encoding_rs::UTF_8 {
            Self::Utf8
        } else if enc == encoding_rs::UTF_16LE {
            Self::Utf16Le
        } else if enc == encoding_rs::UTF_16BE {
            Self::Utf16Be
        } else {
            Self::Other(enc)
        })
    }

    /// The name used in messages ("isn't Shift_JIS text").
    pub fn name(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf16Le => "UTF-16LE",
            Self::Utf16Be => "UTF-16BE",
            Self::Latin1 => "ISO-8859-1",
            Self::Other(enc) => enc.name(),
        }
    }

    /// Whether a NUL byte means binary, as git takes it to. In UTF-16 every
    /// ASCII character has one.
    pub fn nul_means_binary(self) -> bool {
        !matches!(self, Self::Utf16Le | Self::Utf16Be)
    }

    /// `bytes` as text, with U+FFFD for what isn't valid — for showing. A
    /// byte order mark is kept as U+FEFF, as the UTF-8 path always did, so
    /// it survives a round trip through the editor.
    pub fn decode_lossy(self, bytes: &[u8]) -> Cow<'_, str> {
        match self {
            Self::Utf8 => String::from_utf8_lossy(bytes),
            Self::Latin1 => Cow::Owned(bytes.iter().map(|&b| char::from(b)).collect()),
            Self::Utf16Le => encoding_rs::UTF_16LE.decode_without_bom_handling(bytes).0,
            Self::Utf16Be => encoding_rs::UTF_16BE.decode_without_bom_handling(bytes).0,
            Self::Other(enc) => enc.decode_without_bom_handling(bytes).0,
        }
    }

    /// `bytes` as text, or `None` when they aren't valid in this encoding —
    /// for the editor, where a replaced byte would be written back changed.
    pub fn decode(self, bytes: &[u8]) -> Option<Cow<'_, str>> {
        match self {
            Self::Utf8 => std::str::from_utf8(bytes).ok().map(Cow::Borrowed),
            Self::Latin1 => Some(self.decode_lossy(bytes)),
            Self::Utf16Le => {
                encoding_rs::UTF_16LE.decode_without_bom_handling_and_without_replacement(bytes)
            }
            Self::Utf16Be => {
                encoding_rs::UTF_16BE.decode_without_bom_handling_and_without_replacement(bytes)
            }
            Self::Other(enc) => enc.decode_without_bom_handling_and_without_replacement(bytes),
        }
    }

    /// `text` in this encoding, or `None` when it has a character the
    /// encoding can't represent. (encoding_rs would write those as `&#…;`
    /// HTML references — not something to save into a source file.)
    pub fn encode(self, text: &str) -> Option<Cow<'_, [u8]>> {
        match self {
            Self::Utf8 => Some(Cow::Borrowed(text.as_bytes())),
            Self::Latin1 => text
                .chars()
                .map(|c| u8::try_from(u32::from(c)).ok())
                .collect::<Option<Vec<u8>>>()
                .map(Cow::Owned),
            // encoding_rs only decodes UTF-16 (its encoders write UTF-8 for it,
            // per the standard), but the code units are all there is to it.
            Self::Utf16Le => Some(Cow::Owned(
                text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
            )),
            Self::Utf16Be => Some(Cow::Owned(
                text.encode_utf16().flat_map(u16::to_be_bytes).collect(),
            )),
            Self::Other(enc) => {
                let (bytes, _, unmappable) = enc.encode(text);
                (!unmappable).then_some(bytes)
            }
        }
    }
}

impl Repo {
    /// The encoding set for this repository (`gitp.encoding` in its own
    /// config), UTF-8 when there is none or it names one gitp doesn't know.
    pub fn text_encoding(&self) -> TextEncoding {
        self.inner
            .config()
            .and_then(|cfg| cfg.open_level(git2::ConfigLevel::Local))
            .and_then(|cfg| cfg.get_string(ENCODING_KEY))
            .ok()
            .and_then(|label| TextEncoding::from_label(&label))
            .unwrap_or(TextEncoding::Utf8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_name_the_offered_encodings() {
        for (label, name) in [
            ("utf-8", "UTF-8"),
            ("UTF-16LE", "UTF-16LE"),
            ("utf-16be", "UTF-16BE"),
            ("windows-1252", "windows-1252"),
            ("iso-8859-1", "ISO-8859-1"),
            ("shift_jis", "Shift_JIS"),
            ("euc-jp", "EUC-JP"),
            ("gbk", "GBK"),
            ("big5", "Big5"),
            ("euc-kr", "EUC-KR"),
        ] {
            assert_eq!(
                TextEncoding::from_label(label).map(TextEncoding::name),
                Some(name),
                "{label}"
            );
        }
        assert_eq!(TextEncoding::from_label("klingon"), None);
    }

    #[test]
    fn latin1_differs_from_windows_1252_in_the_c1_range() {
        let latin1 = TextEncoding::Latin1;
        let cp1252 = TextEncoding::from_label("windows-1252").unwrap();
        assert_eq!(latin1.decode_lossy(&[0x80]), "\u{80}");
        assert_eq!(cp1252.decode_lossy(&[0x80]), "€");
        assert_eq!(latin1.encode("é").as_deref(), Some(&[0xe9][..]));
        assert_eq!(latin1.encode("€"), None);
    }

    #[test]
    fn round_trips_and_refuses_what_it_cannot_hold() {
        let sjis = TextEncoding::from_label("shift_jis").unwrap();
        let bytes = sjis.encode("日本語\n").unwrap().into_owned();
        assert_eq!(bytes, b"\x93\xfa\x96\x7b\x8c\xea\n");
        assert_eq!(sjis.decode(&bytes).as_deref(), Some("日本語\n"));
        // An emoji has no Shift_JIS code.
        assert_eq!(sjis.encode("ok 🙂"), None);
        // A lone lead byte isn't Shift_JIS text.
        assert_eq!(sjis.decode(b"\x93"), None);
        assert_eq!(sjis.decode_lossy(b"\x93"), "\u{fffd}");

        let utf16 = TextEncoding::Utf16Le;
        let bytes = utf16.encode("\u{feff}hi").unwrap().into_owned();
        assert_eq!(bytes, b"\xff\xfeh\0i\0");
        assert_eq!(utf16.decode(&bytes).as_deref(), Some("\u{feff}hi"));
        assert_eq!(
            TextEncoding::Utf16Be.encode("hi").as_deref(),
            Some(&b"\0h\0i"[..])
        );
    }
}
