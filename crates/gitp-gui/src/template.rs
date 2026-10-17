// Config templates: pack ~/.gitconfig and ~/.tigrc into one JSON file so a new
// laptop can be set up from an old one in two clicks, and unpack such a file
// back into a home directory with the existing files backed up first.
//
// Everything here takes the home directory as an explicit `&Path` rather than
// reading $HOME, so the tests can run against a tempdir and never touch the
// developer's real dotfiles. The thin `#[tauri::command]` wrappers in lib.rs
// resolve $HOME and call in.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// The on-disk template. `version` is checked on apply so a future shape can
/// be rejected cleanly instead of half-applied.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigTemplate {
    pub version: u32,
    pub exported_at: String,
    pub host: String,
    pub files: TemplateFiles,
}

/// Each entry is `None` when the source machine didn't have that file, and
/// apply leaves the destination untouched for `None` — "I never had a .tigrc"
/// must not delete the one on the new machine.
#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateFiles {
    pub gitconfig: Option<String>,
    pub tigrc: Option<String>,
}

impl TemplateFiles {
    /// The files in a fixed order, paired with the name they live under in
    /// the home directory.
    fn entries(&self) -> [(&'static str, &Option<String>); 2] {
        [(".gitconfig", &self.gitconfig), (".tigrc", &self.tigrc)]
    }
}

/// What `apply` did, for the summary toast.
#[derive(Debug, Default, Serialize)]
pub struct ApplyTemplateResult {
    pub written: Vec<String>,
    pub backups: Vec<String>,
}

const TEMPLATE_VERSION: u32 = 1;

/// Build a template from the dotfiles in `home`. A missing file becomes
/// `None`; any other read error is reported.
pub fn export_from_home(home: &Path, now: SystemTime) -> Result<ConfigTemplate, String> {
    let read = |name: &str| -> Result<Option<String>, String> {
        match std::fs::read_to_string(home.join(name)) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{name}: {e}")),
        }
    };
    Ok(ConfigTemplate {
        version: TEMPLATE_VERSION,
        exported_at: rfc3339_utc(now),
        host: hostname(),
        files: TemplateFiles {
            gitconfig: read(".gitconfig")?,
            tigrc: read(".tigrc")?,
        },
    })
}

/// Export `home`'s dotfiles to the JSON file at `dest`.
pub fn export_to_file(home: &Path, dest: &Path, now: SystemTime) -> Result<(), String> {
    let template = export_from_home(home, now)?;
    let json = serde_json::to_string_pretty(&template).map_err(|e| e.to_string())?;
    write_atomic(dest, &json)
}

/// Parse and validate a template; the only accepted shape is version 1.
pub fn parse_template(json: &str) -> Result<ConfigTemplate, String> {
    // Peek at the version first so an unknown-version file gets the clear
    // "unsupported version" error rather than a deserialisation complaint
    // about whatever else changed in that shape.
    #[derive(Deserialize)]
    struct Version {
        version: u32,
    }
    let v: Version = serde_json::from_str(json).map_err(|e| format!("Not a gitp template: {e}"))?;
    if v.version != TEMPLATE_VERSION {
        return Err(format!(
            "Unsupported template version {} (this gitp understands version {TEMPLATE_VERSION})",
            v.version
        ));
    }
    serde_json::from_str(json).map_err(|e| format!("Not a gitp template: {e}"))
}

/// Write the template's files into `home`, backing up any existing file to
/// `<name>.bak-YYYYMMDD-HHMMSS` first. Files that are `None` in the template
/// are left alone.
pub fn apply_to_home(
    home: &Path,
    template: &ConfigTemplate,
    now: SystemTime,
) -> Result<ApplyTemplateResult, String> {
    let stamp = backup_stamp(now);
    let mut result = ApplyTemplateResult::default();
    for (name, content) in template.files.entries() {
        let Some(content) = content else {
            continue;
        };
        let target = home.join(name);
        if target.exists() {
            let backup = home.join(format!("{name}.bak-{stamp}"));
            std::fs::copy(&target, &backup).map_err(|e| format!("backing up {name}: {e}"))?;
            result.backups.push(backup.display().to_string());
        }
        write_atomic(&target, content).map_err(|e| format!("writing {name}: {e}"))?;
        result.written.push(target.display().to_string());
    }
    Ok(result)
}

/// Read the template at `src` and apply it to `home`.
pub fn apply_from_file(
    home: &Path,
    src: &Path,
    now: SystemTime,
) -> Result<ApplyTemplateResult, String> {
    let json = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    let template = parse_template(&json)?;
    apply_to_home(home, &template, now)
}

/// Write via a temp file in the same directory, then rename over the target.
/// Writing to the target path directly would follow a symlink and clobber
/// whatever it points at; rename replaces the link itself. Same directory so
/// the rename is atomic (no cross-filesystem move).
fn write_atomic(target: &Path, content: &str) -> Result<(), String> {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = target.with_file_name(format!(".{name}.tmp-{}-{nanos}", std::process::id()));
    let write = || -> std::io::Result<()> {
        // create_new: never truncate something that already exists at the
        // temp path, however unlikely.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        std::io::Write::write_all(&mut f, content.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, target)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// `YYYYMMDD-HHMMSS` in UTC — sorts chronologically and has no characters a
/// filesystem minds.
fn backup_stamp(now: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = civil_utc(now);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

fn rfc3339_utc(now: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = civil_utc(now);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Break a `SystemTime` into UTC calendar fields without pulling in chrono.
/// Days-to-civil is Howard Hinnant's algorithm.
fn civil_utc(now: SystemTime) -> (i64, u32, u32, u32, u32, u32) {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    );

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if mo <= 2 { y + 1 } else { y };
    (y, mo, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A fixed 2026-10-17T08:09:10Z so stamp assertions are exact.
    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_792_224_550)
    }

    fn home_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, content) in files {
            std::fs::write(dir.path().join(name), content).unwrap();
        }
        dir
    }

    #[test]
    fn timestamps_are_utc_calendar_fields() {
        assert_eq!(rfc3339_utc(now()), "2026-10-17T08:09:10Z");
        assert_eq!(backup_stamp(now()), "20261017-080910");
    }

    #[test]
    fn export_then_apply_recreates_both_files_in_another_home() {
        let src = home_with(&[
            (".gitconfig", "[user]\n\tname = A\n"),
            (".tigrc", "set tab-size = 4\n"),
        ]);
        let dest = tempfile::tempdir().unwrap();
        let file = dest.path().join("gitp-template.json");

        export_to_file(src.path(), &file, now()).unwrap();
        let json = std::fs::read_to_string(&file).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["exported_at"], "2026-10-17T08:09:10Z");
        assert!(parsed["host"].is_string());

        let out = apply_from_file(dest.path(), &file, now()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.path().join(".gitconfig")).unwrap(),
            "[user]\n\tname = A\n"
        );
        assert_eq!(
            std::fs::read_to_string(dest.path().join(".tigrc")).unwrap(),
            "set tab-size = 4\n"
        );
        assert_eq!(out.written.len(), 2);
        assert!(out.backups.is_empty(), "fresh home has nothing to back up");
    }

    #[test]
    fn apply_backs_up_existing_files_and_skips_null_entries() {
        let home = home_with(&[(".gitconfig", "old\n"), (".tigrc", "keep me\n")]);
        let template = ConfigTemplate {
            version: 1,
            exported_at: String::new(),
            host: String::new(),
            files: TemplateFiles {
                gitconfig: Some("new\n".to_string()),
                tigrc: None,
            },
        };

        let out = apply_to_home(home.path(), &template, now()).unwrap();

        let backup = home.path().join(".gitconfig.bak-20261017-080910");
        assert_eq!(out.backups, vec![backup.display().to_string()]);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "old\n");
        assert_eq!(
            std::fs::read_to_string(home.path().join(".gitconfig")).unwrap(),
            "new\n"
        );
        assert_eq!(
            out.written,
            vec![home.path().join(".gitconfig").display().to_string()]
        );
        // `null` means "no opinion", not "delete".
        assert_eq!(
            std::fs::read_to_string(home.path().join(".tigrc")).unwrap(),
            "keep me\n"
        );
        assert!(!home.path().join(".tigrc.bak-20261017-080910").exists());
    }

    #[test]
    fn export_records_null_for_a_missing_file() {
        let home = home_with(&[(".gitconfig", "x\n")]);
        let t = export_from_home(home.path(), now()).unwrap();
        assert_eq!(t.files.gitconfig.as_deref(), Some("x\n"));
        assert!(t.files.tigrc.is_none());
    }

    #[test]
    fn rejects_unknown_version_and_non_templates() {
        let err =
            parse_template(r#"{"version":2,"exported_at":"","host":"","files":{}}"#).unwrap_err();
        assert!(err.contains("Unsupported template version 2"), "{err}");
        assert!(parse_template("not json")
            .unwrap_err()
            .contains("Not a gitp template"));
        assert!(parse_template(r#"{"hello":1}"#)
            .unwrap_err()
            .contains("Not a gitp template"));
    }

    #[cfg(unix)]
    #[test]
    fn apply_replaces_a_symlink_rather_than_writing_through_it() {
        let home = home_with(&[("real.cfg", "elsewhere\n")]);
        let link = home.path().join(".gitconfig");
        std::os::unix::fs::symlink(home.path().join("real.cfg"), &link).unwrap();
        let template = ConfigTemplate {
            version: 1,
            exported_at: String::new(),
            host: String::new(),
            files: TemplateFiles {
                gitconfig: Some("new\n".to_string()),
                tigrc: None,
            },
        };

        apply_to_home(home.path(), &template, now()).unwrap();

        assert_eq!(
            std::fs::read_to_string(home.path().join("real.cfg")).unwrap(),
            "elsewhere\n"
        );
        assert!(!std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "new\n");
    }
}
