# Merge & Rebase Conflict Resolver

Date: 2026-08-23

## Goal

A GitKraken/IntelliJ-style conflict resolution workflow: when a merge (or
rebase) stops on conflicts, surface a clear entry point, let the user resolve
each file in a 3-pane editor, and finish (commit the merge / continue the
rebase) once everything is resolved — or abort.

## Entry points

- **Merge failure:** after `merge_branch` errors, if a merge is in progress
  (`MERGE_HEAD` exists) the error dialog shows a **Resolve Conflicts** button
  that opens the resolver. Non-conflict errors are unchanged.
- **Persistent banner:** whenever a conflict session is active (merge or rebase),
  a banner (reusing the rebase-banner style) offers **Resolve Conflicts**. The
  rebase banner's *conflict* case routes here; its *edit-stop* case keeps
  Continue/Skip/Abort.

## The resolver view (`showView("conflict")`)

**Left panel**
- Summary: *"Merging <incoming> into <current>"* / *"Rebasing …"*.
- **Conflicted Files (N)** + **Mark all resolved**; **Resolved Files (M)**.
  Click a file → open it in the editor. Resolving moves it to Resolved with a ✓
  and a success toast. Resolved is tracked in the frontend as
  (initial conflicted set − current conflicted set).
- Footer: **Commit Message** (prefilled from `MERGE_MSG`, preserved as you work),
  **Commit and Merge** (enabled only when Conflicted = 0), **Abort**.
  In **rebase** mode the footer is **Continue Rebase** with no editable message
  (git reuses the replayed commit's message).

**Main 3-pane editor** (per file)
- Top-left **Ours** (current), top-right **Theirs** (incoming) — read-only, full
  file, conflict regions highlighted; **conflict N of M** navigation.
- Bottom **Output** — editable textarea, initialized to the working-tree file.
  Each conflict region has **Take Ours / Take Theirs / Take Both** buttons that
  rewrite just that region; free-text editing is allowed (decision **a**).
- File is resolvable when no `<<<<<<< / ======= / >>>>>>>` markers remain;
  **Save** writes the Output and, if clean, `git add`s it (→ Resolved + toast).
- **Binary / delete-modify** files get a reduced UI: only **Take Ours / Take
  Theirs** (no text editor) (decision **b**).

## Backend — `gitp-core/src/conflict_ops.rs`

- `conflict_status() -> ConflictStatus { kind: "merge"|"rebase"|"none", summary,
  conflicted: Vec<String>, message }`. Detect merge via `MERGE_HEAD`, rebase via
  the rebase state dir; conflicted via `git diff --name-only --diff-filter=U`;
  message from `MERGE_MSG`.
- `conflict_sides(path) -> ConflictSides { ours: Option<String>, theirs:
  Option<String>, base: Option<String>, working: String, binary: bool }` — via
  `git show :2:/:3:/:1:<path>`; a missing stage ⇒ that side deleted; NUL byte ⇒
  binary.
- `resolve_conflict(path, content)` → write file, `git add -- <path>`.
- `abort_conflict()` → `git merge --abort` or `git rebase --abort` by kind.
- `finish_conflict(message)` → merge: `git commit -F -` (message on stdin);
  rebase: `git rebase --continue`.

Tauri commands mirror these. Tests in `tests/conflict_ops.rs` build a real merge
conflict via the git CLI in a `FixtureRepo` and exercise status → sides →
resolve → finish, plus abort.

## Frontend

- `types.ts`: `ConflictStatus`, `ConflictSides`.
- `api.ts`: wrappers + preview-mode mocks.
- `views/conflict.ts`: the view (file list + 3-pane editor), conflict-marker
  parsing for region navigation and the Take buttons.
- `main.ts`: banner + error-dialog **Resolve Conflicts** button, `showView`
  wiring, refresh after finish/abort.
- `styles.css`: 3-pane layout, conflict-region highlighting.

## Non-goals / simplifications

- Accept controls are per-region buttons in the Output, not checkboxes synced
  across all three panes (decision **a**).
- Resolved-file list is session-tracked in the frontend, not reconstructed from
  the index on a cold reopen.
- No inline word-level diff within a conflict region.
