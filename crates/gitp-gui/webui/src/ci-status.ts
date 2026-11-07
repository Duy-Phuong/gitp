// The CI of the branch checked out, as GitHub Actions ran it on its newest
// pushed commit: what the status bar badge says, and when a failure is worth
// a desktop notification.

export interface BranchCi {
  state: "success" | "failure" | "running" | "none";
  sha: string;
  url: string;
  workflow: string;
  title: string;
}

const STATE_WORD: Record<BranchCi["state"], string> = { success: "passed", failure: "failed", running: "is running", none: "" };

// The badge's text, or null to hide it (no run).
export function ciLabel(ci: BranchCi): string | null {
  if (ci.state === "none") return null;
  return ci.state === "success" ? "CI ✓" : ci.state === "failure" ? "CI ✗" : "CI …";
}

const which = (ci: BranchCi) => `${ci.workflow} · ${ci.title} (${ci.sha.slice(0, 7)})`;

export function ciTitle(ci: BranchCi, branch: string): string {
  return `CI ${STATE_WORD[ci.state]} on ${branch}: ${which(ci)}. Click to open the run.`;
}

// A notification when the CI is newly failed: not again for the same commit,
// and not on the first look (it may have failed long ago).
export function ciNote(before: BranchCi | null, now: BranchCi, branch: string): { title: string; body: string; target: string } | null {
  if (!before || now.state !== "failure") return null;
  if (before.state === "failure" && before.sha === now.sha) return null;
  return { title: `CI failed on ${branch}`, body: which(now), target: `url:${now.url}` };
}
