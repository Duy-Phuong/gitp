//! Embedded terminal: real PTYs running the user's shell, rooted at the open
//! repo. There can be several sessions (a tab strip per repo), each keyed by an
//! id the frontend picks. Output is streamed to the frontend via the
//! `terminal-output` event, tagged with that id; input, resize and kill come
//! back as commands naming it. Independent of `gitp-core` — this is the raw
//! `git`-by-hand path.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Every live terminal session, by id. Shared with each session's reader
/// thread, which removes its own entry when the shell exits.
#[derive(Default)]
pub struct TerminalState(Arc<Mutex<HashMap<u32, Arc<Session>>>>);

/// One shell on one PTY. Each part has its own lock so a write blocked on a
/// stalled shell holds up neither the other sessions nor this one's kill.
pub struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

impl Session {
    /// Stop the shell and reap it. Called once, by whoever took the session
    /// out of the map; dropping the session afterwards closes the PTY master,
    /// which ends the reader thread.
    fn end(&self) {
        let Ok(mut child) = self.child.lock() else { return };
        // Already exited (the user typed `exit`): reap it, and don't signal a
        // pid that may by now belong to some other process.
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        // SIGHUP, as closing a terminal window sends — the shell passes it on
        // to its jobs — then SIGKILL if it's still there after a grace period.
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// A chunk of output from session `id`.
#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: String,
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl TerminalState {
    /// Start `cmd` on a new PTY as session `id`, replacing (and ending) any
    /// session already under that id — a reloaded webview numbers its tabs
    /// from 1 again. `on_output` gets each decoded chunk and returns false to
    /// stop reading; `on_exit` runs if the shell exits by itself rather than
    /// being killed. Returns the reader thread, which ends once the PTY closes.
    fn spawn(
        &self,
        id: u32,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        mut on_output: impl FnMut(String) -> bool + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<JoinHandle<()>, String> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(s)?;
        let child = pair.slave.spawn_command(cmd).map_err(s)?;
        drop(pair.slave); // not needed in this process once the child holds it

        let mut reader = pair.master.try_clone_reader().map_err(s)?;
        let writer = pair.master.take_writer().map_err(s)?;
        let session = Arc::new(Session {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
        });
        // Weak, so the reader doesn't keep a killed session's PTY open.
        let this = Arc::downgrade(&session);
        let replaced = self.0.lock().map_err(s)?.insert(id, session);
        if let Some(old) = replaced {
            old.end();
        }

        // Stream PTY output until the shell exits or is killed. A larger
        // buffer means a fast producer (`cat` of a big file, a build log) costs
        // one event per 32 KiB rather than per 4 KiB.
        let sessions = self.0.clone();
        Ok(std::thread::spawn(move || {
            let mut buf = [0u8; 32 * 1024];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = decode_chunk(&mut pending, &buf[..n]);
                        if !chunk.is_empty() && !on_output(chunk) {
                            break;
                        }
                    }
                }
            }
            // Still in the map means nobody killed it: the shell went away on
            // its own. Take it out (only if it is still this session — the id
            // may have been reused) and reap it.
            let exited = match sessions.lock() {
                Ok(mut map) if map.get(&id).is_some_and(|s| Arc::as_ptr(s) == this.as_ptr()) => map.remove(&id),
                _ => None,
            };
            if let Some(gone) = exited {
                gone.end();
                on_exit();
            }
        }))
    }

    fn get(&self, id: u32) -> Result<Option<Arc<Session>>, String> {
        Ok(self.0.lock().map_err(s)?.get(&id).cloned())
    }

    fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        if let Some(session) = self.get(id)? {
            let mut writer = session.writer.lock().map_err(s)?;
            writer.write_all(data).map_err(s)?;
            writer.flush().map_err(s)?;
        }
        Ok(())
    }

    fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(session) = self.get(id)? {
            session.master.lock().map_err(s)?.resize(size(cols, rows)).map_err(s)?;
        }
        Ok(())
    }

    fn kill(&self, id: u32) -> Result<(), String> {
        let gone = self.0.lock().map_err(s)?.remove(&id);
        if let Some(session) = gone {
            session.end();
        }
        Ok(())
    }
}

/// Start session `id` running the user's shell in `cwd`. Returns the shell's
/// name (`zsh`), which the frontend titles the tab with.
#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<TerminalState>,
    id: u32,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let name = shell.rsplit('/').next().unwrap_or(&shell).to_string();
    let mut cmd = CommandBuilder::new(shell);
    // A login shell, as Terminal.app and iTerm start: an app launched from
    // Finder gets launchd's bare PATH, and only the login profile
    // (path_helper, `brew shellenv`, …) adds Homebrew and friends to it.
    cmd.arg("-l");
    if !cwd.is_empty() && cwd != "." {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    // Finder-launched apps get no locale either, leaving the shell in US-ASCII.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let out = app.clone();
    state.spawn(
        id,
        cmd,
        cols,
        rows,
        move |data| out.emit("terminal-output", Output { id, data }).is_ok(),
        // The frontend closes the tab of a shell that exited.
        move || {
            let _ = app.emit("terminal-exit", id);
        },
    )?;
    Ok(name)
}

/// Decode `bytes` as UTF-8, carrying an incomplete trailing character over
/// in `pending` to be completed by the next read: a PTY read ends wherever
/// the buffer does, so a multi-byte character (an accented letter, a box
/// drawing glyph, an emoji) split across two reads would otherwise come out
/// as two replacement characters.
fn decode_chunk(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    // Everything up to `end` is either valid or outright invalid (decoded
    // lossily below); only an incomplete sequence at the very end is held.
    let mut end = 0;
    loop {
        match std::str::from_utf8(&pending[end..]) {
            Ok(_) => {
                end = pending.len();
                break;
            }
            Err(e) => match e.error_len() {
                Some(bad) => end += e.valid_up_to() + bad,
                None => {
                    end += e.valid_up_to();
                    break;
                }
            },
        }
    }
    let text = String::from_utf8_lossy(&pending[..end]).into_owned();
    pending.drain(..end);
    text
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{channel, Receiver};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use portable_pty::CommandBuilder;

    use super::{decode_chunk, TerminalState};

    #[test]
    fn a_character_split_across_reads_is_reassembled() {
        let bytes = "ab→c".as_bytes(); // → is 3 bytes: e2 86 92
        let mut pending = Vec::new();
        assert_eq!(decode_chunk(&mut pending, &bytes[..3]), "ab");
        assert_eq!(pending, &bytes[2..3]);
        assert_eq!(decode_chunk(&mut pending, &bytes[3..]), "→c");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_are_replaced_rather_than_held() {
        let mut pending = Vec::new();
        assert_eq!(decode_chunk(&mut pending, b"a\xffb"), "a\u{fffd}b");
        assert!(pending.is_empty());
        // An invalid byte followed by the start of a character: the byte is
        // replaced, the partial character still waits for its rest.
        assert_eq!(decode_chunk(&mut pending, b"\xff\xe2\x86"), "\u{fffd}");
        assert_eq!(pending, b"\xe2\x86");
        assert_eq!(decode_chunk(&mut pending, b"\x92"), "\u{2192}");
    }

    // Output from `id`, read until it contains `needle`.
    fn wait_for(rx: &Receiver<(u32, String)>, seen: &mut [String; 3], id: u32, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !seen[id as usize].contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            let (from, data) = rx.recv_timeout(left).unwrap_or_else(|_| panic!("no {needle:?} from session {id}"));
            seen[from as usize].push_str(&data);
        }
    }

    fn joins_soon(reader: &JoinHandle<()>) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !reader.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        reader.is_finished()
    }

    #[test]
    fn sessions_are_separate_and_a_killed_one_is_released() {
        let terms = TerminalState::default();
        let (tx, rx) = channel();
        let spawn = |id: u32| {
            let (out, exit) = (tx.clone(), tx.clone());
            let on_output = move |data| out.send((id, data)).is_ok();
            let on_exit = move || drop(exit.send((id, "<exited>".to_string())));
            terms.spawn(id, CommandBuilder::new("/bin/sh"), 80, 24, on_output, on_exit).unwrap()
        };
        let one = spawn(1);
        let two = spawn(2);
        let mut seen = [String::new(), String::new(), String::new()];

        // The arithmetic is only evaluated by the shell, so the echoed command
        // line doesn't count as the output.
        terms.write(1, b"echo one-$((40+2))\n").unwrap();
        terms.write(2, b"echo two-$((50+5))\n").unwrap();
        wait_for(&rx, &mut seen, 1, "one-42");
        wait_for(&rx, &mut seen, 2, "two-55");
        assert!(!seen[1].contains("two-"), "session 1 saw session 2's output");
        assert!(!seen[2].contains("one-"), "session 2 saw session 1's output");

        // Killing one ends its shell and its reader thread (which holds the
        // last PTY descriptor) and forgets it; the other carries on.
        terms.kill(1).unwrap();
        assert!(joins_soon(&one), "the killed session's reader thread is still running");
        assert!(!terms.0.lock().unwrap().contains_key(&1));
        terms.write(1, b"echo ignored\n").unwrap(); // a gone session is a no-op
        terms.write(2, b"echo still-$((1+1))\n").unwrap();
        wait_for(&rx, &mut seen, 2, "still-2");

        // A shell that exits by itself is removed and reaped as well, and
        // reported — unlike the killed one, whose tab is already gone.
        terms.write(2, b"exit\n").unwrap();
        assert!(joins_soon(&two), "the exited session's reader thread is still running");
        assert!(terms.0.lock().unwrap().is_empty());
        wait_for(&rx, &mut seen, 2, "<exited>");
        while let Ok((from, data)) = rx.try_recv() {
            seen[from as usize].push_str(&data);
        }
        assert!(!seen[1].contains("<exited>"));
    }
}

// `(async)`: a write to the PTY blocks while the child isn't reading (a
// paused pager, a stopped job), and a plain command runs on the webview's
// thread, so a large paste into a stalled shell would freeze the window.
#[tauri::command(async)]
pub fn terminal_write(id: u32, data: String, state: State<TerminalState>) -> Result<(), String> {
    state.write(id, data.as_bytes())
}

#[tauri::command(async)]
pub fn terminal_resize(id: u32, cols: u16, rows: u16, state: State<TerminalState>) -> Result<(), String> {
    state.resize(id, cols, rows)
}

// `(async)`: ending a shell waits out its SIGHUP grace period (up to 250ms).
#[tauri::command(async)]
pub fn terminal_kill(id: u32, state: State<TerminalState>) -> Result<(), String> {
    state.kill(id)
}
