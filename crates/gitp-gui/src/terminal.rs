//! Embedded terminal: a real PTY running the user's shell, rooted at the open
//! repo. Output is streamed to the frontend via the `terminal-output` event;
//! input and resize come back as commands. Independent of `gitp-core` — this is
//! the raw `git`-by-hand path.

use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// The single active terminal session (v1 supports one).
#[derive(Default)]
pub struct TerminalState(pub Mutex<Option<Session>>);

pub struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    // Held so the child process stays alive with the session.
    _child: Box<dyn Child + Send + Sync>,
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

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<TerminalState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(s)?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
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
    let child = pair.slave.spawn_command(cmd).map_err(s)?;
    drop(pair.slave); // not needed in this process once the child holds it

    let mut reader = pair.master.try_clone_reader().map_err(s)?;
    let writer = pair.master.take_writer().map_err(s)?;

    // Stream PTY output to the frontend until the shell exits. A larger
    // buffer means a fast producer (`cat` of a big file, a build log) costs
    // one event per 32 KiB rather than per 4 KiB.
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = decode_chunk(&mut pending, &buf[..n]);
                    if !chunk.is_empty() && app_handle.emit("terminal-output", chunk).is_err() {
                        break;
                    }
                }
            }
        }
    });

    *state.0.lock().map_err(s)? = Some(Session {
        writer,
        master: pair.master,
        _child: child,
    });
    Ok(())
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
    use super::decode_chunk;

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
}

// `(async)`: a write to the PTY blocks while the child isn't reading (a
// paused pager, a stopped job), and a plain command runs on the webview's
// thread, so a large paste into a stalled shell would freeze the window.
#[tauri::command(async)]
pub fn terminal_write(data: String, state: State<TerminalState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(s)?;
    if let Some(session) = guard.as_mut() {
        session.writer.write_all(data.as_bytes()).map_err(s)?;
        session.writer.flush().map_err(s)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn terminal_resize(cols: u16, rows: u16, state: State<TerminalState>) -> Result<(), String> {
    let guard = state.0.lock().map_err(s)?;
    if let Some(session) = guard.as_ref() {
        session.master.resize(size(cols, rows)).map_err(s)?;
    }
    Ok(())
}
