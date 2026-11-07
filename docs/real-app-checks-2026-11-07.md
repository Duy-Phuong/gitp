# Real-app checks — features of 2026-11-07

Everything below passed its unit tests and was looked at in the browser preview
(mock data). None of it has been tried in the real app against real git, GitHub
and Claude. Tick each line once it behaves as written.

## Background work and quitting

- [ ] **Unpushed badge.** Commit on the default branch without pushing. The status
      bar shows "↑1 unpushed on main". Click it: the branch is pushed and the
      badge goes.
- [ ] **Quit warning.** With an unpushed commit on the default branch, press ⌘Q.
      gitp asks first and names the repository. Cancel keeps it open; Quit closes.
- [ ] **Quit with Claude jobs.** Start a Claude review, then ⌘Q. The same dialog
      lists the running job as well.
- [ ] **Desktop notification.** Start a Claude job, switch to another app, wait for
      it to finish. A macOS notification arrives (sender may read "Script Editor").
      Settings › Notifications › Claude jobs Off stops them.
- [ ] **Failed check / review request notification.** Needs a real PR: within
      5 minutes of a check failing on your PR, or a review being asked of you,
      a notification arrives while gitp is in the background.

## Claude

- [ ] **Explain with Claude** (right-click a commit). A dialog shows Markdown;
      Copy copies it. Close it before the answer lands: a toast brings it back.
- [ ] **Summarize with Claude** (right-click a branch that is ahead of main).
- [ ] **Release Notes with Claude** (right-click a tag).

## Storage and settings

- [ ] **Clean Up Storage** (Quick Launch). Worktrees show sizes; the safe ones are
      ticked; Remove deletes the folders. Merged branches delete, and Undo brings
      them back. Build folders show sizes and Show in Finder.
- [ ] **Settings search.** Type "notif" in the box above the tabs: rows from the
      Notifications tab show. Clear it: the tab you were on comes back.

## Pull requests — speed

- [ ] **Hover read-ahead.** Rest the pointer on a PR in the sidebar for a moment,
      then click it: it opens with little or no "Loading pull request…".
- [ ] **Back to an opened PR.** Open PR A, then B, then A again: A shows at once.
- [ ] **After a restart.** Open a PR, quit gitp, start it, open the same PR: it
      shows at once, then refreshes.
- [ ] **PR list after a repo switch or restart.** The sidebar's Pull Requests list
      shows its rows at once, without "Loading…".
- [ ] **Files tab.** Open the Files tab: no "Loading the changed files…" wait.
      On a PR with 100+ files, the first files show at once and the scrollbar
      settles as the rest draw; a click in the file tree lands on its file.
- [ ] **Commits tab.** Open a commit, then Next ›: it shows at once.
- [ ] **No false "Updated".** Leave a PR open 2–3 minutes with nothing changing on
      GitHub: no "Updated" notice appears.

## Small UI fixes

- [ ] **Refresh icons** in the Pull Requests view, the Review inbox and the sidebar's
      Pull Requests section are the line icon, readable at a glance.
- [ ] **Pull menu.** Every item is on one line.
- [ ] **Branch menu.** Type part of a ticket number: the list narrows; ↓ / ↑ pick;
      Enter checks out. A name with no match + Enter moves it to New branch name.
      With many branches the New branch row stays visible.
- [ ] **Diverged pull dialog.** Not testable on this machine as set up: the global
      `pull.rebase=false` makes "Pull (fast-forward if possible)" merge instead of
      stopping. On a machine without it, a pull with commits on both sides shows
      the dialog with Rebase and Merge.
