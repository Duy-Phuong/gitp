//! "Explain with Claude": the text a Claude run reads for a commit, a branch
//! or a release, and the run itself. Read-only: the git calls only read, and
//! the command's own tool list keeps Claude from changing anything.

use crate::error::{Error, Result};
use crate::remote::ref_arg;
use crate::repo::Repo;

/// The most of a diff sent: past this the text is cut, with a note.
const MAX_INPUT: usize = 200_000;
/// The most commits a release's notes are written from.
const MAX_COMMITS: &str = "-500";

/// What is explained: a commit, a branch against the default branch, or the
/// commits of a tag since the tag before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskKind {
    Commit,
    Branch,
    Release,
}

impl AskKind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "commit" => AskKind::Commit,
            "branch" => AskKind::Branch,
            "release" => AskKind::Release,
            _ => return None,
        })
    }
}

fn cut(mut text: String) -> String {
    if text.len() > MAX_INPUT {
        let mut end = MAX_INPUT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n\n[The rest of the diff was cut: it is too long to send.]\n");
    }
    text
}

impl Repo {
    /// The text for `kind` about `target` (a sha, a branch or a tag), and the
    /// range it covers in words, for the job's label.
    pub fn claude_ask_input(&self, kind: AskKind, target: &str) -> Result<(String, String)> {
        let t = ref_arg(target)?;
        match kind {
            AskKind::Commit => {
                let text = self.run_git(&["show", "--stat", "--patch", "--format=fuller", t])?;
                Ok((cut(text), target.to_string()))
            }
            AskKind::Branch => {
                let base = self.default_review_base()?;
                let range = format!("{base}..{t}");
                let log = self.run_git(&[
                    "log",
                    "--reverse",
                    "--format=commit %h%n%an, %ad%n%n%s%n%n%b",
                    &range,
                ])?;
                if log.trim().is_empty() {
                    return Err(Error::Message(format!(
                        "{target} has no commits that {base} doesn't have."
                    )));
                }
                let three = format!("{base}...{t}");
                let stat = self.run_git(&["diff", "--stat", &three])?;
                let diff = self.run_git(&["diff", &three])?;
                let text = format!("Branch {target}, compared with {base}.\n\n# Commits, oldest first\n\n{log}\n# Files\n\n{stat}\n# Diff\n\n{diff}");
                Ok((cut(text), format!("{target} vs {base}")))
            }
            AskKind::Release => {
                let parent = format!("{t}^");
                let previous = self
                    .run_git(&["describe", "--tags", "--abbrev=0", &parent])
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let range = match &previous {
                    Some(p) => format!("{p}..{t}"),
                    None => t.to_string(),
                };
                let log = self.run_git(&[
                    "log",
                    MAX_COMMITS,
                    "--format=- %h %s (%an)%n%w(0,2,2)%b",
                    &range,
                ])?;
                let stat = match &previous {
                    Some(_) => self
                        .run_git(&["diff", "--shortstat", &range])
                        .unwrap_or_default(),
                    None => String::new(),
                };
                let since = previous
                    .clone()
                    .unwrap_or_else(|| "the first commit".into());
                let text = format!(
                    "Release {target}, the commits since {since}, newest first.\n\n{log}\n{stat}"
                );
                Ok((cut(text), format!("{target} since {since}")))
            }
        }
    }

    /// Run shell line `command` in the work tree with `input` on its stdin;
    /// its answer is what it printed (the `result` of a `claude -p
    /// --output-format json` run).
    pub fn run_claude(&self, command: &str, input: &str) -> Result<String> {
        let out = crate::gh::run_shell(
            &self.workdir_path()?,
            command,
            input.as_bytes(),
            &[],
            crate::gh::EXPLAIN_TIMEOUT,
            &self.net,
        )?;
        crate::gh::claude_answer(&out.stdout).map(|(text, _)| text)
    }
}
