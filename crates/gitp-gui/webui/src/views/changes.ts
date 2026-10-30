// Local Changes: the staging area. Unstaged and Staged panels (collapsible file
// trees), the selected file's diff, and a commit box (subject + description +
// Amend + Commit). A stateful controller owns the selection, per-panel collapse
// state, and the commit fields, reloading from the backend after each mutation.

import { DEFAULT_CONTEXT_LINES } from "../api";
import { autoGrowTextarea, clear, copyToClipboard, el } from "../dom";
import type {
  ChangeKind,
  CommitDetail,
  DiffToolTarget,
  FileContent,
  FileDiff,
  FileSide,
  SigningConfig,
  StatusLists,
} from "../types";
import { type MenuItem, showContextMenu } from "./context-menu";
import { contextControls, diffToggles, renderFile, renderSplitDiff } from "./detail";
import { loadDiffWrap, loadIgnoreWhitespace } from "../prefs";
import {
  changedLines,
  dragOver,
  emptySelection,
  lineKey,
  press,
  release,
  selectedPairs,
  type LineKey,
} from "./line-selection";
import { imageMime, loadOnce, renderImageDiff, type ImageLoad } from "./image-diff";
import { renderFileTree } from "./tree";
import { describeSubmoduleChange, parseSubmoduleDiff } from "../submodule-diff";

export type Panel = "unstaged" | "staged";

export interface ChangesCallbacks {
  // Staging trees: paths + statuses only, no hunks (cheap to refresh).
  fetchStatus: () => Promise<StatusLists>;
  // The selected file's full diff (with hunks), fetched on demand with
  // `contextLines` of unchanged context around each change, optionally
  // ignoring whitespace (for reading only — see selectedDiffWs).
  fetchFileDiff: (
    path: string,
    staged: boolean,
    contextLines: number,
    ignoreWhitespace: boolean,
  ) => Promise<FileDiff | null>;
  // One side of an image file, for the image diff.
  fetchFileContent: (side: FileSide, path: string) => Promise<FileContent | null>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  // Per-hunk (per-block) operations, driven by the diff's right-click menu.
  // `contextLines` must be the context the diff was drawn with: it decides
  // where blocks split, so it's what makes `hunkIndex` the block clicked.
  stageHunk: (path: string, hunkIndex: number, contextLines: number) => Promise<void>;
  unstageHunk: (path: string, hunkIndex: number, contextLines: number) => Promise<void>;
  discardHunk: (path: string, hunkIndex: number, contextLines: number) => Promise<void>;
  // Per-line operations on the lines selected in the diff, each named as
  // [hunkIndex, lineIndex within that hunk] at the same `contextLines`.
  stageLines: (path: string, lines: [number, number][], contextLines: number) => Promise<void>;
  unstageLines: (path: string, lines: [number, number][], contextLines: number) => Promise<void>;
  discardLines: (path: string, lines: [number, number][], contextLines: number) => Promise<void>;
  // File-level operations driven by the file-row right-click menu, each acting
  // on the current checkbox multi-selection (or the right-clicked file).
  discardFiles: (paths: string[]) => Promise<void>;
  stashFiles: (paths: string[]) => Promise<string>;
  saveFilesPatch: (paths: string[], staged: boolean, defaultName: string) => Promise<string | null>;
  addToGitignore: (paths: string[]) => Promise<number>;
  revealPath: (path: string) => Promise<void>;
  // Open the file in the OS default application (e.g. the user's editor).
  openInEditor: (path: string) => Promise<void>;
  // Open the file's staged / unstaged change in `git difftool`.
  openInDiffTool: (target: DiffToolTarget, paths: string[]) => void;
  // Absolute path of the active repo's working directory (for Copy Absolute
  // Path). Null when no repo is open.
  repoRoot: () => string | null;
  // Confirm a destructive action (discard); resolves true to proceed.
  confirm: (message: string) => Promise<boolean>;
  // The current HEAD commit (message + files), for pre-filling an amend and
  // showing the commit being amended. Null when the branch has no commits.
  fetchHead: () => Promise<CommitDetail | null>;
  // `sign` is the Sign toggle: force signing on / off, or null to leave it to
  // git's commit.gpgsign (no signing key configured). `noVerify` is Skip hooks.
  commit: (
    subject: string,
    body: string,
    amend: boolean,
    sign: boolean | null,
    noVerify: boolean,
  ) => Promise<string>;
  // Whether commits can be signed here, and the default (commit.gpgsign).
  fetchSigningConfig: () => Promise<SigningConfig>;
  // The raw text of the configured commit.template, or null when none is set.
  fetchCommitTemplate: () => Promise<string | null>;
  // The persisted "Push after commit" toggle, and the push it runs once a
  // commit lands.
  pushAfterCommit: () => boolean;
  setPushAfterCommit: (on: boolean) => void;
  push: () => void;
  // After every reload: the number of distinct changed paths, for the sidebar
  // badge — cheap enough to pass along instead of a separate backend scan.
  onChanged: (localChangeCount: number) => void;
  // After a successful commit (refresh history + sidebar).
  onCommitted: () => void;
  setStatus: (msg: string) => void;
  // An async outcome worth a toast as well as the status line (a commit
  // landing, a stash being written) — see main.ts's reportDone.
  reportDone: (msg: string) => void;
  // An operation finished here. reload() below re-reads only the status, which
  // is much cheaper than a full workspace snapshot but doesn't carry the
  // undo/redo labels — so without this the Undo button never learns that
  // staging just became undoable.
  onActed: () => void;
  // Show git's full (often multi-line) output for a failed operation — e.g. a
  // pre-commit hook's messages — in a dialog rather than the status line.
  reportError: (title: string, detail: string) => void;
  // Open the conflict resolver — from a Conflicted row's "Resolve" link.
  openConflicts?: () => void;
}

export interface ChangesHandle {
  reload: () => Promise<void>;
  // Whether an operation is in flight here. A passive refresh (window focus,
  // user interaction) must not repaint a snapshot taken before an operation the
  // user just started — that would put the pre-op state back over an optimistic
  // staging update, until the operation's own reload undid it again.
  isBusy: () => boolean;
  // Apply a status snapshot the host already fetched, instead of running
  // `git status` again ourselves — the single most expensive read on a large
  // repo, so it should happen once per refresh, not once per view.
  applyStatus: (status: StatusLists) => void;
  // Re-read the selected file's diff even though its status hasn't changed —
  // it may have been edited outside gitp — and repaint only if it differs.
  recheckDiff: () => Promise<void>;
  // Pre-fill the commit subject/body — e.g. a merge/cherry-pick/revert's
  // pending message, so it's ready to commit here without retyping it. A
  // no-op once the user has typed anything, so it never clobbers real input.
  prefillMessage: (subject: string, body: string) => void;
  // Clear the commit box if it still holds exactly this pre-filled message —
  // the conflict session it came from ended without a commit from here.
  clearPrefill: (subject: string, body: string) => void;
  // Forget everything tied to the repo: selection, diff cache, checkboxes,
  // collapsed folders, the commit message and Amend. Called when the active
  // repo changes, so nothing from the previous one leaks into the next.
  reset: () => void;
}

export function setupChanges(host: HTMLElement, cb: ChangesCallbacks): ChangesHandle {
  // staged/unstaged hold summaries (no hunks); selectedDiff holds the fetched
  // hunks for the currently selected file only.
  let staged: FileDiff[] = [];
  let unstaged: FileDiff[] = [];
  let selected: { panel: Panel; path: string } | null = null;
  let selectedDiff: FileDiff | null = null;
  // The status-list summary (path/old_path/status, no hunks) that selectedDiff
  // was fetched for — lets loadSelectedDiff skip re-fetching on a reload() where
  // that summary hasn't changed (see loadSelectedDiff).
  let selectedDiffSummary: FileDiff | null = null;
  // The context size selectedDiff was fetched with (what its blocks are cut at).
  let selectedDiffContext = DEFAULT_CONTEXT_LINES;
  // Whether selectedDiff ignores whitespace. Its blocks and lines then aren't
  // the file's real changes — block N of a `-w` diff can be a different block
  // than the backend's block N, and a whitespace-only edit inside a shown
  // block isn't in it at all — so staging or discarding by them would act on
  // the wrong text. Block / line operations are disabled while it's set; whole
  // files can still be staged or discarded from the list.
  let selectedDiffWs = false;
  // Whether the current selection's diff fetch has completed — distinguishes
  // "still loading" from "loaded but no textual diff" (binary / Git LFS file).
  let diffLoaded = false;
  // Bumped on every diff fetch so a slow response for a since-changed selection
  // is discarded instead of overwriting the current one.
  let diffToken = 0;
  const collapsed: Record<Panel, Set<string>> = { unstaged: new Set(), staged: new Set() };
  // Checkbox multi-selection per panel, driving the file-row context menu.
  const checked: Record<Panel, Set<string>> = { unstaged: new Set(), staged: new Set() };
  let subject = "";
  let body = "";
  let amend = false;
  // When amend is on: the files from HEAD (with hunks), shown in the Staged
  // panel so the commit being amended is visible. Empty when amend is off.
  let amendFiles: FileDiff[] = [];
  // The message we auto-filled from HEAD, so unchecking Amend can clear it only
  // when the user hasn't edited it.
  let amendPrefill: { subject: string; body: string } | null = null;
  // The repo's signing setup (null until loaded / when it can't be read) and
  // the Sign toggle, which starts at commit.gpgsign. Reloaded per repo by
  // reset(); the token drops a load that a newer one (repo switch) superseded.
  let signing: SigningConfig | null = null;
  let sign = false;
  let signingToken = 0;
  // "Skip hooks" (--no-verify). Deliberately not remembered: it's a one-off
  // escape hatch, so it switches itself off after the commit it was for.
  let skipHooks = false;
  // The repo's commit.template as a subject/body, filled into an empty commit
  // box. Reloaded per repo by reset(); the token drops a superseded load.
  let template: { subject: string; body: string } | null = null;
  let templateToken = 0;
  let busy = false;
  let splitView = false;
  // Unchanged lines shown around each change (toolbar: fewer / more / full).
  let contextLines = DEFAULT_CONTEXT_LINES;
  let diffHost: HTMLElement | null = null;
  // Changed lines picked in the diff for Stage / Unstage / Discard lines (see
  // line-selection.ts), the diff they were picked in, and its selectable lines
  // in order. A different diff object — another file, another context size, or
  // the same file re-read after an operation — starts the selection over.
  let lineSel = emptySelection();
  let lineSelDiff: FileDiff | null = null;
  let lineOrder: LineKey[] = [];
  // Repaints the selection highlight and action bar of the diff on screen.
  let paintLines: (() => void) | null = null;
  // The selected image's before / after loaders, kept while the same diff
  // object is on screen (a re-read diff, or another file, loads afresh).
  let images: { diff: FileDiff | null; path: string; loads: [ImageLoad | null, ImageLoad | null] } | null = null;

  // Esc drops the line selection — unless something layered on top (a dialog,
  // Quick Launch, a menu) is what the Escape is for.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || lineSel.selected.size === 0) return;
    if (host.offsetParent === null) return; // Local Changes isn't showing
    if (document.querySelector(".modal-overlay, .ql-overlay, .commit-menu, .menu:not(.hidden)")) return;
    clearLineSelection();
  });

  function clearLineSelection(): void {
    lineSel = emptySelection();
    paintLines?.();
  }

  async function reload(): Promise<void> {
    applyStatus(await cb.fetchStatus());
  }

  // Render from an already-fetched status snapshot. The selected file's hunks
  // are loaded in the background (they have their own loading state and a
  // staleness token), so callers don't wait on a second round trip.
  function applyStatus(s: StatusLists): void {
    staged = s.staged;
    unstaged = s.unstaged;
    pruneChecked();
    resolveSelection();
    render();
    // Distinct changed paths (a file can be both staged and unstaged).
    const paths = new Set([...staged, ...unstaged].map((f) => f.path));
    cb.onChanged(paths.size);
    void loadSelectedDiff();
  }

  // Fetch (and render) the hunks for the current selection. No-op to an empty
  // diff pane when nothing is selected. Skips the fetch entirely when reload()
  // brought back the exact same status entry we already have hunks for — a
  // plain view switch shouldn't re-diff a file nothing happened to.
  async function loadSelectedDiff(): Promise<void> {
    const sel = selected;
    if (!sel) {
      selectedDiff = null;
      diffLoaded = false;
      selectedDiffSummary = null;
      if (diffHost) renderDiffInto(diffHost);
      return;
    }
    // Amend-only files aren't in the index; their diff is HEAD's cached hunks.
    if (sel.panel === "staged") {
      const cached = amendOnly(sel.path);
      if (cached) {
        selectedDiff = cached;
        diffLoaded = true;
        selectedDiffSummary = null;
        if (diffHost) renderDiffInto(diffHost);
        return;
      }
    }
    const summary = (sel.panel === "staged" ? staged : unstaged).find((f) => f.path === sel.path) ?? null;
    if (
      diffLoaded &&
      selectedDiff &&
      summary &&
      sameSummary(summary, selectedDiffSummary) &&
      selectedDiffContext === contextLines &&
      selectedDiffWs === loadIgnoreWhitespace()
    ) {
      return; // status for this file is unchanged — the hunks we have are still current
    }
    const token = ++diffToken;
    const ctx = contextLines;
    const ws = loadIgnoreWhitespace();
    selectedDiff = null;
    diffLoaded = false;
    const file = await cb.fetchFileDiff(sel.path, sel.panel === "staged", ctx, ws);
    if (token !== diffToken) return; // selection moved on; drop this result
    selectedDiff = file;
    diffLoaded = true;
    selectedDiffSummary = summary;
    selectedDiffContext = ctx;
    selectedDiffWs = ws;
    if (diffHost) renderDiffInto(diffHost);
  }

  async function recheckDiff(): Promise<void> {
    const sel = selected;
    // Nothing shown, a load already in flight (it's fresh), or an operation
    // that reloads on its own when it's done.
    if (!sel || !diffLoaded || !selectedDiff || busy) return;
    if (sel.panel === "staged" && amendOnly(sel.path)) return;
    const token = ++diffToken;
    const file = await cb.fetchFileDiff(sel.path, sel.panel === "staged", selectedDiffContext, selectedDiffWs);
    if (token !== diffToken) return; // selection moved on; drop this result
    // Unchanged: keep the very same object, so the line selection survives and
    // nothing is repainted. Not for an image: a binary file's diff has no
    // lines to compare, so an edit to it on disk would never show.
    if (sameDiff(file, selectedDiff) && !imageMime(sel.path)) return;
    // A new diff object: renderDiffInto starts the line selection over, as for
    // any other newly loaded diff.
    selectedDiff = file;
    if (!diffHost) return;
    const scroll = captureScroll();
    renderDiffInto(diffHost);
    restoreScroll(scroll);
  }

  function sameSummary(a: FileDiff, b: FileDiff | null): boolean {
    return b !== null && a.path === b.path && a.old_path === b.old_path && a.status === b.status;
  }

  // Keep the selection valid after files move between panels or disappear.
  function resolveSelection(): void {
    if (!selected) return;
    if (unstaged.some((f) => f.path === selected!.path)) selected = { panel: "unstaged", path: selected.path };
    else if (staged.some((f) => f.path === selected!.path)) selected = { panel: "staged", path: selected.path };
    else if (amendOnly(selected.path)) selected = { panel: "staged", path: selected.path };
    else selected = null;
  }

  async function run(
    action: () => Promise<void>,
    after?: () => void,
    errorTitle = "Operation failed",
    // Undo an optimistic update (see runStaging) before the error is reported,
    // so the panels aren't still claiming a file is staged while the dialog
    // explains that staging it failed.
    rollback?: () => void,
  ): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await action();
      after?.(); // success-only side effects (clear the commit box, refresh history)
    } catch (err) {
      rollback?.();
      // A failed op — e.g. a pre-commit hook that reformats files and aborts the
      // commit — often still changes the working tree, so surface git's full
      // output and fall through to reload() so those changes appear.
      cb.reportError(errorTitle, String(err));
    } finally {
      // Always re-read the working tree: hooks (or a partial op) may have
      // changed files whether or not the command itself succeeded.
      // The op may have changed the selected file's content without changing
      // its status (a staged hunk, a discarded block), so the hunks we hold are
      // suspect — drop the skip so loadSelectedDiff re-fetches them.
      selectedDiffSummary = null;
      try {
        await reload();
      } catch (err) {
        cb.reportError("Failed to refresh changes", String(err));
      }
      busy = false;
      cb.onActed();
    }
  }

  // Text fields whose focus and caret must survive a re-render. Keyed by a
  // selector because render() builds brand-new nodes every time.
  const KEEP_FOCUS = [".commit-subject", ".commit-body"];

  interface FocusSnapshot {
    selector: string;
    start: number | null;
    end: number | null;
  }

  function captureFocus(): FocusSnapshot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return null;
    if (!host.contains(active)) return null;
    const selector = KEEP_FOCUS.find((s) => active.matches(s));
    return selector ? { selector, start: active.selectionStart, end: active.selectionEnd } : null;
  }

  function restoreFocus(snap: FocusSnapshot | null): void {
    if (!snap) return;
    const next = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(snap.selector);
    if (!next) return;
    next.focus();
    if (snap.start !== null && snap.end !== null) next.setSelectionRange(snap.start, snap.end);
  }

  // The scrollable parts of the view: both file trees and the diff.
  const SCROLLERS = ".stage-tree, .staging-diff-body";

  function captureScroll(): [number, number][] {
    return [...host.querySelectorAll<HTMLElement>(SCROLLERS)].map((e) => [e.scrollTop, e.scrollLeft]);
  }

  function restoreScroll(saved: [number, number][]): void {
    host.querySelectorAll<HTMLElement>(SCROLLERS).forEach((e, i) => {
      if (saved[i]) [e.scrollTop, e.scrollLeft] = saved[i];
    });
  }

  function render(): void {
    // render() rebuilds everything, including the commit box, and it runs on any
    // refresh — a background fetch, an external change picked up on window
    // focus, a file being staged. Without this, a refresh landing while someone
    // is writing a commit message drops them out of the field mid-word and
    // sends the caret back to the start. The same goes for where the trees and
    // the diff were scrolled to: with the filesystem watcher, a refresh lands
    // on every save in an editor.
    const focus = captureFocus();
    const scroll = captureScroll();
    clear(host);
    const wrap = el("div", { class: "staging" });
    const left = el("div", { class: "staging-left" });
    left.append(
      panel("unstaged", "Unstaged", unstaged),
      panel("staged", amend ? "Staged — amending last commit" : "Staged", stagedDisplay()),
      commitBox(),
    );
    diffHost = el("div", { class: "staging-diff" });
    renderDiffInto(diffHost);
    wrap.append(left, diffHost);
    host.append(wrap);
    restoreFocus(focus);
    restoreScroll(scroll);
  }

  // Selecting a file updates only the highlight + diff — it must NOT rebuild the
  // trees, so file rows survive for a native double-click (instant staging).
  function selectFile(panel: Panel, path: string): void {
    selected = { panel, path };
    selectedDiff = null;
    diffLoaded = false;
    for (const r of host.querySelectorAll<HTMLElement>(".tree-file.selected")) {
      r.classList.remove("selected");
    }
    const trees = host.querySelectorAll<HTMLElement>(".stage-tree");
    const container = panel === "unstaged" ? trees[0] : trees[1];
    for (const r of container?.querySelectorAll<HTMLElement>(".tree-file") ?? []) {
      if (r.getAttribute("title") === path) {
        r.classList.add("selected");
        break;
      }
    }
    if (diffHost) renderDiffInto(diffHost);
    void loadSelectedDiff();
  }

  function renderDiffInto(pane: HTMLElement): void {
    clear(pane);
    paintLines = null;
    if (selectedDiff !== lineSelDiff) {
      lineSel = emptySelection();
      lineSelDiff = selectedDiff;
      lineOrder = selectedDiff ? changedLines(selectedDiff) : [];
    }
    if (!selected) {
      pane.append(el("div", { class: "detail-empty", text: "Select a file to view its changes." }));
      return;
    }
    // A submodule's "diff" is the commit it records; there are no lines to
    // stage piecemeal, only the whole entry (from the file list).
    const submodule = selectedDiff ? parseSubmoduleDiff(selectedDiff) : null;
    const hasDiff = selectedDiff != null && selectedDiff.hunks.length > 0 && !submodule;
    const mime = submodule ? null : imageMime(selected.path);
    pane.append(diffToolbar(hasDiff));
    const body = el("div", { class: `staging-diff-body${loadDiffWrap() ? " wrap-lines" : ""}` });
    // The selected-lines action bar, under the diff (not scrolled with it).
    const bar = el("div", { class: "line-actions hidden" });
    if (submodule) {
      const notes: string[] = [];
      if (submodule.from !== submodule.to) {
        notes.push(
          selected.panel === "staged"
            ? "The next commit records the new commit."
            : "Stage it to record the new commit in this repository.",
        );
      }
      if (submodule.dirty) notes.push("Its own files have uncommitted changes — commit or discard them inside the submodule.");
      body.append(
        el("div", { class: "submodule-change" }, [
          el("div", { class: "submodule-change-title", text: `Submodule ${selected.path}` }),
          el("div", { class: "submodule-change-ids", text: describeSubmoduleChange(submodule) }),
          ...notes.map((text) => el("div", { class: "submodule-change-note", text })),
        ]),
      );
    } else if (hasDiff) {
      const diff = splitView ? renderSplitDiff(selectedDiff!) : renderFile(selectedDiff!);
      // An SVG is text as well: its image goes above the text diff.
      if (mime) diff.querySelector(".file-head")?.after(imagePanel(selected, mime));
      body.append(diff);
      if (selectedDiffWs) {
        // Not the real blocks (see selectedDiffWs): show the controls, disabled.
        attachHunkControls(body, WS_BLOCKED);
      } else {
        attachHunkMenus(body);
        // Amend-only files (shown while amending) aren't in the index — their
        // blocks can't be staged/unstaged, so skip the per-hunk controls.
        if (!amendOnly(selected.path)) {
          attachHunkControls(body);
          attachLineSelection(body, bar);
        }
      }
    } else if (!diffLoaded) {
      body.append(el("div", { class: "detail-empty", text: "Loading changes…" }));
    } else if (mime) {
      body.append(imagePanel(selected, mime));
    } else if (selectedDiffWs) {
      body.append(
        el("div", {
          class: "detail-empty",
          text: "Nothing to show with Ignore whitespace on — only whitespace changed, or it's a binary file.",
        }),
      );
    } else {
      // Loaded, but no textual diff — a binary or Git-LFS-tracked file. It still
      // appears in the list and can be staged/committed like any change.
      body.append(
        el("div", { class: "detail-empty", text: "No text preview — binary or Git LFS file." }),
      );
    }
    pane.append(body, bar);
  }

  function imagePanel(sel: { panel: Panel; path: string }, mime: string): HTMLElement {
    if (images?.diff !== selectedDiff || images.path !== sel.path) {
      images = { diff: selectedDiff, path: sel.path, loads: imageLoads(sel) };
    }
    return renderImageDiff(mime, ...images.loads);
  }

  // Where the two sides of the selected image live: unstaged is the index vs
  // the working tree, staged is HEAD vs the index, and an amend-only file is
  // the amended commit itself. A new file has no before, a deleted one no
  // after.
  function imageLoads(sel: { panel: Panel; path: string }): [ImageLoad | null, ImageLoad | null] {
    const file = (sel.panel === "staged" ? stagedDisplay() : unstaged).find((f) => f.path === sel.path);
    const [from, to]: [FileSide, FileSide] = amendOnly(sel.path)
      ? [{ Rev: "HEAD^" }, { Rev: "HEAD" }]
      : sel.panel === "staged"
        ? [{ Rev: "HEAD" }, "Index"]
        : ["Index", "WorkTree"];
    const at = (side: FileSide, path: string) => loadOnce(() => cb.fetchFileContent(side, path));
    const isNew = file?.status === "Added" || file?.status === "Untracked";
    return [
      isNew ? null : at(from, file?.old_path ?? sel.path),
      file?.status === "Deleted" ? null : at(to, sel.path),
    ];
  }

  // Unified / Split toggle and context controls (when there's a diff to show),
  // the Wrap / Ignore whitespace toggles — always, so a file whose changes are
  // all whitespace can still be switched back — and an Edit File shortcut.
  function diffToolbar(hasDiff: boolean): HTMLElement {
    const mk = (label: string, on: boolean, set: boolean) => {
      const b = el("button", { class: `btn ghost small${on ? " active" : ""}`, text: label });
      b.addEventListener("click", () => {
        if (splitView === set) return;
        splitView = set;
        if (diffHost) renderDiffInto(diffHost);
      });
      return b;
    };
    const editBtn = el("button", {
      class: "btn ghost small icon-btn",
      text: "✎",
      title: "Edit File",
    });
    editBtn.addEventListener("click", () => void cb.openInEditor(selected!.path));
    const context = contextControls(contextLines, !hasDiff, (next) => {
      contextLines = next;
      if (diffHost) renderDiffInto(diffHost);
      void loadSelectedDiff();
    });
    const toggles = diffToggles(splitView, false, (what) => {
      if (diffHost) renderDiffInto(diffHost);
      if (what === "ws") void loadSelectedDiff();
    });
    return el("div", { class: "diff-toolbar" }, [
      el("div", { class: "diff-toolbar-group" }, [
        ...(hasDiff ? [mk("Unified", !splitView, false), mk("Split", splitView, true), ...context] : []),
        ...toggles,
      ]),
      editBtn,
    ]);
  }

  // Per-block action buttons on each hunk header, revealed on hover: Stage /
  // Discard for unstaged blocks, Unstage for staged ones. The same operations
  // are also on the block's right-click menu (attachHunkMenus). With `blocked`
  // the buttons are drawn disabled, with that as their tooltip.
  function attachHunkControls(body: HTMLElement, blocked: string | null = null): void {
    const sel = selected;
    if (!sel) return;
    const ctx = selectedDiffContext;
    for (const hunkEl of body.querySelectorAll<HTMLElement>(".hunk[data-hunk]")) {
      const header = hunkEl.querySelector(".hunk-header");
      if (!header) continue;
      const index = Number(hunkEl.dataset.hunk);
      const actions = el("div", { class: "hunk-actions" });
      const btn = (label: string, danger: boolean, onClick: () => void) => {
        const b = el("button", { class: `hunk-btn${danger ? " danger" : ""}`, text: label });
        if (blocked) {
          (b as HTMLButtonElement).disabled = true;
          b.title = blocked;
          return b;
        }
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick();
        });
        return b;
      };
      if (sel.panel === "unstaged") {
        actions.append(
          btn("Stage", false, () => void run(() => cb.stageHunk(sel.path, index, ctx))),
          btn("Discard…", true, () => void discardHunkAction(sel.path, index, ctx)),
        );
      } else {
        actions.append(btn("Unstage", false, () => void run(() => cb.unstageHunk(sel.path, index, ctx))));
      }
      header.append(actions);
    }
  }

  // Right-click a hunk block → stage / discard (unstaged) or unstage (staged)
  // just that block. Hunk index comes from the data-hunk attribute the diff
  // renderers set on each `.hunk` element.
  function attachHunkMenus(body: HTMLElement): void {
    const sel = selected;
    if (!sel) return;
    const ctx = selectedDiffContext;
    for (const hunkEl of body.querySelectorAll<HTMLElement>(".hunk[data-hunk]")) {
      const index = Number(hunkEl.dataset.hunk);
      hunkEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const items =
          sel.panel === "unstaged"
            ? [
                { label: "Stage this block", run: () => run(() => cb.stageHunk(sel.path, index, ctx)) },
                {
                  label: "Discard this block…",
                  danger: true,
                  run: () => void discardHunkAction(sel.path, index, ctx),
                },
              ]
            : [{ label: "Unstage this block", run: () => run(() => cb.unstageHunk(sel.path, index, ctx)) }];
        showContextMenu(e.clientX, e.clientY, items);
      });
    }
  }

  // Line selection in the diff: click a changed line to toggle it, shift-click
  // for a range, drag down the line-number gutter to sweep several. A click in
  // the code text only toggles when it didn't select text, so copying part of
  // a line still works. The action bar under the diff acts on the selection.
  function attachLineSelection(body: HTMLElement, bar: HTMLElement): void {
    const sel = selected;
    if (!sel) return;
    // Every selectable line's elements (a context row in the split view has two
    // cells, but changed lines have one), keyed like the selection.
    const lineEls = new Map<LineKey, HTMLElement[]>();
    for (const hunkEl of body.querySelectorAll<HTMLElement>(".hunk[data-hunk]")) {
      for (const lineEl of hunkEl.querySelectorAll<HTMLElement>("[data-line]")) {
        const key = lineKey(Number(hunkEl.dataset.hunk), Number(lineEl.dataset.line));
        if (!lineOrder.includes(key)) continue;
        lineEl.classList.add("line-selectable");
        lineEls.set(key, [...(lineEls.get(key) ?? []), lineEl]);
      }
    }
    const keyAt = (target: EventTarget | null): LineKey | null => {
      if (!(target instanceof Element)) return null;
      const lineEl = target.closest<HTMLElement>(".line-selectable");
      const hunkEl = lineEl?.closest<HTMLElement>(".hunk[data-hunk]");
      if (!lineEl || !hunkEl) return null;
      return lineKey(Number(hunkEl.dataset.hunk), Number(lineEl.dataset.line));
    };

    paintLines = () => {
      for (const [key, els] of lineEls) {
        for (const e of els) e.classList.toggle("line-selected", lineSel.selected.has(key));
      }
      renderLineActions(bar, sel);
    };
    paintLines();

    let pendingClick: LineKey | null = null;
    body.addEventListener("mousedown", (e) => {
      pendingClick = null;
      if (e.button !== 0) return;
      const key = keyAt(e.target);
      if (!key) return;
      const inGutter = (e.target as Element).closest(".diff-ln, .diff-origin, .split-ln") !== null;
      if (!inGutter && !e.shiftKey) {
        pendingClick = key; // decided on click, once we know it wasn't a text drag
        return;
      }
      e.preventDefault(); // no text selection while picking lines
      lineSel = press(lineSel, lineOrder, key, e.shiftKey);
      paintLines?.();
      if (lineSel.drag) {
        window.addEventListener(
          "mouseup",
          () => {
            lineSel = release(lineSel);
            paintLines?.();
          },
          { once: true },
        );
      }
    });
    body.addEventListener("mouseover", (e) => {
      if (!lineSel.drag) return;
      const key = keyAt(e.target);
      if (!key) return;
      lineSel = dragOver(lineSel, lineOrder, key);
      paintLines?.();
    });
    body.addEventListener("click", (e) => {
      const key = keyAt(e.target);
      if (!pendingClick || key !== pendingClick) return;
      pendingClick = null;
      if (window.getSelection()?.isCollapsed === false) return; // text was selected
      lineSel = release(press(lineSel, lineOrder, key, false));
      paintLines?.();
    });
  }

  // The bar under the diff while lines are selected: what's picked and what can
  // be done with it — the same operations as a block's buttons.
  function renderLineActions(bar: HTMLElement, sel: { panel: Panel; path: string }): void {
    clear(bar);
    const n = lineSel.selected.size;
    bar.classList.toggle("hidden", n === 0);
    if (n === 0) return;
    const ctx = selectedDiffContext;
    const btn = (label: string, danger: boolean, title: string, onClick: () => void) => {
      const b = el("button", { class: `hunk-btn${danger ? " danger" : ""}`, text: label, title });
      b.addEventListener("click", onClick);
      return b;
    };
    // Taken now: the selection is cleared as the operation starts (the diff is
    // re-read after it anyway).
    const take = () => {
      const pairs = selectedPairs(lineSel);
      clearLineSelection();
      return pairs;
    };
    const actions =
      sel.panel === "unstaged"
        ? [
            btn("Stage lines", false, "Stage the selected lines", () => {
              const pairs = take();
              void run(() => cb.stageLines(sel.path, pairs, ctx));
            }),
            btn("Discard lines…", true, "Discard the selected lines", () => {
              void discardLinesAction(sel.path, selectedPairs(lineSel), ctx);
            }),
          ]
        : [
            btn("Unstage lines", false, "Unstage the selected lines", () => {
              const pairs = take();
              void run(() => cb.unstageLines(sel.path, pairs, ctx));
            }),
          ];
    bar.append(
      el("span", { class: "line-actions-count", text: `${n} line${n === 1 ? "" : "s"} selected` }),
      ...actions,
      btn("Clear", false, "Clear the selection (Esc)", clearLineSelection),
    );
  }

  async function discardLinesAction(path: string, lines: [number, number][], ctx: number): Promise<void> {
    const n = lines.length;
    const ok = await cb.confirm(
      `Discard ${n} selected line${n === 1 ? "" : "s"} of ${path}? This change will be lost.`,
    );
    if (!ok) {
      cb.setStatus("Discard cancelled.");
      return;
    }
    clearLineSelection();
    await run(() => cb.discardLines(path, lines, ctx));
  }

  async function discardHunkAction(path: string, index: number, ctx: number): Promise<void> {
    const ok = await cb.confirm(`Discard this block of ${path}? This change will be lost.`);
    if (!ok) {
      cb.setStatus("Discard cancelled.");
      return;
    }
    await run(() => cb.discardHunk(path, index, ctx));
  }

  // Drop checked paths that no longer exist in their panel (files moved between
  // panels or disappeared after an operation).
  function pruneChecked(): void {
    for (const p of [...checked.unstaged]) {
      if (!unstaged.some((f) => f.path === p)) checked.unstaged.delete(p);
    }
    for (const p of [...checked.staged]) {
      if (!staged.some((f) => f.path === p)) checked.staged.delete(p);
    }
  }

  // Right-click a changed file row → the file-level context menu. Actions target
  // the panel's checked files when the right-clicked row is checked, otherwise
  // just that row.
  function openFileMenu(which: Panel, path: string, e: MouseEvent): void {
    e.preventDefault();
    // Amend-only staged rows aren't really in the index — no file ops apply.
    if (which === "staged" && amendOnly(path)) return;

    const files = which === "unstaged" ? unstaged : staged;
    // An unmerged file is resolved in the conflict view, not staged/discarded.
    if (files.find((f) => f.path === path)?.status === "Conflicted") {
      const items: MenuItem[] = [
        { label: "Resolve Conflicts…", run: () => cb.openConflicts?.() },
        { separator: true },
        { label: "Edit File", run: () => void cb.openInEditor(path) },
        { label: "Show in Finder", run: () => void cb.revealPath(path) },
      ];
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }
    const inPanel = new Set(files.map((f) => f.path));
    let paths = checked[which].has(path)
      ? [...checked[which]].filter((p) => inPanel.has(p))
      : [path];
    if (paths.length === 0) paths = [path];
    const n = paths.length;
    const many = n > 1;
    const label = (verb: string) => (many ? `${verb} ${n} Files` : verb);
    const statusOf = new Map(files.map((f) => [f.path, f.status]));
    // Checked conflicted rows don't ride along on a bulk stage/discard.
    paths = paths.filter((p) => isActionable(statusOf.get(p)));
    if (paths.length === 0) return;
    const allUntracked = paths.every((p) => statusOf.get(p) === "Untracked");
    // git difftool only knows tracked files — an untracked one has no diff.
    const diffTool: MenuItem[] =
      statusOf.get(path) === "Untracked"
        ? []
        : [
            {
              label: "Open in External Diff Tool",
              run: () => cb.openInDiffTool(which === "staged" ? "Staged" : "Unstaged", [path]),
            },
          ];

    const copy = (abs: boolean) => {
      const root = cb.repoRoot();
      const text = paths.map((p) => (abs && root ? `${root}/${p}` : p)).join("\n");
      void copyToClipboard(text).then(() => cb.setStatus(`Copied ${n} path${many ? "s" : ""}.`));
    };
    const patch = () => {
      const base = many ? "changes" : (paths[0].split("/").pop() ?? "changes");
      cb.saveFilesPatch(paths, which === "staged", `${base}.patch`)
        .then((msg) => {
          if (msg) cb.setStatus(msg);
        })
        .catch((err) => cb.reportError("Save as Patch failed", String(err)));
    };

    const items: MenuItem[] =
      which === "unstaged"
        ? [
            { label: label("Stage"), run: () => stageEach(paths) },
            { label: `${label("Discard")}…`, danger: true, run: () => void discardFilesAction(paths) },
            { separator: true },
            {
              label: `${label("Stash")}…`,
              run: () => run(async () => cb.reportDone(await cb.stashFiles(paths))),
            },
            { label: "Save as Patch…", run: patch },
            { separator: true },
            { label: "Edit File", run: () => void cb.openInEditor(path) },
            ...diffTool,
            { label: "Show in Finder", run: () => void cb.revealPath(path) },
            { label: "Copy Relative Path", run: () => copy(false) },
            { label: "Copy Absolute Path", run: () => copy(true) },
            ...(allUntracked
              ? [{ label: "Add to .gitignore", run: () => void ignoreAction(paths) }]
              : []),
            { separator: true },
            { label: "Stage All", run: stageAllAction },
          ]
        : [
            { label: label("Unstage"), run: () => unstageEach(paths) },
            { separator: true },
            { label: "Save as Patch…", run: patch },
            { separator: true },
            { label: "Edit File", run: () => void cb.openInEditor(path) },
            ...diffTool,
            { label: "Show in Finder", run: () => void cb.revealPath(path) },
            { label: "Copy Relative Path", run: () => copy(false) },
            { label: "Copy Absolute Path", run: () => copy(true) },
            { separator: true },
            { label: "Unstage All", run: unstageAllAction },
          ];
    showContextMenu(e.clientX, e.clientY, items);
  }

  // Staging is the action taken most often in the app, and it used to wait on
  // the round trip *plus* a full `git status` before the row moved. Paint the
  // move first and let the reload reconcile: the guess only has to hold for the
  // few hundred ms in between, and run()'s reload() is still the authority.
  function runStaging(paths: string[], to: Panel, op: () => Promise<void>): void {
    if (busy || paths.length === 0) return;
    // moveFiles reassigns rather than mutating, so these stay intact as the
    // pre-op snapshot to roll back to.
    const before = { staged, unstaged };
    moveFiles(paths, to);
    pruneChecked();
    resolveSelection();
    render();
    // The sidebar's badge counts distinct changed paths — same as applyStatus.
    cb.onChanged(new Set([...staged, ...unstaged].map((f) => f.path)).size);
    void run(op, undefined, to === "staged" ? "Stage failed" : "Unstage failed", () => {
      staged = before.staged;
      unstaged = before.unstaged;
      pruneChecked();
      resolveSelection();
      render();
    });
  }

  // The selected file's hunks are deliberately left alone — they reload with
  // the status, and re-fetching them here would put a loading flicker in the
  // diff pane for no gain.
  function moveFiles(paths: string[], to: Panel): void {
    ({ staged, unstaged } = movedBetweenPanels({ staged, unstaged }, paths, to));
  }

  function stageEach(paths: string[]): void {
    runStaging(paths, "staged", async () => {
      for (const p of paths) await cb.stage(p);
    });
  }

  function unstageEach(paths: string[]): void {
    runStaging(paths, "unstaged", async () => {
      for (const p of paths) await cb.unstage(p);
    });
  }

  function stageAllAction(): void {
    runStaging(unstaged.map((f) => f.path), "staged", cb.stageAll);
  }

  function unstageAllAction(): void {
    runStaging(staged.map((f) => f.path), "unstaged", cb.unstageAll);
  }

  async function discardFilesAction(paths: string[]): Promise<void> {
    const what = paths.length > 1 ? `${paths.length} files` : paths[0];
    const ok = await cb.confirm(`Discard changes to ${what}? This cannot be undone.`);
    if (!ok) {
      cb.setStatus("Discard cancelled.");
      return;
    }
    await run(() => cb.discardFiles(paths));
  }

  async function ignoreAction(paths: string[]): Promise<void> {
    await run(async () => {
      const added = await cb.addToGitignore(paths);
      cb.setStatus(
        added > 0 ? `Added ${added} entr${added > 1 ? "ies" : "y"} to .gitignore.` : "Already ignored.",
      );
    });
  }

  function panel(which: Panel, label: string, files: FileDiff[]): HTMLElement {
    const box = el("div", { class: "stage-panel" });

    const head = el("div", { class: "stage-head" }, [
      el("span", { class: "stage-title", text: `${label} (${files.length})` }),
    ]);
    const allBtn = el("button", {
      class: "btn ghost small",
      text: which === "unstaged" ? "Stage All" : "Unstage All",
    }) as HTMLButtonElement;
    allBtn.disabled = files.length === 0;
    allBtn.addEventListener("click", () =>
      which === "unstaged" ? stageAllAction() : unstageAllAction(),
    );
    head.append(allBtn);
    box.append(head);

    const tree = el("div", { class: "stage-tree" });
    const status = new Map(files.map((f) => [f.path, f.status]));
    if (files.length === 0) {
      tree.append(el("div", { class: "stage-empty", text: `No ${which} changes` }));
    } else {
      renderFileTree(tree, files.map((f) => f.path), {
        collapsed: collapsed[which],
        onToggle: (p) => {
          const set = collapsed[which];
          if (set.has(p)) set.delete(p);
          else set.add(p);
          render();
        },
        statusOf: (p) => status.get(p) ?? null,
        onFileClick: (p) => selectFile(which, p),
        onFileDblClick: (p) => {
          // Amend-only rows aren't really staged, so there's nothing to unstage.
          if (which === "staged" && amendOnly(p)) return;
          if (!isActionable(status.get(p))) return; // conflicted: resolve, don't stage
          if (which === "unstaged") runStaging([p], "staged", () => cb.stage(p));
          else runStaging([p], "unstaged", () => cb.unstage(p));
        },
        onFileContextMenu: (p, e) => openFileMenu(which, p, e),
        selectedPath: selected?.panel === which ? selected.path : undefined,
        // Amend-only rows can't be acted on, so no checkboxes while amending the
        // staged panel; otherwise every changed file gets one.
        checkable: !(which === "staged" && amend),
        checkedPaths: checked[which],
        onToggleCheck: (paths, on) => {
          for (const p of paths) on ? checked[which].add(p) : checked[which].delete(p);
          render();
        },
      });
    }
    // Conflicted rows get a "Resolve" link to the conflict view in place of
    // staging (see isActionable); the badge class marks them in CSS.
    if (which === "unstaged" && cb.openConflicts) {
      for (const row of tree.querySelectorAll<HTMLElement>(".tree-file")) {
        const p = row.getAttribute("title") ?? "";
        if (status.get(p) !== "Conflicted") continue;
        row.classList.add("conflicted");
        const link = el("button", { class: "btn ghost small tree-resolve", text: "Resolve" });
        link.addEventListener("click", (e) => {
          e.stopPropagation();
          cb.openConflicts?.();
        });
        row.append(link);
      }
    }
    box.append(tree);
    return box;
  }

  function commitBox(): HTMLElement {
    const box = el("div", { class: "commit-box" });

    const subjectInput = el("input", {
      class: "commit-subject",
      placeholder: "Commit subject",
      value: subject,
      // A commit subject is code-adjacent prose — `fix(gui):`, file paths,
      // ticket ids — so the platform capitalising the first letter and
      // "correcting" identifiers is a hindrance, not a help.
      spellcheck: "false",
      autocapitalize: "none",
      autocorrect: "off",
      autocomplete: "off",
    }) as HTMLInputElement;
    subjectInput.addEventListener("input", () => {
      subject = subjectInput.value;
      commitBtn.disabled = !canCommit();
    });
    // Cmd/Ctrl+Enter commits from either field, as in most commit boxes. A
    // disabled button ignores click(), so nothing to commit means no-op.
    const commitOnShortcut = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      commitBtn.click();
    };
    subjectInput.addEventListener("keydown", commitOnShortcut);

    const bodyInput = el("textarea", {
      class: "commit-body",
      placeholder: "Description",
      rows: 3,
      spellcheck: "false",
      autocapitalize: "none",
      autocorrect: "off",
    }) as HTMLTextAreaElement;
    bodyInput.value = body;
    bodyInput.addEventListener("input", () => {
      body = bodyInput.value;
    });
    bodyInput.addEventListener("keydown", commitOnShortcut);
    autoGrowTextarea(bodyInput);

    const amendBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    amendBox.checked = amend;
    amendBox.addEventListener("change", () => void toggleAmend(amendBox.checked));
    const amendLabel = el("label", { class: "commit-amend" }, [amendBox, "Amend"]);
    const signLabel = signToggle();

    const skipBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    skipBox.checked = skipHooks;
    skipBox.addEventListener("change", () => {
      skipHooks = skipBox.checked;
    });
    const skipLabel = el(
      "label",
      { class: "commit-amend", title: "Skip the pre-commit and commit-msg hooks (git commit --no-verify)" },
      [skipBox, "Skip hooks"],
    );
    const pushBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    pushBox.checked = cb.pushAfterCommit();
    pushBox.addEventListener("change", () => cb.setPushAfterCommit(pushBox.checked));
    const pushLabel = el("label", { class: "commit-amend", title: "Push the branch after committing" }, [
      pushBox,
      "Push after commit",
    ]);

    const commitBtn = el("button", { class: "btn commit-btn", text: "Commit" }) as HTMLButtonElement;
    commitBtn.disabled = !canCommit();
    commitBtn.addEventListener("click", () => {
      if (!canCommit()) return;
      const subj = subject.trim();
      const bdy = body;
      const am = amend;
      const sg = signing?.can_sign ? sign : null;
      const noVerify = skipHooks;
      const pushAfter = cb.pushAfterCommit();
      run(
        async () => {
          const out = await cb.commit(subj, bdy, am, sg, noVerify);
          cb.reportDone(out || "Committed.");
        },
        () => {
          resetMessage();
          amend = false;
          amendFiles = [];
          amendPrefill = null;
          skipHooks = false;
          cb.onCommitted();
          if (pushAfter) cb.push();
        },
        "Commit failed",
      );
    });

    const toggles = [amendLabel, ...(signLabel ? [signLabel] : []), skipLabel, pushLabel];
    const controls = el("div", { class: "commit-controls" }, [...toggles, commitBtn]);
    box.append(subjectInput, bodyInput, controls);
    return box;
  }

  // "Sign": passes -S / --no-gpg-sign explicitly. Disabled, saying why, when no
  // signing key is configured; hidden until the repo's setup has loaded.
  function signToggle(): HTMLElement | null {
    if (!signing) return null;
    const box = el("input", { type: "checkbox", disabled: !signing.can_sign }) as HTMLInputElement;
    box.checked = signing.can_sign && sign;
    box.addEventListener("change", () => {
      sign = box.checked;
    });
    const title = signing.can_sign
      ? "Sign the commit with your GPG / SSH key (git commit -S)"
      : "No signing key configured — set user.signingkey to sign commits";
    const cls = `commit-amend${signing.can_sign ? "" : " disabled"}`;
    return el("label", { class: cls, title }, [box, "Sign"]);
  }

  // Read the repo's commit.template and, if the box is still empty, fill it in.
  function loadTemplate(): void {
    const token = ++templateToken;
    template = null;
    cb.fetchCommitTemplate()
      .then((raw) => {
        if (token !== templateToken) return;
        const wasEmpty = subject.trim() === "" && body.trim() === "";
        template = raw === null ? null : templateMessage(raw);
        if (template && wasEmpty) {
          resetMessage();
          render();
        }
      })
      .catch(() => {}); // unreadable template file: just no pre-fill
  }

  // Whether the box holds nothing the user wrote: empty, or still exactly the
  // template — which other pre-fills (amend, a merge message) may replace.
  function messageUntouched(): boolean {
    if (subject.trim() === "" && body.trim() === "") return true;
    return template !== null && subject === template.subject && body === template.body;
  }

  // Empty the box — back to the template, when there is one.
  function resetMessage(): void {
    subject = template?.subject ?? "";
    body = template?.body ?? "";
  }

  function loadSigning(): void {
    const token = ++signingToken;
    signing = null;
    cb.fetchSigningConfig()
      .then((cfg) => {
        if (token !== signingToken) return;
        signing = cfg;
        sign = cfg.sign_by_default;
        render();
      })
      .catch(() => {}); // no repo open, or unreadable config: just no toggle
  }

  // Toggle "Amend last commit": pull in HEAD's message (if the box is empty) and
  // its files (shown in Staged), or undo both when switching off.
  async function toggleAmend(on: boolean): Promise<void> {
    amend = on;
    if (on) {
      const head = await cb.fetchHead().catch(() => null);
      // Unticked again (or reset) while HEAD was loading: don't pre-fill a
      // message and files for an amend that's no longer wanted.
      if (!amend) return;
      if (head) {
        amendFiles = head.files;
        // Only pre-fill an empty box, so we never clobber a typed message.
        if (messageUntouched()) {
          subject = head.summary;
          const rest = head.message.startsWith(head.summary)
            ? head.message.slice(head.summary.length)
            : head.message;
          body = rest.replace(/^\s+/, "").trimEnd();
          amendPrefill = { subject, body };
        }
      }
    } else {
      amendFiles = [];
      // Clear the message only if it's still exactly what we pre-filled.
      if (amendPrefill && subject === amendPrefill.subject && body === amendPrefill.body) {
        resetMessage();
      }
      amendPrefill = null;
    }
    render();
  }

  // Files shown in the Staged panel: real staged changes plus, when amending,
  // HEAD's files that aren't already staged (so the amended commit's full
  // contents are visible). Real staged entries win on path collisions.
  function stagedDisplay(): FileDiff[] {
    if (!amend) return staged;
    const paths = new Set(staged.map((f) => f.path));
    return [...staged, ...amendFiles.filter((f) => !paths.has(f.path))];
  }

  // A staged-panel path that comes only from the amended commit (not actually
  // staged) — its diff is the cached HEAD hunks, and it can't be unstaged.
  function amendOnly(path: string): FileDiff | undefined {
    if (!amend || staged.some((f) => f.path === path)) return undefined;
    return amendFiles.find((f) => f.path === path);
  }

  function canCommit(): boolean {
    return subject.trim() !== "" && (staged.length > 0 || amend);
  }

  function prefillMessage(newSubject: string, newBody: string): void {
    if (!messageUntouched()) return; // don't clobber what's already typed
    subject = newSubject;
    body = newBody;
    render();
  }

  function clearPrefill(oldSubject: string, oldBody: string): void {
    if (subject !== oldSubject || body !== oldBody) return; // the user changed it; keep it
    resetMessage();
    render();
  }

  function reset(): void {
    staged = [];
    unstaged = [];
    selected = null;
    selectedDiff = null;
    selectedDiffSummary = null;
    diffLoaded = false;
    diffToken++; // drop any diff fetch still in flight for the old repo
    collapsed.unstaged.clear();
    collapsed.staged.clear();
    checked.unstaged.clear();
    checked.staged.clear();
    subject = "";
    body = "";
    amend = false;
    amendFiles = [];
    amendPrefill = null;
    skipHooks = false;
    loadSigning();
    loadTemplate();
    render();
  }

  render();
  return { reload, isBusy: () => busy, applyStatus, recheckDiff, prefillMessage, clearPrefill, reset };
}

// A commit.template's text as a subject and body: lines starting with `#` are
// dropped (git strips them from the final message anyway), the first line is
// the subject and the rest, past any blank lines, the body. Null when nothing
// but comments and whitespace is left.
export function templateMessage(raw: string): { subject: string; body: string } | null {
  const text = raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trimEnd();
  if (text.trim() === "") return null;
  const [subject, ...rest] = text.split("\n");
  return { subject, body: rest.join("\n").replace(/^\s*\n/, "") };
}

// Why block / line staging is off while whitespace is ignored (selectedDiffWs).
const WS_BLOCKED =
  "Turn off Ignore whitespace to stage or discard single blocks or lines — the blocks shown leave out whitespace changes, so they aren't the file's real changes.";

// Whether two fetched diffs show exactly the same thing: same file, same
// hunks, same lines with the same numbers.
export function sameDiff(a: FileDiff | null, b: FileDiff | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.path !== b.path || a.old_path !== b.old_path || a.status !== b.status) return false;
  if (a.hunks.length !== b.hunks.length) return false;
  return a.hunks.every((h, i) => {
    const o = b.hunks[i];
    return (
      h.header === o.header &&
      h.lines.length === o.lines.length &&
      h.lines.every((l, j) => {
        const m = o.lines[j];
        return (
          l.origin === m.origin &&
          l.old_lineno === m.old_lineno &&
          l.new_lineno === m.new_lineno &&
          l.content === m.content
        );
      })
    );
  });
}

// Whether a file row can be staged/unstaged/discarded from Local Changes. An
// unmerged (Conflicted) file can't: it's resolved in the conflict view.
export function isActionable(status: ChangeKind | undefined): boolean {
  return status !== undefined && status !== "Conflicted";
}

// The status a file takes on the other side of a stage/unstage. `git add` on an
// untracked file makes it an Added index entry, and unstaging an Added entry
// leaves the file untracked again; every other kind reads the same on both
// sides. Used by the optimistic move — see moveFiles.
function stagedStatus(status: ChangeKind): ChangeKind {
  return status === "Untracked" ? "Added" : status;
}

function unstagedStatus(status: ChangeKind): ChangeKind {
  return status === "Added" ? "Untracked" : status;
}

// Move whole files between the staged and unstaged panels the way `git add
// <path>` / `git reset <path>` will, returning new lists rather than mutating
// the given ones — the originals stay usable as the snapshot to roll back to.
// Pure, so the guess the optimistic update makes can be tested directly.
export function movedBetweenPanels(
  lists: StatusLists,
  paths: string[],
  to: Panel,
): StatusLists {
  const set = new Set(paths);
  const source = to === "staged" ? lists.unstaged : lists.staged;
  const target = to === "staged" ? lists.staged : lists.unstaged;
  const restatus = to === "staged" ? stagedStatus : unstagedStatus;
  // A partially-staged file already has an entry on the destination side;
  // staging the rest of it doesn't add a second row for the same path.
  const present = new Set(target.map((f) => f.path));
  const arrivals = source
    .filter((f) => set.has(f.path) && !present.has(f.path))
    .map((f) => ({ ...f, status: restatus(f.status) }));
  const kept = source.filter((f) => !set.has(f.path));
  return to === "staged"
    ? { staged: [...target, ...arrivals], unstaged: kept }
    : { staged: kept, unstaged: [...target, ...arrivals] };
}
