# gitp vs GitKraken Desktop — feature gaps (2026-10-30)

Source: every page under **Working With Files**, **Working with Commits** and
**Working with Repositories** in the GitKraken Desktop help
(https://help.gitkraken.com/gitkraken-desktop/), compared with what gitp
implements today (menus, Quick Launch, Tauri commands, `gitp-core`).

Size: **S** ≈ a few hours, **M** ≈ a day, **L** ≈ several days.

## What gitp already matches (no work needed)

Staging by file / hunk / line, discard by file / hunk / line (undoable), add to
`.gitignore`, amend, GPG/SSH signing, revert, reset soft/mixed/hard, cherry-pick
(single and queued multi), squash / fixup / reword / edit / drop, interactive
rebase editor (with reorder and keyboard keys), 3-way conflict editor with
take-ours/theirs, unified/split diff, word diff, prev/next change, file history,
blame, compare refs (2-dot/3-dot), commit search (richer than GitKraken:
`author:` `path:` `content:` `after:` `before:`), one-step undo/redo (covers more
actions than GitKraken's list), pull modes + default, push with
force-with-lease, set/unset upstream, fetch per remote, stash apply/pop/rename/
delete, tags (create, push, delete local+remote), worktrees (add, open, lock,
remove, prune), submodules (open, update, sync), bisect, reflog, embedded
terminal, repo tabs + restored workspace, recent repos, Quick Launch palette,
themes including GitKraken.

## Gaps, by priority

### P1 — everyday workflow (do first)

| # | Feature | GitKraken | gitp today | Size |
|---|---------|-----------|------------|------|
| 1 | **Clone repository** | URL + destination, opens after; options: branch, depth, since date, extra flags | none (only "Open") | M |
| 2 | **Init repository** | path, optional `.gitignore` template + license, creates README, opens it | none | S |
| 3 | **Commit options** | "Skip Git hooks", "Push after committing", `commit.template` prefill (strip `#` lines), Cmd/Ctrl+Enter to commit | none of the three; hooks always run | S |
| 4 | **Stash with a message / staged only** | name + description when stashing; stash staged changes only | toolbar stash has no message; no `--staged` (rename exists) | S |
| 5 | **Annotated tags** | "Create annotated tag here" with message; annotation as tooltip | lightweight only (details view reads annotated ones) | S |
| 6 | **Merge options** | squash-merge behaviour preference; ff-only / no-ff via menu | plain `git merge` only | S |
| 7 | **Manage remotes** | add remote (URL), edit, remove; push to any remote | none — push / PR / delete hard-code `origin` | M |
| 8 | **Diff toggles** | word-wrap toggle; (gitp extra: ignore whitespace) | neither | S |
| 9 | **Detached HEAD banner** | "You are in a detached HEAD state" + Create branch here | warning only on checkout; no banner | S |
| 10 | **Better ignore** | ignore this file / all `*.ext` / whole folder; tracked file → "Ignore and stop tracking" | adds exact paths, untracked files only | S |

### P2 — GitKraken's signature graph interactions

| # | Feature | GitKraken | gitp today | Size |
|---|---------|-----------|------------|------|
| 11 | **WIP node in the graph** | row at the top of the graph for uncommitted changes; click opens the commit panel; one per worktree | Local Changes is a separate sidebar view | M |
| 12 | **Drag and drop refs** | drag a branch onto a branch → Merge / Rebase / Interactive rebase / Reset / Push / Start PR; drag onto a remote branch to push | none in the graph or sidebar | M |
| 13 | **Hide / Solo** | hide branches, remotes, tags, stashes from the graph; solo shows only chosen refs; bulk per section; persisted | only "All branches / Current" | L |
| 14 | **Stash nodes in the graph** | stashes drawn as graph nodes with apply/pop/delete/hide menu | stashes only in the sidebar | M |
| 15 | **Pin branch to left / smart visibility** | keep a branch's lane leftmost; show only HEAD + target + upstreams | none | M |

### P3 — diff, history and file tools

| # | Feature | GitKraken | gitp today | Size |
|---|---------|-----------|------------|------|
| 16 | **Combined diff of a commit range** | Shift-select consecutive commits (optionally + WIP) for one diff | Cmd-click two commits compares them; no range/WIP | S |
| 17 | **Compare commit against working directory** | right-click commit/branch | none | S |
| 18 | **Restore file from this commit** | right-click a file in a commit → staged in WIP; multi-select | none | S |
| 19 | **Revert hunk from a commit diff** | per-hunk "Revert" applies the inverse to the working tree | discard only for working-tree hunks | M |
| 20 | **Patches** | create patch from commit(s) / file changes; Apply Patch from a file | "Save as Patch" for working files and stashes only; no apply | S |
| 21 | **Image diff** | images shown old/new | "binary file" placeholder | M |
| 22 | **External diff / merge tool** | Beyond Compare, Kaleidoscope, P4Merge… or `git difftool` config | none | S |
| 23 | **In-app file editor** | edit file, save, "save and stage", create file (with folders), delete file, "view all files" + filter, Markdown preview | "Edit File" opens the OS app | L |
| 24 | **Interactive multi-commit cherry-pick** | reorder + pick/squash/reword/drop before applying | queued cherry-pick without editing | M |

### P4 — repository management and plumbing

| # | Feature | GitKraken | gitp today | Size |
|---|---------|-----------|------------|------|
| 25 | **Favorite repos** | star repos; quick switch Cmd+1…9 | recent list only | S |
| 26 | **Activity log** | per-repo log of every git operation with time + duration; hook output; app log | status bar / toasts only | M |
| 27 | **Submodule add / remove / edit** | "+" add (URL + path), edit, delete, status states | open / update / sync only | M |
| 28 | **Worktree: remove + delete branch** | "Remove worktree and delete branch" | remove only | S |
| 29 | **Terminal tabs** | several tabs per repo/worktree; drag a file in to insert its path | one session | M |
| 30 | **Auto-fetch on a timer** | background fetch every N minutes (preference) | fetch when opening History/Changes, max once a minute | S |
| 31 | **Hooks path preference** | per-repo custom hooks folder | none (editable via Git Config view) | S |
| 32 | **Clone extras** | shallow (depth / since), single branch, sparse checkout, blobless | — (after #1) | M |

## Out of scope (need a GitKraken account, a hosting API or AI)

In-app pull request form and review, forks, Team View, Conflict Prevention,
Launchpad, shared stashes / Cloud Patches, deep links, AI commit and stash
messages, agent sessions. gitp keeps "Create Pull Request" as a browser link.

## Suggested order

1. **Batch A (P1, mostly S):** #2 Init, #3 commit options, #4 stash message,
   #5 annotated tags, #6 merge options, #8 diff toggles, #9 detached banner,
   #10 better ignore — then #1 Clone and #7 remotes (M).
2. **Batch B (the GitKraken feel):** #11 WIP node, #12 drag and drop, #14 stash
   nodes, then #13 Hide/Solo.
3. **Batch C:** P3 diff tools (#16–#20 are small and build on Compare).
4. **Batch D:** P4 as needed; #23 file editor and #21 image diff last.

## Round 2 (chosen 2026-10-30)

Sources: the code-safety review of branch switching, conflicts and undo, plus the
help pages outside the first three sections (Preferences, Command Palette,
Interface Guide, Profiles, Tips, Experimental Features, Themes, Workspaces).
The keyboard-shortcut pack was offered and left out on purpose.

### Code safety

| # | Feature | Today | Size |
|---|---------|-------|------|
| 33 | **Undo fixes** — undo/redo of a *mixed* reset works (it always fails now: `--keep` refuses the files the reset left modified); a refusal says which files are in the way and what to do, instead of git's raw "Entry 'x' not uptodate. Cannot merge." | broken / cryptic | S |
| 34 | **Hard-reset backup** — before a hard reset, save the uncommitted work (tracked and untracked) as a hidden commit under a private ref, without touching the working tree; Undo of that reset brings back the commits *and* the work | undo restores commits only | S–M |
| 35 | **Stash & Switch** — when a checkout has local changes, offer to stash them, switch, and re-apply them on the new branch (like GitKraken's auto-stash), keeping the stash if re-applying conflicts | warn / refuse only | S |
| 36 | **Confirm Take Ours / Theirs** when the file on disk was hand-edited or the resolver holds choices for it | overwrites silently | S |
| 37 | **Squash-merge conflicts** — detected as a conflict session (SQUASH_MSG + unmerged files): the resolver opens, Finish commits with the squash message, Abort restores (`git reset --merge`, drop SQUASH_MSG) | invisible; Abort fails | S |
| 38 | **Editor on-disk check** — Save asks before overwriting a file that changed on disk since it was opened | overwrites | S |

### Graph and interface

| # | Feature | GitKraken | Size |
|---|---------|-----------|------|
| 39 | **Graph columns** | right-click the header (or gear) to show/hide Author, Date, SHA; drag headers to reorder; saved per repo; filter commits by author from the Author column | M |
| 40 | **Branch hover + ghost branch** | hovering a branch fades unrelated commits (toggle in settings); selecting/hovering a commit shows its nearest containing branch as a faded "ghost" label, double-click checks it out | M |
| 41 | **Tabs and zoom** | drag repo tabs to reorder; right-click → alias a tab; Cmd/Ctrl+Tab and Shift+Cmd/Ctrl+Tab cycle tabs; zoom in/out/reset (Cmd = / − / 0) with preset levels, remembered | S |

### Settings and tools

| # | Feature | GitKraken | Size |
|---|---------|-----------|------|
| 42 | **Diff and editor settings** | syntax highlighting in diffs and file views (toggle); font family, size, tab width, line numbers; terminal font and size | M–L |
| 43 | **Display preferences** | date/time format (relative / absolute / locale); author initials instead of avatars; default branch name for Init; prune remote-tracking branches on auto-fetch | S |
| 44 | **Command palette extras** | Perform Repo Maintenance (`git maintenance run` / `gc`); Open in <installed IDE> (VS Code, Cursor, IntelliJ, Sublime, Zed… detected); Create patch from all working changes; Toggle Theme; Discard all changes (confirmed, undoable) | S |
| 45 | **Encoding** | per-repo text encoding for diffs and file views (UTF-8 default; e.g. Windows-1252, Shift_JIS, GBK) | M |
| 46 | **Git Flow** | initialise (branch names and prefixes in `gitflow.*` config); start / finish feature, release, hotfix; menu entries on matching branches — done with plain git, no `git-flow` binary needed | M–L |
| 47 | **LFS** | detect LFS repos; toolbar/status indicator; track / untrack patterns; LFS fetch/pull; LFS pointer files shown as such; clear message when `git-lfs` is not installed | M |

### Bigger features

| # | Feature | GitKraken | Size |
|---|---------|-----------|------|
| 48 | **Profiles** | several identities (name, email, optional signing key); switching changes the identity used for commits (repo or global, by choice) and keeps settings and open tabs per profile; optionally keep the global `.gitconfig` in sync | M |
| 49 | **Local workspaces** | named groups of repos; a workspace screen with checkboxes and bulk Fetch / Pull / Open / Reveal / Remove | M |
