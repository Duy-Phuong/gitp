//! Credential prompts for the network commands. There is no terminal for git
//! or ssh to ask on, so without help a push to an HTTPS remote with nothing in
//! the keychain, or over ssh with a key whose passphrase no agent holds, just
//! fails. `askpass.sh` asks in a native dialog instead; it is written out at
//! startup and handed to every network operation the user started (see
//! `state::with_repo_networked`), never to the background fetch.
//!
//! A credential helper (osxkeychain) is still asked first: git only falls back
//! to askpass when the helper has nothing, and stores a working answer in it.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::io;
use std::path::{Path, PathBuf};

const SCRIPT: &str = include_str!("askpass.sh");

/// Install the helper in `dir` and return its path — or `None` when the
/// environment already names an askpass of the user's own, which git and ssh
/// keep using as before, or when it can't be written (prompts then fail as
/// they always did).
pub(crate) fn prepare(dir: &Path) -> Option<PathBuf> {
    let own = ["GIT_ASKPASS", "SSH_ASKPASS"]
        .iter()
        .any(|var| std::env::var_os(var).is_some_and(|v| !v.is_empty()));
    if own {
        return None;
    }
    install(dir)
        .map_err(|e| eprintln!("gitp: credential prompts unavailable: {e}"))
        .ok()
}

/// Write the script to `dir`, unless an identical copy is already there, and
/// make it executable by the owner only.
fn install(dir: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("askpass.sh");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(SCRIPT) {
        std::fs::write(&path, SCRIPT)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    #[test]
    fn installs_an_owner_only_script_and_replaces_a_stale_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = install(&dir.path().join("nested")).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SCRIPT);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);

        std::fs::write(&path, "#!/bin/sh\necho old\n").unwrap();
        assert_eq!(install(&dir.path().join("nested")).unwrap(), path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SCRIPT);
    }

    /// What the script did with `prompt`, run against a stand-in `osascript`
    /// that records its arguments and answers `hunter2` — or, when `cancel`,
    /// exits 1 the way osascript does when the dialog is cancelled.
    struct Run {
        ok: bool,
        stdout: String,
        /// The AppleScript source (`-e`), then the arguments after `--`.
        source: String,
        argv: Vec<String>,
    }

    fn run(prompt: &str, cancel: bool) -> Run {
        let dir = tempfile::tempdir().unwrap();
        let script = install(dir.path()).unwrap();
        let args = dir.path().join("args");
        let fake = dir.path().join("osascript");
        let answer = if cancel { "exit 1" } else { "echo hunter2" };
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done > '{}'\n{answer}\n",
                args.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();

        let out = Command::new(&script)
            .arg(prompt)
            .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
            .output()
            .unwrap();
        let recorded = std::fs::read(&args).unwrap();
        let recorded: Vec<String> = String::from_utf8(recorded)
            .unwrap()
            .split_terminator('\0')
            .map(str::to_string)
            .collect();
        let [flag, source, sep, argv @ ..] = recorded.as_slice() else {
            panic!("unexpected osascript call: {recorded:?}");
        };
        assert_eq!((flag.as_str(), sep.as_str()), ("-e", "--"));
        Run {
            ok: out.status.success(),
            stdout: String::from_utf8(out.stdout).unwrap(),
            source: source.clone(),
            argv: argv.to_vec(),
        }
    }

    #[test]
    fn a_username_is_asked_for_in_plain_text() {
        let r = run("Username for 'https://github.com': ", false);
        assert!(r.ok);
        assert_eq!(r.stdout, "hunter2\n");
        assert_eq!(r.argv, ["Username for 'https://github.com': ", "text"]);
    }

    #[test]
    fn secrets_are_asked_for_with_a_hidden_answer() {
        for prompt in [
            "Password for 'https://me@github.com': ",
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519': ",
            "me@host's PASSWORD: ",
            "Personal access token for 'https://example.com': ",
        ] {
            assert_eq!(run(prompt, false).argv, [prompt, "hidden"], "{prompt}");
        }
    }

    #[test]
    fn an_unknown_host_key_is_confirmed_with_buttons() {
        let prompt =
            "The authenticity of host 'example.com (93.184.215.14)' can't be established.\n\
                      ED25519 key fingerprint is SHA256:abc.\n\
                      Are you sure you want to continue connecting (yes/no/[fingerprint])? ";
        assert_eq!(run(prompt, false).argv, [prompt, "confirm"]);
    }

    #[test]
    fn the_prompt_is_passed_as_an_argument_never_as_source() {
        let hostile = "Password for 'https://x\"\ndo shell script \"touch /tmp/pwned\"\n--': ";
        let r = run(hostile, false);
        assert_eq!(r.argv, [hostile, "hidden"]);
        assert!(r.source.contains("on run argv"));
        assert!(!r.source.contains("pwned"));
    }

    #[test]
    fn cancel_answers_nothing_and_fails() {
        let r = run("Password for 'https://me@github.com': ", true);
        assert!(!r.ok);
        assert_eq!(r.stdout, "");
    }

    /// The AppleScript itself, checked by the real compiler — no dialog shown.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_applescript_compiles() {
        let source = run("Username: ", false).source;
        let dir = tempfile::tempdir().unwrap();
        let status = Command::new("osacompile")
            .arg("-o")
            .arg(dir.path().join("askpass.scpt"))
            .args(["-e", &source])
            .status()
            .unwrap();
        assert!(status.success());
    }
}
