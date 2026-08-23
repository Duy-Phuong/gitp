// The merge/rebase conflict resolver: a file list (Conflicted / Resolved) with a
// commit box on the left, and a 3-pane editor on the right — read-only Ours and
// Theirs on top, an editable Output below with per-conflict Take Ours / Theirs /
// Both controls and conflict navigation. A file is resolvable once no conflict
// markers remain; saving it stages the resolution. When every file is resolved,
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
  // Per-file edited Output, so switching files keeps unsaved edits.
  const edited = new Map<string, string>();
  let region = 0; // current conflict index within the selected file
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
    region = 0;
    render();
    const s = await cb.fetchSides(path);
    if (selected !== path) return; // selection moved on
    sides = s;
    sidesLoading = false;
    if (!edited.has(path)) edited.set(path, s.working);
    render();
  }

  function output(): string {
    return (selected && edited.get(selected)) ?? "";
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
    const take = (label: string, ours: boolean) => {
      const b = el("button", { class: "btn small", text: label });
      b.addEventListener("click", () => void resolveWholeSide(ours));
      return b;
    };
    box.append(
      el("div", { class: "conflict-binary" }, [
        el("span", { text: "Binary file — pick a side:" }),
        take("Take Ours", true),
        take("Take Theirs", false),
      ]),
    );
    void s; // ours/theirs content isn't shown for binary
    return box;
  }

  function textEditor(s: ConflictSides): HTMLElement {
    const box = el("div", { class: "conflict-editor" });
    const regions = parseConflictRegions(output());
    const total = regions.length;
    box.append(
      el("div", { class: "conflict-editor-head" }, [
        el("span", { class: "conflict-editor-file", text: selected! }),
        el("span", { class: "conflict-editor-count", text: total ? `${total} conflict${total > 1 ? "s" : ""}` : "resolved" }),
      ]),
    );

    // Top: Ours | Theirs (read-only full versions).
    const top = el("div", { class: "conflict-top" });
    top.append(sidePane("Ours (current)", s.ours ?? "(deleted on our side)"));
    top.append(sidePane("Theirs (incoming)", s.theirs ?? "(deleted on their side)"));
    box.append(top);

    // Output toolbar: navigation + take controls + save.
    box.append(outputToolbar(regions));

    const ta = el("textarea", { class: "conflict-output", spellcheck: false }) as HTMLTextAreaElement;
    ta.value = output();
    ta.addEventListener("input", () => {
      if (selected) edited.set(selected, ta.value);
      // Re-render the toolbar (conflict count / save enabled) without stealing
      // focus: cheap enough to re-render the whole editor after a microtask.
      queueMicrotask(() => {
        if (document.activeElement === ta) refreshToolbarOnly();
        else render();
      });
    });
    box.append(ta);
    return box;
  }

  // Lightweight toolbar refresh that doesn't rebuild the textarea (keeps focus /
  // caret while typing).
  function refreshToolbarOnly(): void {
    const regions = parseConflictRegions(output());
    const bar = host.querySelector(".conflict-output-bar");
    if (bar) bar.replaceWith(outputToolbar(regions));
    const count = host.querySelector(".conflict-editor-count");
    if (count) count.textContent = regions.length ? `${regions.length} conflict${regions.length > 1 ? "s" : ""}` : "resolved";
  }

  function outputToolbar(regions: ConflictRegion[]): HTMLElement {
    const total = regions.length;
    if (region >= total) region = Math.max(0, total - 1);
    const bar = el("div", { class: "conflict-output-bar" });

    const nav = el("div", { class: "conflict-nav" });
    if (total > 0) {
      const prev = el("button", { class: "btn ghost small", text: "◀" });
      prev.addEventListener("click", () => {
        region = (region - 1 + total) % total;
        scrollToRegion(regions[region]);
      });
      const next = el("button", { class: "btn ghost small", text: "▶" });
      next.addEventListener("click", () => {
        region = (region + 1) % total;
        scrollToRegion(regions[region]);
      });
      nav.append(el("span", { text: `conflict ${region + 1} of ${total}` }), prev, next);
    } else {
      nav.append(el("span", { class: "conflict-clean", text: "No conflicts remaining" }));
    }
    bar.append(nav);

    if (total > 0) {
      const take = (label: string, choice: "ours" | "theirs" | "both") => {
        const b = el("button", { class: "btn small", text: label });
        b.addEventListener("click", () => applyTake(regions[region], choice));
        return b;
      };
      bar.append(
        el("div", { class: "conflict-take" }, [
          take("Take Ours", "ours"),
          take("Take Theirs", "theirs"),
          take("Take Both", "both"),
        ]),
      );
    }

    const save = el("button", { class: "btn", text: "Save" }) as HTMLButtonElement;
    save.disabled = total > 0;
    save.title = total > 0 ? "Resolve all conflicts in this file first" : "Stage this file as resolved";
    save.addEventListener("click", () => void saveFile());
    bar.append(save);
    return bar;
  }

  function sidePane(label: string, text: string): HTMLElement {
    return el("div", { class: "cf-pane" }, [
      el("div", { class: "cf-pane-head", text: label }),
      el("pre", { class: "cf-pane-body", text }),
    ]);
  }

  function scrollToRegion(r: ConflictRegion): void {
    const ta = host.querySelector<HTMLTextAreaElement>(".conflict-output");
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(r.start, r.end);
    // Approximate scroll: proportion of the region's offset into the text.
    const frac = r.start / Math.max(1, ta.value.length);
    ta.scrollTop = frac * ta.scrollHeight;
  }

  function applyTake(r: ConflictRegion, choice: "ours" | "theirs" | "both"): void {
    if (!selected) return;
    const text = output();
    const replacement = choice === "ours" ? r.ours : choice === "theirs" ? r.theirs : r.ours + r.theirs;
    edited.set(selected, text.slice(0, r.start) + replacement + text.slice(r.end));
    render();
  }

  // --- actions --------------------------------------------------------------

  async function saveFile(): Promise<void> {
    const path = selected;
    if (!path) return;
    await run(async () => {
      await cb.resolve(path, output());
      edited.delete(path);
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
      edited.delete(path);
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
        const content = edited.get(p) ?? s.working;
        if (s.binary || parseConflictRegions(content).length > 0) {
          skipped++;
          continue;
        }
        await cb.resolve(p, content);
        edited.delete(p);
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
