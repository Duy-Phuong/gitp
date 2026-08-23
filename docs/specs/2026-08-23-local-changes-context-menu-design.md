# Local-Changes File Context Menu + Checkbox Multi-Select

Date: 2026-08-23

## Goal

Give the Local Changes view a right-click context menu on file rows, matching
the shape of JetBrains' changelist menu, and let a **checkbox** multi-selection
drive that menu so one action can apply to many files at once.

## Scope (agreed)

Menu items — the "Recommended set":

- **Unstaged panel:** Stage · Discard Changes… · Stash File(s)… · Save as Patch… ·
  Show in Finder · Copy Relative Path · Copy Absolute Path · Ignore · Stage All
- **Staged panel:** Unstage · Save as Patch… · Show in Finder ·
  Copy Relative Path · Copy Absolute Path · Unstage All

Dropped from the JetBrains reference (poor fit for gitp): Open / Open With,
External Diff, Blame/Timeline, History. Ignore and Copy Path are flat items, not
submenus, because the shared `context-menu.ts` has no submenu support and adding
it is avoidable complexity.

## Selection model

Two independent concepts:

- **View selection** (unchanged): single click loads that file's diff.
- **Check selection** (new): a checkbox per file row, kept **per-panel**
  (Unstaged and Staged have independent sets), since Stage only applies to
  unstaged files and Unstage only to staged ones. Folder rows get a **tri-state**
  checkbox that checks/unchecks all files beneath them.

Menu target set: right-clicking a **checked** row acts on **all checked rows in
that panel**; right-clicking an **unchecked** row acts on **just that row** (checks
untouched). Labels reflect the count ("Stage 3 Files", else the filename).

Single-target regardless of checks: **Show in Finder** (revealing N files is odd).

## Backend

### gitp-core — new `src/file_ops.rs`

- `discard_files(&[String])` — revert each path to HEAD; paths **not in the HEAD
  tree** (new/untracked/added) are unstaged and deleted from disk. Classify via
  the HEAD tree lookup. Destructive.
- `stash_files(&[String]) -> String` — `git stash push -u -- <paths>` (so
  untracked selected files are included).
- `save_files_patch(&[String], staged: bool, dest: &Path) -> String` —
  `git diff [--cached] -- <paths>` written to `dest`. Untracked selected files
  (which `git diff` omits) are temporarily marked intent-to-add (`git add -N`)
  for the working-tree direction so their content appears, then unmarked.
- `add_to_gitignore(&[String]) -> usize` — append each not-already-present path
  to `.gitignore` at the repo root (creating it if needed); returns count added.
- `workdir_path(&self) -> Result<PathBuf>` (in `repo.rs`) — exposes the working
  directory for the reveal command and absolute paths.

Tests in `tests/file_ops.rs` using the existing `FixtureRepo` harness.

### gitp-gui `src/lib.rs`

`#[tauri::command]`s (+ `_impl`): `discard_files`, `stash_files`,
`save_files_patch`, `add_to_gitignore`, and `reveal_path(path)` — the last joins
the repo workdir with the relative path and shells out to the OS reveal
(`open -R` on macOS, `explorer /select,` on Windows, else open the parent dir).
No new plugin/capability needed. Added to `generate_handler!`.

## Frontend

- `api.ts`: `discardFiles`, `stashFiles`, `saveFilesPatch`, `addToGitignore`,
  `revealPath` wrappers with preview-mode mocks.
- `tree.ts`: opt-in checkbox support (`checkable`, `checkedPaths`,
  `onToggleCheck`, folder tri-state). Gated by a flag so the commit-detail File
  Tree tab that reuses this component is unaffected.
- `changes.ts`: owns `checked: Record<Panel, Set<string>>`, renders checkboxes,
  builds the row `contextmenu`, wires the new callbacks. Repo root threaded in
  for absolute paths / reveal.
- `main.ts`: wire new callbacks and pass the active repo path.
- `styles.css`: checkbox column styling on `.tree-row`.

## Testing / verification

- `cargo test -p gitp-core` (new file_ops tests) + existing suite green.
- `cargo build` for the GUI backend.
- webui `tsc` typecheck + `vitest`; add a unit test for the pure folder
  tri-state helper.
- Manual/preview: menu appears, labels reflect counts, checkbox tri-state works,
  each action round-trips.

## Non-goals / known limitations

- No Ignore/Copy-Path submenus (flat items instead).
- Rename edge cases in discard are not specially handled.
