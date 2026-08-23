// The merge/rebase conflict resolver: a file list (Conflicted / Resolved) with a
// commit box on the left, and an IntelliJ-style 3-column merge editor on the
// right — Ours | Result | Theirs, line-aligned in one scroll container so the
// columns scroll together. Each conflict has gutter arrows (≫ accept ours into
// Result, ≪ accept theirs, × reset); the center Result is editable. Ours/Theirs
// colour lines new on a branch green and lines changed on both sides red. A file
// is saved (staged) once every conflict is resolved; when all files are resolved
// Commit and Merge (merge) / Continue Rebase (rebase) is enabled.

import { clear, el } from "../dom";
import type { ConflictSides, ConflictStatus } from "../types";

export interface ConflictCallbacks {
  fetchStatus: () => Promise<ConflictStatus>;
  fetchSides: (path: string) => Promise<ConflictSides>;
  resolve: (path: string, content: string) => Promise<void>;
  resolveSide: (path: string, ours: boolean) => Promise<void>;
  abort: () => Promise<string>;
  finish: (message: string) => Promise<string>;
  confirm: (message: string) => Promise<boolean>;
  setStatus: (msg: string) => void;
  reportError: (title: string, detail: string) => void;
  // Called after a successful finish/abort so the host can leave the view and
  // refresh history + sidebar.
  onDone: (message: string) => void;
}

export interface ConflictHandle {
  reload: () => Promise<void>;
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
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
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
  const resStore = new Map<string, (string[] | null)[]>();
  // Which changed chunk the ↑/↓ nav is focused on.
  let curChange = 0;
  let busy = false;

  async function reload(): Promise<void> {
    status = await cb.fetchStatus();
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
    else render();
  }

  function resolvedList(): string[] {
    const conflicted = new Set(status?.conflicted ?? []);
    return [...initial].filter((p) => !conflicted.has(p));
  }

  async function selectFile(path: string): Promise<void> {
    selected = path;
    sides = null;
    sidesLoading = true;
    render();
    const s = await cb.fetchSides(path);
    if (selected !== path) return; // selection moved on
    sides = s;
    sidesLoading = false;
    // Full 3-way diff of the branch revisions, so non-conflicting changes show
    // too — not only the conflict-marker regions.
    chunks = diff3(splitLines(s.base), splitLines(s.ours), splitLines(s.theirs));
    changedChunks = chunks.filter((c): c is Diff3Changed => c.kind === "changed");
    res = resStore.get(path) ?? changedChunks.map(() => null);
    resStore.set(path, res);
    curChange = 0;
    render();
  }

  function allResolved(): boolean {
    return res.every((r) => r !== null);
  }

  // Assemble the result: stable lines verbatim, each changed chunk replaced by
  // its chosen resolution (empty when reset — Save is gated on allResolved()).
  function assembleResult(): string {
    const out: string[] = [];
    let ci = 0;
    for (const c of chunks) {
      if (c.kind === "stable") out.push(...c.lines);
      else out.push(...(res[ci++] ?? []));
    }
    return out.join("\n");
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
    const rebase = status!.kind === "rebase";
    const box = el("div", { class: "conflict-side" });
    box.append(el("div", { class: "conflict-summary", text: status!.summary || "Resolving conflicts" }));

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
    for (const p of conflicted) cList.append(fileRow(p, false));
    if (!conflicted.length) cList.append(el("div", { class: "stage-empty", text: "All conflicts resolved" }));
    box.append(cList);

    const resolved = resolvedList();
    box.append(el("div", { class: "conflict-list-head" }, [el("span", { text: `Resolved Files (${resolved.length})` })]));
    const rList = el("div", { class: "conflict-list" });
    for (const p of resolved) rList.append(fileRow(p, true));
    box.append(rList);

    box.append(footer(rebase));
    return box;
  }

  function fileRow(path: string, resolved: boolean): HTMLElement {
    const row = el("div", {
      class: `conflict-file${selected === path ? " selected" : ""}${resolved ? " resolved" : ""}`,
      title: path,
    });
    row.append(el("span", { class: "conflict-file-icon", text: resolved ? "✓" : "⚠" }));
    row.append(el("span", { class: "tree-name", text: path }));
    row.addEventListener("click", () => void selectFile(path));
    return row;
  }

  function footer(rebase: boolean): HTMLElement {
    const box = el("div", { class: "conflict-footer" });
    if (!rebase) {
      const msg = el("textarea", { class: "commit-body", placeholder: "Commit Message", rows: 3 }) as HTMLTextAreaElement;
      msg.value = message;
      msg.addEventListener("input", () => (message = msg.value));
      box.append(msg);
    }
    const done = status!.conflicted.length === 0;
    const finishBtn = el("button", {
      class: "btn commit-btn",
      text: rebase ? "Continue Rebase" : "Commit and Merge",
    }) as HTMLButtonElement;
    // `run()` guards against re-entrancy, so no need to also disable on `busy`
    // (render happens inside run() while busy is still true).
    finishBtn.disabled = !done;
    finishBtn.addEventListener("click", () => void finish());

    const abortBtn = el("button", { class: "btn danger", text: "Abort" }) as HTMLButtonElement;
    abortBtn.addEventListener("click", () => void abort());

    box.append(el("div", { class: "conflict-footer-actions" }, [abortBtn, finishBtn]));
    return box;
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
    box.append(textEditor(sides));
    return box;
  }

  function binaryEditor(s: ConflictSides): HTMLElement {
    const box = el("div", { class: "conflict-editor" });
    box.append(el("div", { class: "conflict-editor-head", text: `${selected} — binary conflict` }));
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
    const conflicts = changedChunks.filter((c) => c.conflict).length;
    const unresolved = res.filter((r) => r === null).length;
    const touched = res.some((r) => r !== null);
    const anchors: HTMLElement[] = [];

    // Bulk actions.
    const acceptAll = (ours: boolean) => {
      res = res.map((r, i) => (r === null ? changedChunks[i][ours ? "ours" : "theirs"].slice() : r));
      resStore.set(selected!, res);
      render();
    };
    const applyNonConflicting = (mode: "ours" | "theirs" | "both") => {
      res = res.map((r, i) => {
        if (r !== null || changedChunks[i].conflict) return r;
        const c = changedChunks[i];
        return (mode === "ours" ? c.ours : mode === "theirs" ? c.theirs : (c.auto ?? [])).slice();
      });
      resStore.set(selected!, res);
      render();
    };
    const gotoChange = (delta: number) => {
      if (!anchors.length) return;
      curChange = (curChange + delta + anchors.length) % anchors.length;
      anchors[curChange]?.scrollIntoView({ block: "center" });
    };

    const tbBtn = (label: string, title: string, onClick: () => void, disabled = false) => {
      const b = el("button", { class: "btn ghost small icon-btn", text: label, title }) as HTMLButtonElement;
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const txtBtn = (label: string, onClick: () => void, disabled = false) => {
      const b = el("button", { class: "btn ghost small", text: label }) as HTMLButtonElement;
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const save = el("button", { class: "btn", text: "Save" }) as HTMLButtonElement;
    save.disabled = !allResolved();
    save.title = allResolved() ? "Stage this file as resolved" : "Resolve every change first";
    save.addEventListener("click", () => void saveFile());

    box.append(
      el("div", { class: "conflict-editor-head" }, [
        el("span", { class: "conflict-editor-file", text: selected! }),
        el("span", {
          class: `conflict-editor-count${unresolved ? "" : " conflict-clean"}`,
          text: `${total} change${total !== 1 ? "s" : ""}, ${conflicts} conflict${conflicts !== 1 ? "s" : ""}`,
        }),
        el("div", { class: "conflict-editor-actions" }, [
          tbBtn("↑", "Previous change", () => gotoChange(-1), !total),
          tbBtn("↓", "Next change", () => gotoChange(1), !total),
          el("span", { class: "conflict-tb-label", text: "Apply non-conflicting:" }),
          tbBtn("≫", "Take all non-conflicting from the left (ours)", () => applyNonConflicting("ours")),
          tbBtn("⇄", "Apply all non-conflicting changes", () => applyNonConflicting("both")),
          tbBtn("≪", "Take all non-conflicting from the right (theirs)", () => applyNonConflicting("theirs")),
          el("span", { class: "conflict-tb-sep" }),
          txtBtn("Accept All Ours", () => acceptAll(true)),
          txtBtn("Accept All Theirs", () => acceptAll(false)),
          txtBtn("Cancel", () => cancelFile(), !touched),
          save,
        ]),
      ]),
    );

    const grid = el("div", { class: "merge3" });
    grid.append(
      headCell("Ours (current)"),
      el("div", { class: "merge-head merge-gutter" }),
      headCell("Result"),
      el("div", { class: "merge-head merge-gutter" }),
      headCell("Theirs (incoming)"),
    );

    // Per-column running line numbers (each column numbers its own file).
    const no = { o: 1, c: 1, t: 1 };
    let ci = 0;
    for (const c of chunks) {
      if (c.kind === "stable") {
        for (const l of c.lines) {
          appendRow(
            grid,
            { text: l, cls: "", no: no.o++ },
            null,
            { text: l, cls: "", no: no.c++ },
            null,
            { text: l, cls: "", no: no.t++ },
            null,
          );
        }
        continue;
      }
      // Any change (conflict red / non-conflict green) is decided via arrows.
      const idx = ci++;
      const r = res[idx];
      const side: Cell["cls"] = c.conflict ? "conflict" : "new";
      const oursCh = !eqLines(c.ours, c.base);
      const theirsCh = !eqLines(c.theirs, c.base);
      const h = Math.max(c.ours.length, c.theirs.length, r?.length ?? 0, 1);
      for (let x = 0; x < h; x++) {
        const center: Cell | null =
          r === null
            ? { text: "", cls: side, no: null } // undecided gap, tinted by kind
            : x < r.length
              ? { text: r[x], cls: "", no: no.c++ }
              : null;
        const row = appendRow(
          grid,
          x < c.ours.length ? { text: c.ours[x], cls: oursCh ? side : "", no: no.o++ } : null,
          x === 0 ? leftGutter(idx) : null,
          center,
          x === 0 ? rightGutter(idx) : null,
          x < c.theirs.length ? { text: c.theirs[x], cls: theirsCh ? side : "", no: no.t++ } : null,
          r !== null && x < r.length ? { ci: idx, li: x } : null,
        );
        if (x === 0) anchors.push(row);
      }
    }
    box.append(grid);
    return box;
  }

  interface Cell {
    text: string;
    cls: "" | "new" | "conflict";
    no: number | null;
  }

  function headCell(text: string): HTMLElement {
    return el("div", { class: "merge-head" }, [el("span", { class: "cf-no" }), el("span", { text })]);
  }

  // One grid row = 5 cells (Ours, left-gutter, Result, right-gutter, Theirs).
  // Returns the left cell, used as the scroll anchor for change navigation.
  function appendRow(
    grid: HTMLElement,
    left: Cell | null,
    leftG: HTMLElement | null,
    center: Cell | null,
    rightG: HTMLElement | null,
    right: Cell | null,
    edit: { ci: number; li: number } | null,
  ): HTMLElement {
    const leftCell = lineCell(left, "cf-left", null);
    grid.append(leftCell);
    grid.append(leftG ?? el("div", { class: "merge-gutter" }));
    grid.append(lineCell(center, "cf-center", edit));
    grid.append(rightG ?? el("div", { class: "merge-gutter" }));
    grid.append(lineCell(right, "cf-right", null));
    return leftCell;
  }

  function lineCell(c: Cell | null, side: string, edit: { ci: number; li: number } | null): HTMLElement {
    const cls = c ? (c.cls ? ` cf-${c.cls}` : "") : " cf-filler";
    const div = el("div", { class: `cf-line ${side}${cls}` });
    div.append(el("span", { class: "cf-no", text: c && c.no != null ? String(c.no) : "" }));
    const tx = el("span", { class: "cf-tx" });
    tx.textContent = c ? c.text || " " : " ";
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

  function leftGutter(idx: number): HTMLElement {
    return el("div", { class: "merge-gutter merge-gutter-left" }, [
      iconBtn("≫", "Accept Ours into Result", () => acceptSide(idx, true)),
      iconBtn("×", "Reset this conflict", () => resetConflict(idx)),
    ]);
  }
  function rightGutter(idx: number): HTMLElement {
    return el("div", { class: "merge-gutter merge-gutter-right" }, [
      iconBtn("≪", "Accept Theirs into Result", () => acceptSide(idx, false)),
      iconBtn("×", "Reset this conflict", () => resetConflict(idx)),
    ]);
  }
  function iconBtn(glyph: string, title: string, onClick: () => void): HTMLElement {
    const b = el("button", { class: "merge-arrow", text: glyph, title });
    b.addEventListener("click", onClick);
    return b;
  }

  function acceptSide(idx: number, ours: boolean): void {
    const add = ours ? changedChunks[idx].ours : changedChunks[idx].theirs;
    res[idx] = [...(res[idx] ?? []), ...add];
    resStore.set(selected!, res);
    render();
  }
  function resetConflict(idx: number): void {
    res[idx] = null;
    resStore.set(selected!, res);
    render();
  }
  function cancelFile(): void {
    res = changedChunks.map(() => null);
    resStore.set(selected!, res);
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

  async function resolveWholeSide(ours: boolean): Promise<void> {
    const path = selected;
    if (!path) return;
    await run(async () => {
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
      cb.setStatus(
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
      cb.onDone(out);
    });
  }

  async function abort(): Promise<void> {
    const ok = await cb.confirm("Abort this merge/rebase? All conflict resolutions will be discarded.");
    if (!ok) {
      cb.setStatus("Abort cancelled.");
      return;
    }
    await run(async () => {
      const out = await cb.abort();
      cb.onDone(out);
    });
  }

  return { reload };
}
