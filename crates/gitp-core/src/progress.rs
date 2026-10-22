//! Live progress and cancellation for the network git commands (fetch, pull,
//! push).
//!
//! Without a TTY git prints nothing until it's done, so a slow push is a
//! spinner and a guess. Run with `--progress`, git writes its meters to stderr
//! anyway — each update ending in `\r`, the final one in `\n` — and reading
//! stderr as it arrives turns those into [`Progress`] updates. The meters are
//! filtered out of the returned text, so callers get the same output they did
//! before progress existed.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git_bin::git_command;
use crate::repo::Repo;

/// One progress update: the phase git is in ("Receiving objects"), how far
/// through it is when git knows, and the rest of the line ("(450/1000), 1.2 MiB
/// | 2.0 MiB/s").
///
/// `cancellable` is false for the update that marks the start of a local write
/// (a pull's merge or rebase, a fast-forward): from then on Cancel is ignored,
/// and a frontend should stop offering it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub phase: String,
    pub percent: Option<u8>,
    pub detail: String,
    pub cancellable: bool,
}

/// A progress callback (see [`NetworkHooks`]).
pub type ProgressFn = Box<dyn Fn(&Progress) + Send>;

/// Where a [`Repo`]'s network commands report progress, the flag that stops
/// them, and the program that asks the user for credentials. All optional; a
/// `Repo` without hooks runs its network commands exactly as before, just
/// without anyone listening.
#[derive(Default)]
pub struct NetworkHooks {
    pub on_progress: Option<ProgressFn>,
    /// Raised by the frontend to cancel: the running network `git` is stopped
    /// and the operation returns [`Error::Cancelled`]. Local writes are never
    /// interrupted — see [`Repo::begin_local_step`].
    pub cancel: Option<Arc<AtomicBool>>,
    /// An askpass program — called with the prompt as its one argument, it
    /// prints the answer, or exits non-zero to refuse — that git asks for a
    /// username/password a credential helper couldn't supply, and ssh for a
    /// key passphrase or to confirm an unknown host key. Without one, those
    /// fail with git's usual error, as there is no terminal to prompt on.
    ///
    /// A `core.askPass` the user configured wins over it. So should a
    /// `GIT_ASKPASS` / `SSH_ASKPASS` in the process environment, but that is
    /// the caller's to check: it owns the environment, and leaves this `None`.
    pub askpass: Option<PathBuf>,
}

/// How often the run loop wakes to check the cancel flag when git is quiet
/// (waiting on the network, or on a credential helper).
const CANCEL_POLL: Duration = Duration::from_millis(50);

impl Repo {
    /// Attach progress/cancel hooks to this handle's network commands. The GUI
    /// opens a fresh `Repo` per network operation, so the hooks live exactly as
    /// long as the operation they belong to.
    pub fn set_network_hooks(&mut self, hooks: NetworkHooks) {
        self.net = hooks;
    }

    /// [`Repo::run_git`] for a command that talks to a remote: adds
    /// `--progress` after the subcommand, reports each meter update to the
    /// hooks, and kills git if the cancel flag goes up. Returns the trimmed
    /// combined output minus the meters, or it as an error on failure.
    pub(crate) fn run_git_network(&self, args: &[&str]) -> Result<String> {
        let mut full = Vec::with_capacity(args.len() + 1);
        full.extend_from_slice(&args[..1]);
        full.push("--progress");
        full.extend_from_slice(&args[1..]);
        self.run_git_progress(&full)
    }

    /// [`Repo::run_git_network`] for a command whose `--progress` doesn't go
    /// right after the first word (`git submodule update --progress`): `args`
    /// already carry it.
    pub(crate) fn run_git_progress(&self, args: &[&str]) -> Result<String> {
        if self.cancelled() {
            return Err(Error::Cancelled);
        }
        let workdir = self
            .inner
            .workdir()
            .ok_or_else(|| Error::Message("repository has no working directory".into()))?;

        let mut cmd = git_command();
        cmd.current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(askpass) = &self.net.askpass {
            if !self.has_own_askpass() {
                use_askpass(&mut cmd, askpass);
            }
        }
        // Its own process group, so Cancel can stop everything git started —
        // the remote helper, ssh, and an askpass dialog still waiting for an
        // answer — not just git itself (see `kill`).
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let mut child = cmd
            .spawn()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;

        // Both pipes are drained on their own threads — reading one while git
        // blocks writing the other would deadlock. Stderr is split into lines
        // as it arrives and handed back here, where the hooks run.
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let stdout_reader = thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            buf
        });
        let stderr = child.stderr.take().expect("stderr is piped");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || split_lines(stderr, |line| tx.send(line).is_ok()));

        let mut messages = String::new();
        loop {
            match rx.recv_timeout(CANCEL_POLL) {
                Ok(line) => match parse_progress(&line) {
                    Some(p) => {
                        if let Some(cb) = &self.net.on_progress {
                            cb(&p);
                        }
                    }
                    None if is_meter_chatter(&line) => {}
                    None => {
                        messages.push_str(&line);
                        messages.push('\n');
                    }
                },
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if self.cancelled() {
                return Err(kill(child));
            }
        }

        let status = child
            .wait()
            .map_err(|e| Error::Message(format!("failed to run git: {e}")))?;
        let stdout = stdout_reader.join().unwrap_or_default();
        let mut combined = String::from_utf8_lossy(&stdout).into_owned();
        combined.push_str(&messages);
        let combined = combined.trim().to_string();
        if status.success() {
            Ok(combined)
        } else {
            Err(Error::Message(combined))
        }
    }

    /// Mark the end of an operation's network part and the start of a local
    /// write (merge, rebase, fast-forward) that must not be interrupted. A
    /// Cancel that already landed stops the operation here, before anything
    /// local changes; one that lands later is ignored, since the write runs
    /// through plain `run_git`, which never looks at the flag. The hooks hear
    /// about it as a non-cancellable `phase`.
    pub(crate) fn begin_local_step(&self, phase: &str) -> Result<()> {
        if self.cancelled() {
            return Err(Error::Cancelled);
        }
        if let Some(cb) = &self.net.on_progress {
            cb(&Progress {
                phase: phase.to_string(),
                percent: None,
                detail: String::new(),
                cancellable: false,
            });
        }
        Ok(())
    }

    /// Whether the user configured `core.askPass`, which our askpass would
    /// override if set (git ranks `GIT_ASKPASS` above it).
    fn has_own_askpass(&self) -> bool {
        self.inner
            .config()
            .and_then(|c| c.get_string("core.askPass"))
            .is_ok_and(|v| !v.is_empty())
    }

    fn cancelled(&self) -> bool {
        self.net
            .cancel
            .as_ref()
            .is_some_and(|c| c.load(Ordering::SeqCst))
    }
}

/// Point git (`GIT_ASKPASS`) and ssh (`SSH_ASKPASS`) at `askpass`. ssh only
/// uses it without a terminal when told to (`SSH_ASKPASS_REQUIRE`, OpenSSH
/// 8.4+); before that it wanted `DISPLAY` set to anything at all.
fn use_askpass(cmd: &mut Command, askpass: &Path) {
    cmd.env("GIT_ASKPASS", askpass)
        .env("SSH_ASKPASS", askpass)
        .env("SSH_ASKPASS_REQUIRE", "force");
    if std::env::var_os("DISPLAY").is_none_or(|d| d.is_empty()) {
        cmd.env("DISPLAY", ":0");
    }
}

/// Stop a cancelled git and reap it.
///
/// SIGTERM first, not SIGKILL: git removes its lock files (`index.lock`, a
/// ref's `.lock`) in its handler for catchable signals, so a fetch or push
/// stopped while updating refs doesn't leave one behind to block the next git
/// command. SIGKILL is the fallback for a git that doesn't exit promptly.
///
/// The signals go to git's whole process group: git doesn't pass them on to
/// what it started, and an askpass dialog left on screen after its git is gone
/// would be waiting to send an answer nowhere.
///
/// The reader threads are left to finish on their own: a helper git spawned
/// (ssh, a remote helper) can hold the pipes open a little longer, and waiting
/// on them would be the hang Cancel exists to get out of.
fn kill(mut child: Child) -> Error {
    #[cfg(unix)]
    {
        // SAFETY: plain kill(2) on the process group led by a child we
        // haven't reaped yet, so its id can't have been recycled.
        unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGTERM) };
        for _ in 0..40 {
            if let Ok(Some(_)) = child.try_wait() {
                return Error::Cancelled;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Error::Cancelled
}

/// Read `src` to the end, calling `emit` with each line as soon as its `\r` or
/// `\n` arrives (lossily decoded, trimmed, empty ones skipped). Stops early if
/// `emit` returns false.
fn split_lines(mut src: impl Read, mut emit: impl FnMut(String) -> bool) {
    let mut line = Vec::new();
    let mut buf = [0u8; 4096];
    let mut flush = |line: &mut Vec<u8>| -> bool {
        let text = String::from_utf8_lossy(line).trim().to_string();
        line.clear();
        text.is_empty() || emit(text)
    };
    loop {
        let n = match src.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\r' || b == b'\n' {
                if !flush(&mut line) {
                    return;
                }
            } else {
                line.push(b);
            }
        }
    }
    flush(&mut line);
}

/// Parse one of git's progress meter lines, with or without the `remote: `
/// prefix the server's meters arrive under:
///
/// ```text
/// Receiving objects:  45% (450/1000), 1.2 MiB | 2.0 MiB/s
/// Resolving deltas: 100% (10/10), done.
/// remote: Enumerating objects: 5, done.
/// ```
///
/// Anything else — git's real messages, errors, hints — is `None`. The phase
/// must be a capitalised run of words, which is what keeps `error: 1 ...` or
/// `hint: ...` from ever being mistaken for a meter.
pub fn parse_progress(line: &str) -> Option<Progress> {
    let line = line.trim();
    let body = line.strip_prefix("remote:").unwrap_or(line).trim();
    let (phase, rest) = body.split_once(": ")?;
    let words_only = phase.chars().all(|c| c.is_ascii_alphabetic() || c == ' ');
    if !words_only || !phase.starts_with(|c: char| c.is_ascii_uppercase()) {
        return None;
    }
    let rest = rest.trim();
    let phase = phase.to_string();

    // "45% (450/1000), ..." — a meter with a known total.
    if let Some((num, after)) = rest.split_once('%') {
        if let Ok(percent) = num.trim().parse::<u8>() {
            if percent <= 100 {
                return Some(Progress {
                    phase,
                    percent: Some(percent),
                    detail: after.trim().to_string(),
                    cancellable: true,
                });
            }
        }
        return None;
    }

    // "5, done." or "1234" — a counter with no total.
    let digits = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    let tail = &rest[digits..];
    if digits == 0 || !(tail.is_empty() || tail.starts_with(',')) {
        return None;
    }
    Some(Progress {
        phase,
        percent: None,
        detail: rest.to_string(),
        cancellable: true,
    })
}

/// The pack statistics that come with `--progress` but aren't meters: never
/// shown before progress was turned on, so they're dropped from the output to
/// keep it as it was.
fn is_meter_chatter(line: &str) -> bool {
    let body = line.strip_prefix("remote:").unwrap_or(line).trim();
    body.starts_with("Total ") || body.starts_with("Delta compression using up to ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(phase: &str, percent: Option<u8>, detail: &str) -> Option<Progress> {
        Some(Progress {
            phase: phase.into(),
            percent,
            detail: detail.into(),
            cancellable: true,
        })
    }

    #[test]
    fn parses_a_meter_with_a_percentage_and_throughput() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (450/1000), 1.2 MiB | 2.0 MiB/s"),
            p(
                "Receiving objects",
                Some(45),
                "(450/1000), 1.2 MiB | 2.0 MiB/s"
            )
        );
    }

    #[test]
    fn parses_the_final_done_line() {
        assert_eq!(
            parse_progress("Resolving deltas: 100% (10/10), done."),
            p("Resolving deltas", Some(100), "(10/10), done.")
        );
        assert_eq!(
            parse_progress("Writing objects: 100% (3/3), 272 bytes | 272.00 KiB/s, done."),
            p(
                "Writing objects",
                Some(100),
                "(3/3), 272 bytes | 272.00 KiB/s, done."
            )
        );
    }

    #[test]
    fn parses_single_digit_percentages_padded_with_spaces() {
        assert_eq!(
            parse_progress("Counting objects:   0% (1/102)"),
            p("Counting objects", Some(0), "(1/102)")
        );
        assert_eq!(
            parse_progress("Compressing objects:   3% (2/52)"),
            p("Compressing objects", Some(3), "(2/52)")
        );
    }

    #[test]
    fn parses_counters_without_a_total() {
        assert_eq!(
            parse_progress("Enumerating objects: 5, done."),
            p("Enumerating objects", None, "5, done.")
        );
        assert_eq!(
            parse_progress("Counting objects: 1234"),
            p("Counting objects", None, "1234")
        );
        assert_eq!(
            parse_progress("Receiving objects: 1234, 1.2 MiB | 2.0 MiB/s"),
            p("Receiving objects", None, "1234, 1.2 MiB | 2.0 MiB/s")
        );
    }

    #[test]
    fn strips_the_remote_prefix_and_the_padding_after_it() {
        // The server's meters come over the sideband with trailing spaces in
        // place of a clear-to-end-of-line escape when stderr isn't a terminal.
        assert_eq!(
            parse_progress("remote: Counting objects:  51% (53/102)        "),
            p("Counting objects", Some(51), "(53/102)")
        );
        assert_eq!(
            parse_progress("remote: Enumerating objects: 102, done.        "),
            p("Enumerating objects", None, "102, done.")
        );
    }

    #[test]
    fn rejects_git_messages_that_are_not_meters() {
        for line in [
            "To ../remote.git",
            "   b5b31e4..ec1daa1  main -> main",
            " * [new branch]      main -> main",
            "branch 'main' set up to track 'origin/main'.",
            "From /tmp/remote",
            "error: failed to push some refs to '../remote.git'",
            "hint: Updates were rejected because the remote contains work",
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "Note: switching to 'abc'.",
            "remote: Create a pull request for 'feat' on GitHub by visiting:",
            "remote:      https://github.com/o/r/pull/new/feat",
            "Total 3 (delta 2), reused 0 (delta 0), pack-reused 0",
            "Updating a9d9ca8..4ffc783",
            "CONFLICT (content): Merge conflict in a.txt",
            "Receiving objects: lots",
            "Receiving objects: 250% (1/1)",
            "",
        ] {
            assert_eq!(parse_progress(line), None, "{line:?} is not a meter");
        }
    }

    #[test]
    fn pack_statistics_are_chatter_but_real_messages_are_not() {
        assert!(is_meter_chatter("Total 3 (delta 2), reused 0 (delta 0)"));
        assert!(is_meter_chatter(
            "remote: Total 52 (delta 50), reused 0 (delta 0)        "
        ));
        assert!(is_meter_chatter("Delta compression using up to 10 threads"));
        assert!(!is_meter_chatter("To ../remote.git"));
        assert!(!is_meter_chatter("remote: Totally real message"));
    }

    #[test]
    fn splits_on_carriage_returns_as_well_as_newlines() {
        let raw = b"Counting objects:  50% (1/2)\rCounting objects: 100% (2/2)\rCounting objects: 100% (2/2), done.\nTo remote\r\n\nlast";
        let mut lines = Vec::new();
        split_lines(&raw[..], |l| {
            lines.push(l);
            true
        });
        assert_eq!(
            lines,
            [
                "Counting objects:  50% (1/2)",
                "Counting objects: 100% (2/2)",
                "Counting objects: 100% (2/2), done.",
                "To remote",
                "last",
            ]
        );
    }

    #[test]
    fn a_line_split_across_reads_is_put_back_together() {
        // A reader that hands over three bytes at a time, as a pipe may.
        struct Trickle<'a>(&'a [u8]);
        impl Read for Trickle<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.0.len().min(3).min(buf.len());
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        let mut lines = Vec::new();
        split_lines(Trickle(b"Writing objects:  33% (1/3)\rdone\n"), |l| {
            lines.push(l);
            true
        });
        assert_eq!(lines, ["Writing objects:  33% (1/3)", "done"]);
    }
}
