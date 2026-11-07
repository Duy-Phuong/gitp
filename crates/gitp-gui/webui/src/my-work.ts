// "What did I do" (Quick Launch): the user's commits in their recent and
// starred repositories and their pull requests on GitHub since a day, summed
// up by Claude for a stand-up, in the Explain dialog with Copy.

import { claudeMyWork } from "./api";
import { copyText } from "./clipboard";
import { inboxPaths } from "./inbox";
import { ASK_COMMANDS, loadFavoriteRepos, loadRecentRepos, withClaudeChoice } from "./prefs";
import { opFailed, reportDone } from "./report";
import { state } from "./app-state";
import { openAskDialog } from "./views/ask-dialog";

const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const back = (from: Date, days: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() - days);

// The days to start from: the last working day (Friday on a Monday), and
// the last week and two.
export function sinceChoices(now: Date): { label: string; day: string }[] {
  const monday = now.getDay() === 1;
  return [
    monday ? { label: "Since Friday", day: day(back(now, 3)) } : { label: "Since yesterday", day: day(back(now, 1)) },
    { label: "Last 7 days", day: day(back(now, 7)) },
    { label: "Last 14 days", day: day(back(now, 14)) },
  ];
}

export function myWorkAction(since: string, label: string): void {
  // The open repository first, then the recent and starred ones.
  const repos = [...new Set([state.repoPath, ...inboxPaths(loadRecentRepos(), loadFavoriteRepos())].filter(Boolean))];
  openAskDialog(`What I did · ${label.toLowerCase()}`, () => claudeMyWork(since, repos, withClaudeChoice(ASK_COMMANDS.myWork)), {
    copy: (text: string) => void copyText(text, "Copied."),
    reportDone,
    reportError: opFailed,
  });
}
