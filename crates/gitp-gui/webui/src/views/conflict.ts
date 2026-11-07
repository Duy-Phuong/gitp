// The merge/rebase conflict resolver: a file list (Conflicted / Resolved) with a
// commit box on the left, and an IntelliJ-style 3-column merge editor on the
// right — Ours | Result | Theirs, line-aligned in one scroll container so the
// columns scroll together. Each conflict has gutter arrows (≫ accept ours into
// Result, ≪ accept theirs, × reset); the center Result is editable. Ours/Theirs
// colour lines new on a branch green and lines changed on both sides red. A file
// is saved (staged) once every conflict is resolved; when all files are resolved
// Commit and Merge (merge) / Continue Rebase (rebase) is enabled.

import { conflictPrompt, parseSuggestions, type ConflictQuestion } from "../conflict-help";
import { clear, el } from "../dom";
import { highlighter, type Run } from "../highlight";
import { loadSyntaxHighlight } from "../prefs";
import type { ConflictSides, ConflictStatus, SideCommits } from "../types";
import { wordDiff, type Seg } from "../worddiff";
import { appendCode } from "./detail";

export interface ConflictCallbacks {
  fetchStatus: () => Promise<ConflictStatus>;
  fetchSides: (path: string) => Promise<ConflictSides>;
  // The commits each side made to the file since the sides split.
  fetchSideCommits: (path: string) => Promise<SideCommits>;
  // Ask Claude to resolve the conflicts described in `input`; resolves with
  // its answer (see conflictPrompt / parseSuggestions).
  suggest: (path: string, input: string) => Promise<string>;
  // git rerere (remember resolutions) for this repository.
  rerere: { get: () => Promise<boolean>; set: (on: boolean) => Promise<void> };
  resolve: (path: string, content: string) => Promise<void>;
  resolveSide: (path: string, ours: boolean) => Promise<void>;
  // Open the file in the OS default application (e.g. the user's editor).
  openInEditor: (path: string) => Promise<void>;
  // Open the file in the user's `git mergetool`.
  openInMergeTool: (path: string) => void;
  abort: () => Promise<string>;
  finish: (message: string) => Promise<string>;
  confirm: (message: string) => Promise<boolean>;
  setStatus: (msg: string) => void;
  // An async outcome worth a toast as well as the status line — see
  // main.ts's reportDone.
  reportDone: (msg: string) => void;
  reportError: (title: string, detail: string) => void;
  // Called after a successful finish/abort so the host can leave the view and
  // refresh history + sidebar. `aborted` distinguishes the two: a caller
  // driving a multi-step batch (e.g. bulk cherry-pick) through this resolver
  // resumes the remaining steps on finish, but cancels them on abort.
  onDone: (message: string, aborted: boolean) => void;
}

export interface ConflictHandle {
  reload: () => Promise<void>;
  // Forget all per-file resolutions and session state, so the next merge/rebase
  // starts fresh (called when a merge/rebase ends via abort or commit).
  reset: () => void;
}

export interface ConflictRegion {
  start: number; // char offset of the '<<<<<<<' line
  end: number; // char offset just past the '>>>>>>>' line
  ours: string;
  theirs: string;
}

// Split conflict-marked text into its regions, capturing each side's text and
// the char range so a "take" can splice a replacement in. Handles the optional
// diff3 base section (`|||||||`), which is dropped.
export function parseConflictRegions(text: string): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  let cur: { start: number; ours: string[]; theirs: string[]; sect: "ours" | "base" | "theirs" } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const len = line.length + 1; // account for the '\n' removed by split
    if (line.startsWith("<<<<<<<")) {
      cur = { start: offset, ours: [], theirs: [], sect: "ours" };
    } else if (cur && line.startsWith("|||||||")) {
      cur.sect = "base";
    } else if (cur && line.startsWith("=======")) {
      cur.sect = "theirs";
    } else if (cur && line.startsWith(">>>>>>>")) {
      const join = (a: string[]) => (a.length ? `${a.join("\n")}\n` : "");
      regions.push({ start: cur.start, end: offset + len, ours: join(cur.ours), theirs: join(cur.theirs) });
      cur = null;
    } else if (cur) {
      if (cur.sect === "ours") cur.ours.push(line);
      else if (cur.sect === "theirs") cur.theirs.push(line);
    }
    offset += len;
  }
  return regions;
}

// The question to ask before "take ours/theirs" replaces `path` wholesale, or
// null when nothing would be lost: the file still holds what git wrote, and
// no choices for it are pending in the resolver.
export function takeSideWarning(path: string, ours: boolean, edited: boolean, choices: boolean): string | null {
  const lost = [
    edited ? "edits made to the file on disk" : null,
    choices ? "the choices made for it here" : null,
  ].filter(Boolean);
  if (!lost.length) return null;
  return `Take ${ours ? "ours" : "theirs"} for ${path}?\n\nThis replaces the whole file and discards ${lost.join(" and ")}.`;
}

// --- 3-way diff (diff3) ----------------------------------------------------
// Aligns base/ours/theirs so the editor can show ALL changes — not just the
// conflict-marked regions — and tell non-conflicting changes (green) from real
// conflicts (red).

export interface Diff3Stable {
  kind: "stable";
  lines: string[];
}
export interface Diff3Changed {
  kind: "changed";
  base: string[];
  ours: string[];
  theirs: string[];
  conflict: boolean;
  // The auto-merged result for a non-conflicting change (null for a conflict,
  // which needs manual resolution).
  auto: string[] | null;
}
export type Diff3Chunk = Diff3Stable | Diff3Changed;

function eqLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// The LCS matches between `a` and `b` as [aIndex, bIndex] pairs (monotonic).
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

// Split base/ours/theirs into stable regions (identical in all three) and
// changed regions, classifying each change as conflicting or auto-mergeable.
export function diff3(base: string[], ours: string[], theirs: string[]): Diff3Chunk[] {
  const mo = new Map(lcsPairs(base, ours)); // baseIdx -> oursIdx
  const mt = new Map(lcsPairs(base, theirs)); // baseIdx -> theirsIdx
  const sync: number[] = [];
  for (let b = 0; b < base.length; b++) if (mo.has(b) && mt.has(b)) sync.push(b);

  const chunks: Diff3Chunk[] = [];
  let stable: string[] = [];
  const flush = () => {
    if (stable.length) chunks.push({ kind: "stable", lines: stable });
    stable = [];
  };
  const emitChanged = (ob: number, oo: number, ot: number, cb: number, co: number, ct: number) => {
    const b = base.slice(ob, cb);
    const o = ours.slice(oo, co);
    const t = theirs.slice(ot, ct);
    if (!b.length && !o.length && !t.length) return;
    flush(); // stable lines precede this changed chunk
    const oursChanged = !eqLines(o, b);
    const theirsChanged = !eqLines(t, b);
    let conflict = false;
    let auto: string[] | null;
    if (oursChanged && theirsChanged) {
      if (eqLines(o, t)) auto = o;
      else {
        conflict = true;
        auto = null;
      }
    } else if (oursChanged) auto = o;
    else if (theirsChanged) auto = t;
    else auto = b;
    chunks.push({ kind: "changed", base: b, ours: o, theirs: t, conflict, auto });
  };

  let pb = -1;
  let po = -1;
  let pt = -1;
  for (const b of sync) {
    const o = mo.get(b)!;
    const t = mt.get(b)!;
    emitChanged(pb + 1, po + 1, pt + 1, b, o, t);
    stable.push(base[b]);
    pb = b;
    po = o;
    pt = t;
  }
  emitChanged(pb + 1, po + 1, pt + 1, base.length, ours.length, theirs.length);
  flush();
  return chunks;
}

// Split a git blob string into lines, dropping the single trailing newline's
// phantom empty element so all three sides split consistently.
export function splitLines(s: string | null): string[] {
  if (s == null || s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Assemble the result: stable lines verbatim, each changed chunk replaced by
// its chosen resolution (empty when reset — Save is gated on allResolved()).
// `splitLines` drops the blob's trailing newline, so it is re-added here when
// the sides had one; otherwise every saved file would end without "\n".
export function assembleLines(chunks: Diff3Chunk[], res: (string[] | null)[], trailingNewline: boolean): string {
  const out: string[] = [];
  let ci = 0;
  for (const c of chunks) {
    if (c.kind === "stable") out.push(...c.lines);
    else out.push(...(res[ci++] ?? []));
  }
  if (!out.length) return "";
  return out.join("\n") + (trailingNewline ? "\n" : "");
}

export type Side = "ours" | "theirs";

// Append `lines` of `side` to a chunk's resolution, unless that side was
// already accepted into it (a repeated ≫ must not duplicate the lines;
// "ours then theirs" still appends). Records the side in `accepted`.
export function acceptLines(current: string[] | null, accepted: Set<Side>, side: Side, lines: string[]): string[] {
  if (accepted.has(side)) return current ?? [];
  accepted.add(side);
  return [...(current ?? []), ...lines];
}


export function setupConflict(host: HTMLElement, cb: ConflictCallbacks): ConflictHandle {
  let status: ConflictStatus | null = null;
  // Files that were conflicted at any point this session, so Resolved = initial
  // − currently-conflicted.
  const initial = new Set<string>();
  let message = "";
  let messageInit = false;
  let selected: string | null = null;
  let sides: ConflictSides | null = null;
  let sidesLoading = false;
  // The selected file's 3-way diff, its conflict chunks (subset), and the
  // per-conflict resolution (null = unresolved). Resolutions persist per file so
  // switching away and back keeps progress.
  let chunks: Diff3Chunk[] = [];
  // Every changed chunk (green non-conflicting AND red conflicting) is decided
  // by the user; res is parallel to changedChunks (null = undecided).
  let changedChunks: Diff3Changed[] = [];
  let res: (string[] | null)[] = [];
  // Which sides have been accepted into each resolution — parallel to `res`.
  let accepted: Set<Side>[] = [];
  // Claude's reason for each change it resolved — keyed like `res`. Its
  // blocks show purple until the file is saved.
  let why = new Map<number, string>();
  const resStore = new Map<
    string,
    { res: (string[] | null)[]; accepted: Set<Side>[]; why: Map<number, string> }
  >();
  const store = () => resStore.set(selected!, { res, accepted, why });
  // The selected file's commits per side ("why each side changed").
  let sideCommits: SideCommits | null = null;
  let whyOpen = true;
  // Files Claude is working on now.
  const suggesting = new Set<string>();
  // Syntax runs of the selected file's ours/theirs lines, by line index.
  let oursRuns: Run[][] | null = null;
  let theirsRuns: Run[][] | null = null;
  // Show the base (the text before both sides changed it) in the Result
  // column of an undecided change.
  let showBase = loadShowBase();
  let rerereOn: boolean | null = null;
  // The keys of the editor on screen (n / p / [ / ] / ⌘S), or null.
  let editorKeys: Record<string, () => void> | null = null;
  let editorSave: (() => void) | null = null;
  // Scroll the focused change into view after the next render (keys move it).
  let scrollToCur = false;
  // Whether the sides ended with "\n" (splitLines drops it; see assembleLines).
  let trailingNewline = true;
  // Which changed chunk the ↑/↓ nav is focused on.
  let curChange = 0;
  let busy = false;

  async function reload(): Promise<void> {
    // A refresh runs on any click (see external-refresh.ts). Redrawing when
    // nothing changed would swap the row under the pointer between its
    // mousedown and mouseup, and the click would be lost.
    const before = host.childElementCount ? JSON.stringify(status) : null;
    status = await cb.fetchStatus();
    if (rerereOn === null && status.kind !== "none") {
      void cb.rerere.get().then((on) => {
        rerereOn = on;
        render();
      }, () => {});
    }
    for (const p of status.conflicted) initial.add(p);
    if (!messageInit && status.message) {
      message = status.message;
      messageInit = true;
    }
    // Keep a valid selection: default to the first still-conflicted file.
    if (selected && !status.conflicted.includes(selected) && !resolvedList().includes(selected)) {
      selected = null;
    }
    if (!selected && status.conflicted.length) void selectFile(status.conflicted[0]);
    else if (JSON.stringify(status) !== before) render();
  }

  function resolvedList(): string[] {
    const conflicted = new Set(status?.conflicted ?? []);
    return [...initial].filter((p) => !conflicted.has(p));
  }

  // Drop all session state so a later merge/rebase starts from scratch rather
  // than replaying the previous session's partial choices.
  function resetSession(): void {
    resStore.clear();
    initial.clear();
    message = "";
    messageInit = false;
    selected = null;
    sides = null;
    chunks = [];
    changedChunks = [];
    res = [];
    accepted = [];
    why = new Map<number, string>();
    sideCommits = null;
    curChange = 0;
    status = null;
  }

  async function selectFile(path: string): Promise<void> {
    selected = path;
    sides = null;
    sideCommits = null;
    sidesLoading = true;
    render();
    void cb.fetchSideCommits(path).then(
      (c) => {
        if (selected !== path) return;
        sideCommits = c;
        render();
      },
      () => {},
    );
    const s = await cb.fetchSides(path);
    if (selected !== path) return; // selection moved on
    sides = s;
    sidesLoading = false;
    // Full 3-way diff of the branch revisions, so non-conflicting changes show
    // too — not only the conflict-marker regions.
    chunks = diff3(splitLines(s.base), splitLines(s.ours), splitLines(s.theirs));
    changedChunks = chunks.filter((c): c is Diff3Changed => c.kind === "changed");
    const stored = resStore.get(path);
    res = stored?.res ?? changedChunks.map(() => null);
    accepted = stored?.accepted ?? changedChunks.map(() => new Set<Side>());
    why = stored?.why ?? new Map<number, string>();
    store();
    // Each side highlighted as one text, so a line reads with what came
    // before it in its own version.
    oursRuns = highlight(path, splitLines(s.ours));
    theirsRuns = highlight(path, splitLines(s.theirs));
    trailingNewline = (s.ours?.endsWith("\n") ?? false) || (s.theirs?.endsWith("\n") ?? false);
    curChange = 0;
    render();
  }

  function allResolved(): boolean {
    return res.every((r) => r !== null);
  }

  function assembleResult(): string {
    return assembleLines(chunks, res, trailingNewline);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (err) {
      cb.reportError("Conflict operation failed", String(err));
    } finally {
      busy = false;
    }
  }

  // --- rendering ------------------------------------------------------------

  function render(): void {
    editorKeys = null;
    editorSave = null;
    clear(host);
    if (!status || status.kind === "none") {
      host.append(el("div", { class: "detail-empty", text: "No conflicts to resolve." }));
      return;
    }
    const wrap = el("div", { class: "conflict" });
    wrap.append(leftPanel(), mainPanel());
    host.append(wrap);
  }

  function leftPanel(): HTMLElement {
    const box = el("div", { class: "conflict-side" });
    box.append(el("div", { class: "conflict-summary", text: status!.summary || "Resolving conflicts" }));
    const { step, steps } = status!;
    if (status!.kind === "rebase" && step && steps) {
      box.append(el("div", { class: "conflict-progress", text: `Commit ${step} of ${steps}` }));
    }
    box.append(
      el("div", { class: "conflict-sides" }, [
        el("div", {}, [el("span", { class: "conflict-side-tag ours", text: "Ours" }), el("span", { text: oursLabel() })]),
        el("div", {}, [
          el("span", { class: "conflict-side-tag theirs", text: "Theirs" }),
          el("span", { text: theirsLabel() }),
        ]),
        ...(status!.kind === "rebase"
          ? [el("div", { class: "conflict-sides-note", text: "In a rebase git swaps the sides: ours is the branch you rebase onto, theirs is your commit." })]
          : []),
      ]),
    );

    const conflicted = status!.conflicted;
    const cHead = el("div", { class: "conflict-list-head" }, [
      el("span", { text: `Conflicted Files (${conflicted.length})` }),
    ]);
    if (conflicted.length) {
      const markAll = el("button", { class: "btn ghost small", text: "Mark all resolved" });
      markAll.addEventListener("click", () => void markAllResolved());
      cHead.append(markAll);
    }
    box.append(cHead);
    const cList = el("div", { class: "conflict-list" });
    for (const p of conflicted) cList.append(fileRow(p, false, status!.clean.includes(p)));
    if (!conflicted.length) cList.append(el("div", { class: "stage-empty", text: "All conflicts resolved" }));
    box.append(cList);

    const resolved = resolvedList();
    box.append(el("div", { class: "conflict-list-head" }, [el("span", { text: `Resolved Files (${resolved.length})` })]));
    const rList = el("div", { class: "conflict-list" });
    for (const p of resolved) rList.append(fileRow(p, true));
    box.append(rList);

    box.append(footer(status!.kind));
    return box;
  }

  function fileRow(path: string, resolved: boolean, clean = false): HTMLElement {
    const row = el("div", {
      class: `conflict-file${selected === path ? " selected" : ""}${resolved ? " resolved" : ""}${clean ? " clean" : ""}`,
      title: clean ? `${path}\nNo conflict markers left — Mark Resolved stages it as it is.` : path,
    });
    row.append(el("span", { class: "conflict-file-icon", text: resolved || clean ? "✓" : "⚠" }));
    row.append(el("span", { class: "tree-name", text: path }));
    row.addEventListener("click", () => void selectFile(path));
    return row;
  }

  // Only "merge" collects a fresh commit message here — rebase, cherry-pick,
  // and revert all continue with their own pending message via `--continue`.
  function footer(kind: ConflictStatus["kind"]): HTMLElement {
    const box = el("div", { class: "conflict-footer" });
    if (kind === "merge") {
      const msg = el("textarea", { class: "commit-body", placeholder: "Commit Message", rows: 3 });
      msg.value = message;
      msg.addEventListener("input", () => (message = msg.value));
      box.append(msg);
    }
    const done = status!.conflicted.length === 0;
    const finishLabel: Record<ConflictStatus["kind"], string> = {
      merge: "Commit and Merge",
      rebase: "Continue Rebase",
      "cherry-pick": "Continue Cherry-pick",
      revert: "Continue Revert",
      none: "Continue",
    };
    const finishBtn = el("button", {
      class: "btn commit-btn",
      text: finishLabel[kind],
    });
    // `run()` guards against re-entrancy, so no need to also disable on `busy`
    // (render happens inside run() while busy is still true).
    finishBtn.disabled = !done;
    finishBtn.addEventListener("click", () => void finish());

    const abortBtn = el("button", { class: "btn danger", text: "Abort" });
    abortBtn.addEventListener("click", () => void abort());

    box.append(el("div", { class: "conflict-footer-actions" }, [abortBtn, finishBtn]));
    if (rerereOn !== null) {
      const check = el("input", { type: "checkbox" });
      check.checked = rerereOn;
      check.addEventListener("change", () => {
        const on = check.checked;
        void cb.rerere.set(on).then(
          () => {
            rerereOn = on;
            cb.setStatus(on ? "git rerere is on: resolutions are remembered from the next conflict on." : "git rerere is off.");
          },
          (err) => {
            check.checked = !on;
            cb.reportError("Could not change git rerere", String(err));
          },
        );
      });
      box.append(
        el(
          "label",
          {
            class: "conflict-rerere",
            title:
              "git rerere records how you resolve a conflict, and resolves the same conflict the same way when it comes back " +
              "(for example when you rebase this branch again). It starts with the next conflict.",
          },
          [check, el("span", { text: "Remember my resolutions (git rerere)" })],
        ),
      );
    }
    return box;
  }

  function oursLabel(): string {
    return status?.ours_label || "current";
  }
  function theirsLabel(): string {
    return status?.theirs_label || "incoming";
  }

  function mainPanel(): HTMLElement {
    const box = el("div", { class: "conflict-main" });
    if (!selected) {
      box.append(el("div", { class: "detail-empty", text: "Select a conflicted file to resolve." }));
      return box;
    }
    if (sidesLoading || !sides) {
      box.append(el("div", { class: "detail-empty", text: "Loading conflict…" }));
      return box;
    }
    if (sides.binary) {
      box.append(binaryEditor(sides));
      return box;
    }
    if (sides.ours === null || sides.theirs === null) {
      box.append(deletedEditor(sides));
      return box;
    }
    box.append(textEditor(sides));
    return box;
  }

  // Delete/modify conflict: one side deleted the file, the other changed it.
  // The 3-way editor would show the deleted side as empty and "accepting" it
  // would write an empty file, so offer the real choice instead: keep the
  // surviving side's file, or delete it (resolveSide removes the file when the
  // chosen side is absent).
  function deletedEditor(s: ConflictSides): HTMLElement {
    const oursDeleted = s.ours === null;
    const box = el("div", { class: "conflict-editor" });
    box.append(
      el("div", { class: "conflict-editor-head" }, [
        el("span", { class: "conflict-editor-file", text: `${selected} — delete/modify conflict` }),
      ]),
    );
    const btn = (label: string, ours: boolean) => {
      const b = el("button", { class: "btn ghost small", text: label });
      b.addEventListener("click", () => void resolveWholeSide(ours));
      return b;
    };
    box.append(
      el("div", { class: "conflict-binary" }, [
        el("span", {
          text: oursDeleted
            ? `Deleted on ours (${oursLabel()}) / Modified on theirs (${theirsLabel()})`
            : `Modified on ours (${oursLabel()}) / Deleted on theirs (${theirsLabel()})`,
        }),
        btn(oursDeleted ? "Keep file (take theirs)" : "Keep file (take ours)", !oursDeleted),
        btn(oursDeleted ? "Delete file (take ours)" : "Delete file (take theirs)", oursDeleted),
      ]),
    );
    const surviving = (oursDeleted ? s.theirs : s.ours) ?? "";
    const pre = el("pre", { class: "conflict-deleted-text" });
    pre.textContent = surviving;
    box.append(pre);
    return box;
  }

  function binaryEditor(s: ConflictSides): HTMLElement {
    const box = el("div", { class: "conflict-editor" });
    const editBtn = el("button", { class: "btn ghost small", text: "Edit File" });
    editBtn.addEventListener("click", () => void cb.openInEditor(selected!));
    const toolBtn = el("button", { class: "btn ghost small", text: "Open in Merge Tool" });
    toolBtn.addEventListener("click", () => cb.openInMergeTool(selected!));
    box.append(
      el("div", { class: "conflict-editor-head" }, [
        el("span", { text: `${selected} — binary conflict` }),
        editBtn,
        toolBtn,
      ]),
    );
    const take = (glyph: string, title: string, ours: boolean) => {
      const b = el("button", { class: "btn ghost small icon-btn", text: glyph, title });
      b.addEventListener("click", () => void resolveWholeSide(ours));
      return b;
    };
    box.append(
      el("div", { class: "conflict-binary" }, [
        el("span", { text: "Binary file — pick a side:" }),
        take("←", "Take Ours", true),
        take("→", "Take Theirs", false),
      ]),
    );
    void s; // ours/theirs content isn't shown for binary
    return box;
  }

  // IntelliJ-style 3-column merge editor: Ours | Result | Theirs, line-numbered
  // and rendered from the 3-way diff, in one scroll container so the columns
  // scroll together and stay line-aligned.
  function textEditor(_s: ConflictSides): HTMLElement {
    const box = el("div", { class: "conflict-editor" });
    const total = changedChunks.length;
    const unresolved = res.filter((r) => r === null).length;
    const unresolvedConflicts = changedChunks.reduce(
      (n, c, i) => n + (c.conflict && res[i] === null ? 1 : 0),
      0,
    );
    const touched = res.some((r) => r !== null);
    const anchors: HTMLElement[] = [];
    // All cells (across all rows) of each changed chunk, so ↑/↓ can highlight the
    // whole active block — parallel to `anchors`/`changedChunks`.
    const changeCells: HTMLElement[][] = [];
    const highlightChange = () => {
      for (const arr of changeCells) for (const c of arr) c.classList.remove("cf-active");
      if (curChange >= 0 && curChange < changeCells.length) {
        for (const c of changeCells[curChange]) c.classList.add("cf-active");
      }
    };
    const jumpToUnresolved = () => {
      const i = res.findIndex((r) => r === null);
      if (i >= 0) anchors[i]?.scrollIntoView({ block: "center" });
    };

    // Bulk actions.
    const acceptAll = (ours: boolean) => {
      const side: Side = ours ? "ours" : "theirs";
      res = res.map((r, i) => {
        if (r !== null) return r;
        accepted[i] = new Set([side]);
        return changedChunks[i][side].slice();
      });
      store();
      render();
    };
    const applyNonConflicting = (mode: "ours" | "theirs" | "both") => {
      res = res.map((r, i) => {
        if (r !== null || changedChunks[i].conflict) return r;
        const c = changedChunks[i];
        accepted[i] = new Set(mode === "both" ? ["ours", "theirs"] : [mode]);
        return (mode === "ours" ? c.ours : mode === "theirs" ? c.theirs : (c.auto ?? [])).slice();
      });
      store();
      render();
    };
    const gotoChange = (delta: number) => {
      if (!anchors.length) return;
      curChange = (curChange + delta + anchors.length) % anchors.length;
      highlightChange();
      anchors[curChange]?.scrollIntoView({ block: "center" });
    };
    // [ / ]: take a side for the focused change, then move to the next
    // undecided one.
    const takeFocused = (ours: boolean) => {
      if (curChange < 0 || curChange >= total) return;
      const side: Side = ours ? "ours" : "theirs";
      res[curChange] = acceptLines(res[curChange], accepted[curChange], side, changedChunks[curChange][side]);
      store();
      const next = nextUndecided(curChange);
      if (next >= 0) curChange = next;
      scrollToCur = true;
      render();
    };

    const tbBtn = (label: string, title: string, onClick: () => void, disabled = false) => {
      const b = el("button", { class: "btn ghost small icon-btn", text: label, title });
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const txtBtn = (label: string, onClick: () => void, disabled = false, title = "") => {
      const b = el("button", { class: "btn ghost small", text: label, title });
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const save = el("button", { class: "btn", text: "Save" });
    save.disabled = !allResolved();
    save.title = allResolved()
      ? "Stage this file as resolved (⌘S)"
      : `Resolve ${unresolved} more change${unresolved !== 1 ? "s" : ""} to save`;
    save.addEventListener("click", () => void saveFile());

    editorKeys = {
      n: () => gotoChange(1),
      p: () => gotoChange(-1),
      "[": () => takeFocused(true),
      "]": () => takeFocused(false),
    };
    editorSave = () => {
      if (allResolved()) void saveFile();
    };

    // Remaining-work indicator; decrements as blocks are resolved. Clickable to
    // jump to the first unresolved change (so it's clear what's blocking Save).
    const count = el("span", {
      class: `conflict-editor-count${unresolved ? " pending" : " conflict-clean"}`,
      text: unresolved
        ? `${unresolved} unresolved${unresolvedConflicts ? ` · ${unresolvedConflicts} conflict${unresolvedConflicts !== 1 ? "s" : ""}` : ""}`
        : `all ${total} resolved`,
    });
    if (unresolved) {
      count.title = "Jump to the first unresolved change";
      count.addEventListener("click", jumpToUnresolved);
    }

    const path = selected!;
    const thinking = suggesting.has(path);
    const suggestBtn = txtBtn(
      thinking ? "✦ Claude is thinking…" : "✦ Suggest with Claude",
      () => void suggestWithClaude(),
      thinking || unresolvedConflicts === 0,
      unresolvedConflicts
        ? "Ask Claude to resolve the red conflicts of this file. Its proposals show in purple for you to check before Save."
        : "No conflicts left to resolve",
    );
    suggestBtn.classList.add("cf-suggest-btn");
    const baseBtn = txtBtn(
      "Base",
      () => {
        showBase = !showBase;
        saveShowBase(showBase);
        render();
      },
      false,
      "Show the base (the text before both sides changed it) in Result while a change is undecided",
    );
    if (showBase) baseBtn.classList.add("active");

    box.append(
      el("div", { class: "conflict-editor-head" }, [
        el("span", { class: "conflict-editor-file", text: path }),
        count,
        el("div", { class: "conflict-editor-actions" }, [
          tbBtn("↑", "Previous change (p)", () => gotoChange(-1), !total),
          tbBtn("↓", "Next change (n)", () => gotoChange(1), !total),
          el("span", { class: "conflict-tb-label", text: "Apply non-conflicting:" }),
          tbBtn("≫", "Take all non-conflicting from the left (ours)", () => applyNonConflicting("ours")),
          tbBtn("⇄", "Apply all non-conflicting changes", () => applyNonConflicting("both")),
          tbBtn("≪", "Take all non-conflicting from the right (theirs)", () => applyNonConflicting("theirs")),
          el("span", { class: "conflict-tb-sep" }),
          suggestBtn,
          baseBtn,
          txtBtn("Accept All Ours", () => acceptAll(true)),
          txtBtn("Accept All Theirs", () => acceptAll(false)),
          txtBtn("Cancel", () => cancelFile(), !touched),
          txtBtn("Edit File", () => void cb.openInEditor(path)),
          txtBtn("Open in Merge Tool", () => cb.openInMergeTool(path)),
          txtBtn("Mark Resolved", () => void markFileResolved()),
          save,
        ]),
      ]),
    );

    if (status?.clean.includes(path)) {
      box.append(
        el("div", { class: "conflict-banner" }, [
          el("span", {
            text: "This file has no conflict markers left on disk: git rerere or an edit already resolved it. Mark Resolved stages it as it is.",
          }),
          txtBtn("Mark Resolved", () => void markFileResolved()),
        ]),
      );
    }
    const proposals = [...why.keys()].filter((i) => res[i] !== null).length;
    if (proposals) {
      box.append(
        el("div", { class: "conflict-banner claude" }, [
          el("span", {
            text: `✦ Claude resolved ${proposals} conflict${proposals === 1 ? "" : "s"}: the purple blocks. Read each one (hover for Claude's reason), change or reset it, then Save.`,
          }),
        ]),
      );
    }
    box.append(whyPanel());

    // Result lines as they stand, highlighted as one text: the line numbers
    // of the Result column count exactly these.
    const resultRuns = highlight(path, assembleLines(chunks, res, false).split("\n"));

    const grid = el("div", { class: "merge3" });
    grid.append(
      headCell(`Ours · ${oursLabel()}`),
      el("div", { class: "merge-head merge-gutter" }),
      headCell("Result"),
      el("div", { class: "merge-head merge-gutter" }),
      headCell(`Theirs · ${theirsLabel()}`),
    );

    const runsAt = (runs: Run[][] | null, n: number) => runs?.[n - 1];
    // Per-column running line numbers (each column numbers its own file).
    const no = { o: 1, c: 1, t: 1 };
    let ci = 0;
    for (const c of chunks) {
      if (c.kind === "stable") {
        for (const l of c.lines) {
          appendRow(
            grid,
            { text: l, cls: "", no: no.o, runs: runsAt(oursRuns, no.o++) },
            null,
            { text: l, cls: "", no: no.c, runs: runsAt(resultRuns, no.c++) },
            null,
            { text: l, cls: "", no: no.t, runs: runsAt(theirsRuns, no.t++) },
            null,
          );
        }
        continue;
      }
      // Any change (conflict red / non-conflict green) is decided via arrows.
      // Once resolved the side columns dim to "done" so it's clear it's settled.
      const idx = ci++;
      const r = res[idx];
      const resolved = r !== null;
      const kind: Cell["cls"] = c.conflict ? "conflict" : "new";
      const side: Cell["cls"] = resolved ? "done" : kind;
      const oursCh = !eqLines(c.ours, c.base);
      const theirsCh = !eqLines(c.theirs, c.base);
      const reason = resolved ? why.get(idx) : undefined;
      const ghost = !resolved && showBase ? c.base : [];
      const h = Math.max(c.ours.length, c.theirs.length, r?.length ?? 0, ghost.length, 1);
      const blockCells: HTMLElement[] = [];
      for (let x = 0; x < h; x++) {
        // The words that differ between the two sides of an open conflict.
        const words =
          c.conflict && !resolved && x < c.ours.length && x < c.theirs.length
            ? wordDiff(c.ours[x], c.theirs[x])
            : null;
        const center: Cell | null = !resolved
          ? { text: ghost[x] ?? "", cls: kind, no: null, ghost: x < ghost.length } // undecided gap, tinted by kind
          : x < r.length
            ? {
                text: r[x],
                cls: reason !== undefined ? "claude" : "",
                no: no.c,
                runs: runsAt(resultRuns, no.c++),
                title: reason ? `Claude: ${reason}` : undefined,
              }
            : null;
        const cells = appendRow(
          grid,
          x < c.ours.length
            ? { text: c.ours[x], cls: oursCh ? side : "", no: no.o, runs: runsAt(oursRuns, no.o++), segs: words?.left }
            : null,
          x === 0 ? leftGutter(idx, resolved) : null,
          center,
          x === 0 ? rightGutter(idx, resolved) : null,
          x < c.theirs.length
            ? { text: c.theirs[x], cls: theirsCh ? side : "", no: no.t, runs: runsAt(theirsRuns, no.t++), segs: words?.right }
            : null,
          resolved && x < r.length ? { ci: idx, li: x } : null,
        );
        blockCells.push(...cells);
        if (x === 0) anchors.push(cells[0]);
      }
      changeCells.push(blockCells);
    }
    box.append(grid);
    grid.addEventListener("copy", onCopy);
    isolateMergeColumnDrag(grid);
    highlightChange();
    if (scrollToCur) {
      scrollToCur = false;
      requestAnimationFrame(() => anchors[curChange]?.scrollIntoView({ block: "center" }));
    }
    return box;
  }

  // The first undecided change after `from` (wrapping), or -1 when none is.
  function nextUndecided(from: number): number {
    for (let k = 1; k <= res.length; k++) {
      const i = (from + k) % res.length;
      if (res[i] === null) return i;
    }
    return -1;
  }

  // "Why each side changed": the commits that touched this file on each side
  // since they split, which tell the intent behind the lines in conflict.
  function whyPanel(): HTMLElement {
    const details = el("details", { class: "conflict-why" });
    details.open = whyOpen;
    details.addEventListener("toggle", () => (whyOpen = details.open));
    const list = (title: string, commits: SideCommits["ours"] | undefined) =>
      el("div", { class: "conflict-why-side" }, [
        el("div", { class: "conflict-why-title", text: title }),
        ...(commits === undefined
          ? [el("div", { class: "conflict-why-empty", text: "Loading…" })]
          : commits.length
            ? commits.map((c) =>
                el("div", { class: "conflict-why-commit", title: `${c.short} ${c.subject}\n${c.author}, ${c.when}` }, [
                  el("span", { class: "conflict-why-sha", text: c.short }),
                  el("span", { class: "conflict-why-subject", text: c.subject }),
                  el("span", { class: "conflict-why-meta", text: `${c.author} · ${c.when}` }),
                ]),
              )
            : [el("div", { class: "conflict-why-empty", text: "No commits found" })]),
      ]);
    details.append(
      el("summary", { text: "Why each side changed this file" }),
      el("div", { class: "conflict-why-body" }, [
        list(`Ours · ${oursLabel()}`, sideCommits?.ours),
        list(`Theirs · ${theirsLabel()}`, sideCommits?.theirs),
      ]),
    );
    return details;
  }

  // Ask Claude to resolve this file's open (red) conflicts. Its answers fill
  // those changes in Result, marked purple with its reason, for the user to
  // check, change or reset before Save. Nothing is staged.
  async function suggestWithClaude(): Promise<void> {
    const path = selected;
    if (!path || suggesting.has(path) || !status) return;
    const fileChunks = chunks;
    const fileRes = res;
    const asked: number[] = []; // conflict id - 1 → index into the changed chunks
    const questions: ConflictQuestion[] = [];
    let ci = -1;
    fileChunks.forEach((c, k) => {
      if (c.kind !== "changed") return;
      ci++;
      if (!c.conflict || fileRes[ci] !== null) return;
      const prev = fileChunks[k - 1];
      const next = fileChunks[k + 1];
      asked.push(ci);
      questions.push({
        id: asked.length,
        before: prev?.kind === "stable" ? prev.lines.slice(-3) : [],
        base: c.base,
        ours: c.ours,
        theirs: c.theirs,
        after: next?.kind === "stable" ? next.lines.slice(0, 3) : [],
      });
    });
    if (!questions.length) return;
    const input = conflictPrompt(
      {
        path,
        kind: status.kind,
        oursLabel: oursLabel(),
        theirsLabel: theirsLabel(),
        oursCommits: sideCommits?.ours ?? [],
        theirsCommits: sideCommits?.theirs ?? [],
      },
      questions,
    );
    suggesting.add(path);
    cb.setStatus(`Claude is resolving ${questions.length} conflict${questions.length === 1 ? "" : "s"} in ${path}…`);
    render();
    try {
      const answer = await cb.suggest(path, input);
      const found = parseSuggestions(answer);
      // The file's own state, even when another file is on screen now; none
      // when it was saved or the session ended meanwhile.
      const target = resStore.get(path);
      let applied = 0;
      if (target && target.res === fileRes) {
        for (const [id, sug] of found) {
          const idx = asked[id - 1];
          if (idx === undefined || target.res[idx] !== null) continue;
          target.res[idx] = sug.lines.slice();
          target.accepted[idx] = new Set();
          target.why.set(idx, sug.why);
          applied++;
        }
      }
      const left = questions.length - applied;
      cb.reportDone(
        applied
          ? `Claude resolved ${applied} of ${questions.length} conflict${questions.length === 1 ? "" : "s"} in ${path}${left ? `; ${left} left for you` : ""}. Check the purple blocks, then Save.`
          : `Claude left the conflicts in ${path} for you.`,
      );
    } catch (err) {
      cb.reportError("Claude could not suggest a resolution", String(err));
    } finally {
      suggesting.delete(path);
      render();
    }
  }

  interface Cell {
    text: string;
    cls: "" | "new" | "conflict" | "done" | "claude";
    no: number | null;
    // Syntax runs and word-diff segments of the text, when it has them.
    runs?: Run[];
    segs?: Seg[] | null;
    title?: string;
    // The base's text shown in an undecided change: not part of the result.
    ghost?: boolean;
  }

  function headCell(text: string): HTMLElement {
    return el("div", { class: "merge-head" }, [el("span", { class: "cf-no" }), el("span", { text })]);
  }

  // The three columns share one grid, so a multi-row drag started in one
  // visually bleeds the native selection highlight into the other two — same
  // cause `isolateSplitColumnDrag` fixes in detail.ts's split diff, applied
  // here to three sides instead of two. Once the other columns can't be
  // selected during the drag, `onCopy` below is only a fallback (e.g. a
  // keyboard-driven "select all" within the pane).
  function isolateMergeColumnDrag(grid: HTMLElement): void {
    grid.addEventListener("mousedown", (e) => {
      const line = (e.target as HTMLElement).closest(".cf-left, .cf-center, .cf-right");
      if (!line) return;
      const side = line.classList.contains("cf-left") ? "left" : line.classList.contains("cf-center") ? "center" : "right";
      grid.classList.add(`dragging-${side}`);
      window.addEventListener(
        "mouseup",
        () => grid.classList.remove("dragging-left", "dragging-center", "dragging-right"),
        { once: true },
      );
    });
  }

  // Copy handler for the merge grid — a fallback for selections the drag
  // isolation above doesn't cover (e.g. Cmd/Ctrl+A). Restrict the copy to the
  // column the selection started in and take only the source text, so each
  // panel copies cleanly, without line numbers.
  function onCopy(e: ClipboardEvent): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const startEl = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    const line = startEl?.closest(".cf-left, .cf-center, .cf-right");
    if (!line) return; // selection began outside a code column — leave default copy
    const side = line.classList.contains("cf-left")
      ? "cf-left"
      : line.classList.contains("cf-center")
        ? "cf-center"
        : "cf-right";
    const grid = line.closest(".merge3");
    if (!grid) return;
    const lines: string[] = [];
    for (const cell of grid.querySelectorAll<HTMLElement>(`.${side}`)) {
      if (!sel.containsNode(cell, true)) continue;
      const raw = cell.querySelector<HTMLElement>(".cf-tx")?.dataset.raw;
      if (raw === undefined) continue; // filler / alignment gap — no line in this column
      lines.push(raw);
    }
    // A single-line (or empty) selection copies fine natively — the line-number
    // span is user-select:none — so only take over for multi-line selections.
    if (lines.length < 2) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", lines.join("\n"));
  }

  // One grid row = 5 cells (Ours, left-gutter, Result, right-gutter, Theirs).
  // Returns all five, in DOM order; cells[0] (the left cell) is the scroll anchor.
  function appendRow(
    grid: HTMLElement,
    left: Cell | null,
    leftG: HTMLElement | null,
    center: Cell | null,
    rightG: HTMLElement | null,
    right: Cell | null,
    edit: { ci: number; li: number } | null,
  ): HTMLElement[] {
    const leftCell = lineCell(left, "cf-left", null);
    const leftGCell = leftG ?? el("div", { class: "merge-gutter" });
    const centerCell = lineCell(center, "cf-center", edit);
    const rightGCell = rightG ?? el("div", { class: "merge-gutter" });
    const rightCell = lineCell(right, "cf-right", null);
    grid.append(leftCell, leftGCell, centerCell, rightGCell, rightCell);
    return [leftCell, leftGCell, centerCell, rightGCell, rightCell];
  }

  function lineCell(c: Cell | null, side: string, edit: { ci: number; li: number } | null): HTMLElement {
    const cls = c ? (c.cls ? ` cf-${c.cls}` : "") + (c.ghost ? " cf-ghost" : "") : " cf-filler";
    const div = el("div", { class: `cf-line ${side}${cls}` });
    if (c?.title) div.title = c.title;
    div.append(el("span", { class: "cf-no", text: c && c.no != null ? String(c.no) : "" }));
    const tx = el("span", { class: "cf-tx" });
    if (c && c.text && (c.runs || c.segs)) appendCode(tx, c.text, c.segs ?? null, c.runs, "cf-word");
    else tx.textContent = c ? c.text || " " : " ";
    // The exact source text (blank lines render as " "), so a column copy
    // reproduces the file verbatim; absent on filler/gap rows (and on the base
    // shown in an undecided change) so copy skips them.
    if (c && !c.ghost) tx.dataset.raw = c.text;
    if (edit) {
      tx.setAttribute("contenteditable", "plaintext-only");
      tx.addEventListener("input", () => {
        const r = res[edit.ci];
        if (r) r[edit.li] = tx.textContent ?? "";
      });
    }
    div.append(tx);
    return div;
  }

  function leftGutter(idx: number, resolved: boolean): HTMLElement {
    const cls = `merge-gutter merge-gutter-left${resolved ? " merge-gutter-done" : ""}`;
    return el("div", { class: cls }, [
      iconBtn("≫", "Accept Ours into Result", () => acceptSide(idx, true), accepted[idx].has("ours")),
      iconBtn("×", resolved ? "Reset this change" : "Reset this conflict", () => resetConflict(idx)),
    ]);
  }
  function rightGutter(idx: number, resolved: boolean): HTMLElement {
    const cls = `merge-gutter merge-gutter-right${resolved ? " merge-gutter-done" : ""}`;
    return el("div", { class: cls }, [
      iconBtn("≪", "Accept Theirs into Result", () => acceptSide(idx, false), accepted[idx].has("theirs")),
      iconBtn("×", resolved ? "Reset this change" : "Reset this conflict", () => resetConflict(idx)),
    ]);
  }
  function iconBtn(glyph: string, title: string, onClick: () => void, disabled = false): HTMLElement {
    const b = el("button", { class: "merge-arrow", text: glyph, title });
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function acceptSide(idx: number, ours: boolean): void {
    const side: Side = ours ? "ours" : "theirs";
    res[idx] = acceptLines(res[idx], accepted[idx], side, changedChunks[idx][side]);
    curChange = idx;
    store();
    render();
  }
  function resetConflict(idx: number): void {
    res[idx] = null;
    accepted[idx] = new Set();
    why.delete(idx);
    curChange = idx;
    store();
    render();
  }
  function cancelFile(): void {
    res = changedChunks.map(() => null);
    accepted = changedChunks.map(() => new Set<Side>());
    why = new Map<number, string>();
    store();
    cb.setStatus(`Reverted resolutions for ${selected}.`);
    render();
  }

  // --- actions --------------------------------------------------------------

  async function saveFile(): Promise<void> {
    const path = selected;
    if (!path) return;
    await run(async () => {
      await cb.resolve(path, assembleResult());
      resStore.delete(path);
      cb.setStatus(`Resolved ${path}.`);
      selected = null;
      await reload();
    });
  }

  // Stage the file as it is on disk (e.g. after resolving it via "Edit File"),
  // provided no conflict markers remain.
  async function markFileResolved(): Promise<void> {
    const path = selected;
    if (!path) return;
    await run(async () => {
      const s = await cb.fetchSides(path);
      if (parseConflictRegions(s.working).length > 0) {
        cb.reportError(
          "File still has conflict markers",
          `${path} still contains conflict markers; resolve them first.`,
        );
        return;
      }
      await cb.resolve(path, s.working);
      resStore.delete(path);
      cb.setStatus(`Resolved ${path} (as on disk).`);
      selected = null;
      await reload();
    });
  }

  async function resolveWholeSide(ours: boolean): Promise<void> {
    const path = selected;
    if (!path) return;
    await run(async () => {
      // Taking a side replaces the working file, so look at it afresh: it
      // may have been edited (Edit File) since the conflict was loaded.
      const s = await cb.fetchSides(path);
      const choices = resStore.get(path)?.res.some((r) => r !== null) ?? false;
      const warning = takeSideWarning(path, ours, s.edited, choices);
      if (warning && !(await cb.confirm(warning))) {
        cb.setStatus(`Kept ${path} as it is.`);
        return;
      }
      await cb.resolveSide(path, ours);
      resStore.delete(path);
      cb.setStatus(`Resolved ${path} (took ${ours ? "ours" : "theirs"}).`);
      selected = null;
      await reload();
    });
  }

  async function markAllResolved(): Promise<void> {
    await run(async () => {
      let done = 0;
      let skipped = 0;
      for (const p of [...(status?.conflicted ?? [])]) {
        const s = await cb.fetchSides(p);
        // Only files already free of conflict markers on disk can be marked
        // resolved as-is; the rest need resolving in the editor.
        if (s.binary || parseConflictRegions(s.working).length > 0) {
          skipped++;
          continue;
        }
        await cb.resolve(p, s.working);
        resStore.delete(p);
        done++;
      }
      cb.reportDone(
        skipped > 0
          ? `Marked ${done} resolved; ${skipped} still have conflicts.`
          : `Marked ${done} file${done !== 1 ? "s" : ""} resolved.`,
      );
      await reload();
    });
  }

  async function finish(): Promise<void> {
    await run(async () => {
      const out = await cb.finish(message);
      resetSession(); // the session is over — next merge starts fresh
      cb.onDone(out, false);
    });
  }

  async function abort(): Promise<void> {
    const ok = await cb.confirm("Abort this operation? All conflict resolutions will be discarded.");
    if (!ok) {
      cb.setStatus("Abort cancelled.");
      return;
    }
    await run(async () => {
      const out = await cb.abort();
      resetSession();
      cb.onDone(out, true);
    });
  }

  // The editor's keys: n / p move between changes, [ / ] take ours /
  // theirs for the focused one, ⌘S saves. Single keys only while not typing.
  document.addEventListener("keydown", (e) => {
    if (!editorKeys || !host.isConnected || host.offsetParent === null) return;
    if (document.querySelector(".modal-overlay, .ql-overlay")) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      editorSave?.();
      return;
    }
    const t = e.target as HTMLElement;
    if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const act = editorKeys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  });

  return { reload, reset: resetSession };
}

// `lines` of `path` with syntax runs per line, or null when highlighting is
// off (Settings) or the file has no language.
function highlight(path: string, lines: string[]): Run[][] | null {
  const hl = loadSyntaxHighlight() ? highlighter(path) : null;
  return hl ? hl(lines) : null;
}

const SHOW_BASE_KEY = "gitp-conflict-show-base";

function loadShowBase(): boolean {
  try {
    return localStorage.getItem(SHOW_BASE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveShowBase(on: boolean): void {
  try {
    if (on) localStorage.setItem(SHOW_BASE_KEY, "1");
    else localStorage.removeItem(SHOW_BASE_KEY);
  } catch {
    // Not remembered; the toggle still works for this session.
  }
}
