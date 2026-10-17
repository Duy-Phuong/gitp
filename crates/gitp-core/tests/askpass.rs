//! Credential prompts for the network commands: with an askpass program in the
//! hooks, git (and ssh) ask it for what they're missing instead of failing.
//!
//! No real dialog and no real server: a fake askpass script logs its prompt and
//! prints a canned answer, and a tiny HTTP server on 127.0.0.1 demands Basic
//! auth and records what comes back — proof that git called our askpass and
//! sent its answer. The ssh side is checked through an `ext::` remote that
//! dumps the environment git hands its transport.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gitp_core::{Error, NetworkHooks, Repo};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {dir:?}");
}

/// Write an executable `sh` script.
fn script(path: &Path, body: &str) -> PathBuf {
    std::fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path.to_path_buf()
}

/// An askpass that appends each prompt to `log` and answers `user` to a
/// username prompt, `pass` to anything else.
fn fake_askpass(dir: &Path, name: &str, user: &str, pass: &str) -> (PathBuf, PathBuf) {
    let log = dir.join(format!("{name}.log"));
    let path = script(
        &dir.join(name),
        &format!(
            "printf '%s\\n' \"$1\" >> '{}'\ncase \"$1\" in Username*) echo {user} ;; *) echo {pass} ;; esac\n",
            log.display()
        ),
    );
    (path, log)
}

/// An HTTP server that answers every request with a Basic-auth challenge and
/// records each request's `Authorization` header (or `None`).
fn auth_server() -> (String, Arc<Mutex<Vec<Option<String>>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/repo.git", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut auth = None;
            for line in BufReader::new(&stream).lines() {
                let Ok(line) = line else { break };
                if line.is_empty() {
                    break;
                }
                if let Some(v) = line.strip_prefix("Authorization: ") {
                    auth = Some(v.to_string());
                }
            }
            sink.lock().unwrap().push(auth);
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"gitp\"\r\n\
                  Content-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    });
    (url, seen)
}

/// A repo whose `origin` is `url`, with every credential helper (the user's
/// osxkeychain included) switched off so git has to ask.
fn repo_with_remote(url: &str) -> TempDir {
    let dir = TempDir::new().unwrap();
    git(dir.path(), &["init", "-q"]);
    git(dir.path(), &["remote", "add", "origin", url]);
    git(dir.path(), &["config", "credential.helper", ""]);
    dir
}

fn open(dir: &Path, askpass: Option<PathBuf>) -> Repo {
    let mut repo = Repo::open(dir).unwrap();
    repo.set_network_hooks(NetworkHooks {
        askpass,
        ..Default::default()
    });
    repo
}

#[test]
fn git_asks_the_askpass_and_sends_its_answer() {
    let (url, seen) = auth_server();
    let work = repo_with_remote(&url);
    let tools = TempDir::new().unwrap();
    let (askpass, log) = fake_askpass(tools.path(), "askpass", "alice", "s3cret");

    let err = open(work.path(), Some(askpass)).fetch_all();
    assert!(err.is_err(), "the server never lets anyone in");

    let prompts = std::fs::read_to_string(&log).expect("askpass was called");
    assert!(
        prompts.starts_with("Username for 'http://127.0.0.1:"),
        "{prompts}"
    );
    assert!(
        prompts.contains("Password for 'http://alice@127.0.0.1:"),
        "{prompts}"
    );
    assert!(
        seen.lock()
            .unwrap()
            .contains(&Some("Basic YWxpY2U6czNjcmV0".into())),
        "git sent alice:s3cret"
    );
}

#[test]
fn without_an_askpass_git_fails_without_asking() {
    if askpass_set_by_environment() {
        return;
    }
    let (url, seen) = auth_server();
    let work = repo_with_remote(&url);

    let err = open(work.path(), None)
        .fetch_all()
        .expect_err("no credentials");
    assert!(
        err.to_string().contains("terminal prompts disabled"),
        "{err}"
    );
    assert!(seen.lock().unwrap().iter().all(Option::is_none));
}

#[test]
fn a_core_askpass_of_the_users_own_wins() {
    if askpass_set_by_environment() {
        return;
    }
    let (url, seen) = auth_server();
    let work = repo_with_remote(&url);
    let tools = TempDir::new().unwrap();
    let (ours, our_log) = fake_askpass(tools.path(), "ours", "alice", "s3cret");
    let (theirs, their_log) = fake_askpass(tools.path(), "theirs", "user", "fromuser");
    git(
        work.path(),
        &["config", "core.askPass", theirs.to_str().unwrap()],
    );

    let _ = open(work.path(), Some(ours)).fetch_all();

    assert!(!our_log.exists(), "ours is never called");
    assert!(their_log.exists(), "the user's askpass is");
    assert!(seen
        .lock()
        .unwrap()
        .contains(&Some("Basic dXNlcjpmcm9tdXNlcg==".into())));
}

/// The environment git gives its transport for a fetch from a repo whose
/// remote is an `ext::` command that records it.
fn transport_env(askpass: Option<PathBuf>) -> String {
    let tools = TempDir::new().unwrap();
    let dump = tools.path().join("env.txt");
    let remote = script(
        &tools.path().join("remote"),
        &format!("env > '{}'\nexit 1\n", dump.display()),
    );
    let work = repo_with_remote(&format!("ext::{}", remote.display()));
    git(work.path(), &["config", "protocol.ext.allow", "always"]);

    let _ = open(work.path(), askpass).fetch_all();
    std::fs::read_to_string(&dump).expect("the transport ran")
}

fn var<'a>(env: &'a str, name: &str) -> Option<&'a str> {
    env.lines()
        .find_map(|l| l.strip_prefix(name)?.strip_prefix('='))
}

#[test]
fn ssh_is_pointed_at_the_askpass_too() {
    let askpass = PathBuf::from("/opt/gitp/askpass");
    let env = transport_env(Some(askpass));

    assert_eq!(var(&env, "GIT_ASKPASS"), Some("/opt/gitp/askpass"));
    assert_eq!(var(&env, "SSH_ASKPASS"), Some("/opt/gitp/askpass"));
    assert_eq!(var(&env, "SSH_ASKPASS_REQUIRE"), Some("force"));
    assert!(var(&env, "DISPLAY").is_some_and(|d| !d.is_empty()));
    assert_eq!(var(&env, "GIT_TERMINAL_PROMPT"), Some("0"));
}

#[test]
fn without_an_askpass_the_environment_is_left_alone() {
    let env = transport_env(None);
    for name in [
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
        "DISPLAY",
    ] {
        assert_eq!(
            var(&env, name),
            std::env::var(name).ok().as_deref(),
            "{name} is passed through as it was"
        );
    }
}

#[test]
fn cancel_takes_an_open_prompt_down_with_git() {
    let (url, _) = auth_server();
    let work = repo_with_remote(&url);
    let tools = TempDir::new().unwrap();
    // A prompt nobody answers: it records its pid, then waits, as a dialog
    // left on screen would.
    let pid_file = tools.path().join("pid");
    let askpass = script(
        &tools.path().join("askpass"),
        &format!("echo $$ > '{}'\nsleep 30\n", pid_file.display()),
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let mut repo = Repo::open(work.path()).unwrap();
    repo.set_network_hooks(NetworkHooks {
        cancel: Some(Arc::clone(&cancel)),
        askpass: Some(askpass),
        ..Default::default()
    });
    let watcher = std::thread::spawn(move || {
        let start = Instant::now();
        while !pid_file.exists() && start.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(100));
        cancel.store(true, Ordering::SeqCst);
        let pid = std::fs::read_to_string(&pid_file).expect("the prompt opened");
        (pid, Instant::now())
    });

    assert!(matches!(repo.fetch_all(), Err(Error::Cancelled)));
    let (pid, cancelled_at) = watcher.join().unwrap();
    assert!(cancelled_at.elapsed() < Duration::from_secs(5), "no hang");

    let pid = pid.trim().to_string();
    let gone = (0..50).any(|_| {
        std::thread::sleep(Duration::from_millis(20));
        !Command::new("kill")
            .args(["-0", &pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    });
    assert!(gone, "the prompt (pid {pid}) went away with git");
}

/// Whether the shell running the tests exports its own askpass (VS Code's
/// terminal sets GIT_ASKPASS). git prefers that over both `core.askPass` and
/// "no askpass at all", so the two tests that assert those cases would fail for
/// reasons that have nothing to do with gitp; they skip instead.
fn askpass_set_by_environment() -> bool {
    let set = ["GIT_ASKPASS", "SSH_ASKPASS"]
        .iter()
        .any(|v| std::env::var_os(v).is_some());
    if set {
        eprintln!("skipped: GIT_ASKPASS or SSH_ASKPASS is set in this environment");
    }
    set
}
