// What a quit waits on (quit.rs): Claude jobs still running, and default
// branches with commits only this machine has. The words for the status-bar
// badge and the quit dialog.

export interface Unpushed {
  branch: string;
  ahead: number;
}

export interface UnpushedRepo extends Unpushed {
  repo: string;
}

export interface QuitCheck {
  jobs: string[];
  unpushed: UnpushedRepo[];
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

export function unpushedLabel(u: Unpushed): string {
  return `↑${u.ahead} unpushed on ${u.branch}`;
}

export function unpushedTitle(u: Unpushed): string {
  return `${commits(u.ahead)} on ${u.branch} that its remote doesn't have yet. Click to push ${u.branch}.`;
}

// The dialog's question, and its OK button: Stop and quit when jobs run.
export function quitQuestion(c: QuitCheck): { message: string; ok: string } {
  const parts: string[] = [];
  const n = c.jobs.length;
  if (n) {
    const which = n <= 3 ? `\n${c.jobs.map((l) => `• ${l}`).join("\n")}` : "";
    parts.push(`${n} Claude job${n === 1 ? " is" : "s are"} running.${which}`);
  }
  if (c.unpushed.length) {
    parts.push(`Not pushed yet:\n${c.unpushed.map((u) => `• ${u.repo}: ${commits(u.ahead)} on ${u.branch}`).join("\n")}`);
  }
  const ask = n ? `Stop ${n === 1 ? "it" : "them"} and quit?` : "Quit anyway?";
  return { message: `${parts.join("\n\n")}\n\n${ask}`, ok: n ? "Stop and quit" : "Quit" };
}
