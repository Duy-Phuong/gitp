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
    if !cwd.is_empty() && cwd != "." {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(s)?;
    drop(pair.slave); // not needed in this process once the child holds it

    let mut reader = pair.master.try_clone_reader().map_err(s)?;
    let writer = pair.master.take_writer().map_err(s)?;

    // Stream PTY output to the frontend until the shell exits.
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app_handle.emit("terminal-output", chunk).is_err() {
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

#[tauri::command]
pub fn terminal_write(data: String, state: State<TerminalState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(s)?;
    if let Some(session) = guard.as_mut() {
        session.writer.write_all(data.as_bytes()).map_err(s)?;
        session.writer.flush().map_err(s)?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(cols: u16, rows: u16, state: State<TerminalState>) -> Result<(), String> {
    let guard = state.0.lock().map_err(s)?;
    if let Some(session) = guard.as_ref() {
        session.master.resize(size(cols, rows)).map_err(s)?;
    }
    Ok(())
}
