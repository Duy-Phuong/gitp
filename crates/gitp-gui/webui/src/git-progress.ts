// The short form of a `git-progress` event shown in the status bar: the phase,
// its percentage, and the transfer rate when git reports one —
// "Receiving objects 45% · 2.0 MiB/s". The full line goes in the tooltip.

import type { GitProgress } from "./types";

export function formatGitProgress(p: GitProgress): string {
  let text = p.phase;
  if (p.percent !== null) text += ` ${p.percent}%`;
  // git appends "| <rate>" to transfer meters, and ", done." to the last one.
  const rate = p.detail.split("|")[1]?.replace(/,\s*done\.$/, "").trim();
  if (rate) text += ` · ${rate}`;
  return text;
}
