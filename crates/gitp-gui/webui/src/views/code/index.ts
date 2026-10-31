// The Code tab: explorer on the left, editor tabs and the editor in the
// middle, a panel underneath for search, usages and the call hierarchy. This
// module owns the glue — which file is open, saving, what the backend's
// events do to the tree and the tabs — and leaves rendering to its parts.

import { clear, el } from "../../dom";
import type { CodeFile, CodeFilesChanged, CodeWorkspace, FileEntry, HierarchyNode, IndexReady, Location, SearchQuery, SearchResult, Symbol, UsagesResult } from "../../types";
import { loadCodeLayout, saveCodeLayout } from "../../prefs";
import { showDefinitionPicker } from "./definition-picker";
import { AutoSave, CodeEditor, type CodeEditorDeps, type EditorLike } from "./editor";
import { buildTree, renderExplorer, revealPath, type ExplorerState } from "./explorer";
import { NavStack } from "./nav-stack";
import { openQuickOpen } from "./quick-open";
import { setupSearchPanel } from "./search-panel";
import { setupCodeShortcuts, type CodeAction } from "./shortcuts";
import { Tabs } from "./tabs";

/// The backend calls the view makes, so tests can hand it fakes.
export interface CodeApi {
  codeOpenWorkspace: () => Promise<CodeWorkspace>;
  codeRefresh: () => Promise<FileEntry[]>;
  codeReadFile: (path: string) => Promise<CodeFile | null>;
  codeWriteFile: (path: string, text: string, crlf: boolean, expectedMtimeMs: number) => Promise<number>;
  codeDefinition: (path: string, line: number, col: number) => Promise<Symbol[]>;
  codeReferences: (path: string, line: number, col: number) => Promise<UsagesResult>;
  codeCallers: (path: string, line: number, col: number) => Promise<HierarchyNode[]>;
  codeCallees: (path: string, line: number, col: number) => Promise<HierarchyNode[]>;
  codeSearch: (query: SearchQuery, limit?: number) => Promise<SearchResult>;
  onCodeIndexReady: (cb: (ev: IndexReady) => void) => Promise<void>;
  onCodeFilesChanged: (cb: (ev: CodeFilesChanged) => void) => Promise<void>;
}

export interface CodeViewDeps {
  api: CodeApi;
  toast: (message: string, kind?: "info" | "success" | "error") => void;
  reportError: (title: string, err: unknown) => void;
  // Whether the Code tab is the one showing.
  isShowing: () => boolean;
  // Tests hand in a fake editor; the app builds CodeMirror.
  makeEditor?: (host: HTMLElement, deps: CodeEditorDeps) => EditorLike;
}

export interface CodeViewHandle {
  // The tab is showing: open the workspace the first time, refresh after.
  start: () => void;
  stop: () => void;
  // The repository changed: forget everything.
  reset: () => void;
  openFile: (loc: Location, opts?: { endCol?: number; reveal?: boolean }) => Promise<void>;
  closeTab: (path: string) => Promise<void>;
  saveActive: () => Promise<void>;
  gotoDefinition: (loc: Location) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  // A Code-tab key was pressed (see shortcuts.ts).
  runAction: (action: CodeAction) => void;
  readonly tabs: Tabs;
  readonly nav: NavStack;
  readonly editor: EditorLike;
  // The hooks the editor calls back into, exposed for tests.
  readonly editorDeps: CodeEditorDeps;
}

export function setupCodeView(host: HTMLElement, deps: CodeViewDeps): CodeViewHandle {
  const part = (id: string): HTMLElement => {
    const node = host.querySelector<HTMLElement>(`#${id}`);
    if (!node) throw new Error(`missing element: #${id}`);
    return node;
  };
  const explorerHost = part("code-explorer");
  const tabsHost = part("code-tabs");
  const editorHost = part("code-editor");
  const panelHost = part("code-panel");
  const panelDivider = part("code-panel-divider");

  // The bottom panel: one pane showing at a time, each with its own body.
  type Pane = "search" | "usages" | "hierarchy";
  const paneBar = el("div", { class: "code-pane-bar" });
  const paneBodies: Record<Pane, HTMLElement> = {
    search: el("div", { class: "code-pane" }),
    usages: el("div", { class: "code-pane" }),
    hierarchy: el("div", { class: "code-pane" }),
  };
  const paneButtons: Record<Pane, HTMLElement> = { search: el("button"), usages: el("button"), hierarchy: el("button") };
  const showPane = (which: Pane | null) => {
    panelHost.classList.toggle("hidden", !which);
    panelDivider.classList.toggle("hidden", !which);
    for (const [name, body] of Object.entries(paneBodies) as [Pane, HTMLElement][]) {
      body.classList.toggle("hidden", name !== which);
      paneButtons[name].classList.toggle("active", name === which);
    }
  };
  for (const [name, label] of [["search", "Search"], ["usages", "Usages"], ["hierarchy", "Call hierarchy"]] as [Pane, string][]) {
    const btn = el("button", { class: "code-pane-tab", type: "button" }, [label]);
    btn.addEventListener("click", () => showPane(name));
    paneButtons[name] = btn;
    paneBar.append(btn);
  }
  const closePanel = el("button", { class: "code-pane-close", type: "button", title: "Close panel" }, ["×"]);
  closePanel.addEventListener("click", () => showPane(null));
  paneBar.append(closePanel);
  clear(panelHost);
  panelHost.append(paneBar, paneBodies.search, paneBodies.usages, paneBodies.hierarchy);

  let files: FileEntry[] = [];
  let opened = false;
  let indexing = false;
  const explorer: ExplorerState = { expanded: new Set(), selected: null };
  const tabs = new Tabs();
  const nav = new NavStack();

  const editorDeps: CodeEditorDeps = {
    onEdit: (path) => autosave.edited(path),
    onSaveShortcut: (path) => void autosave.saveNow(path),
    gotoDefinition: (loc) => void gotoDefinition(loc),
    onCaretMoved: (loc) => nav.caretMoved(loc),
  };
  const editor: EditorLike = (deps.makeEditor ?? ((h, d) => new CodeEditor(h, d)))(editorHost, editorDeps);

  const autosave = new AutoSave({
    save: async (path) => {
      const text = editor.text(path);
      const tab = tabs.get(path);
      if (text === null || !tab || tab.deleted) return;
      const mtime = await deps.api.codeWriteFile(path, text, tab.crlf, tab.mtime);
      tabs.setMtime(path, mtime);
      tabs.setChangedOnDisk(path, false);
    },
    onDirty: (path, dirty) => tabs.setDirty(path, dirty),
    onError: (path, err) => {
      if (String(err).includes("changed_on_disk")) tabs.setChangedOnDisk(path, true);
      else deps.reportError(`Couldn't save ${path}`, err);
    },
  });

  const renderTree = () => {
    renderExplorer(explorerHost, buildTree(files), explorer, {
      open: (path) => void openFile({ path, line: 0, col: 0 }),
      toggle: (path) => {
        if (!explorer.expanded.delete(path)) explorer.expanded.add(path);
        renderTree();
      },
    });
  };

  const langOf = (path: string) => files.find((f) => f.path === path)?.lang ?? null;

  const openFile: CodeViewHandle["openFile"] = async (loc, opts = {}) => {
    const from = editor.caret();
    if (!tabs.get(loc.path)) {
      let file: CodeFile | null;
      try {
        file = await deps.api.codeReadFile(loc.path);
      } catch (err) {
        deps.toast(`Can't open ${loc.path}: ${String(err)}`, "error");
        return;
      }
      if (!file) {
        deps.toast(`Can't open ${loc.path}: not a text file, or too large.`, "error");
        return;
      }
      tabs.open(loc.path, { dirty: false, changedOnDisk: false, deleted: false, mtime: file.mtime_ms, crlf: file.crlf });
      editor.open(loc.path, file.text, langOf(loc.path));
    } else {
      tabs.open(loc.path, tabs.get(loc.path)!);
      editor.open(loc.path, "", langOf(loc.path));
    }
    nav.silently(() => editor.reveal(loc, opts.endCol));
    if (opts.reveal !== false) nav.push(from, loc);
    revealPath(explorer, loc.path);
    renderTree();
  };

  const showTab = (path: string | null) => {
    if (path) editor.open(path, "", langOf(path));
    if (path) explorer.selected = path;
    renderTree();
  };

  const closeTab: CodeViewHandle["closeTab"] = async (path) => {
    await autosave.saveNow(path);
    autosave.forget(path);
    editor.close(path);
    showTab(tabs.close(path));
  };

  /// The caret's place on screen, for the picker.
  const caretPoint = (): { x: number; y: number } => {
    const rect = editorHost.getBoundingClientRect();
    return { x: rect.left + 60, y: rect.top + 40 };
  };

  const gotoDefinition: CodeViewHandle["gotoDefinition"] = async (loc) => {
    if (autosave.isDirty(loc.path)) await autosave.saveNow(loc.path);
    let found: Symbol[];
    try {
      found = await deps.api.codeDefinition(loc.path, loc.line, loc.col);
    } catch (err) {
      if (String(err).includes("indexing")) deps.toast("Still indexing the project, try again in a moment", "info");
      else deps.reportError("Go to definition failed", err);
      return;
    }
    if (found.length === 0) {
      deps.toast("No definition found here", "info");
      return;
    }
    const pick = found.length === 1 ? found[0] : await showDefinitionPicker(caretPoint(), found);
    if (!pick) return;
    await openFile({ path: pick.path, line: pick.name_range.start_line, col: pick.name_range.start_col }, { endCol: pick.name_range.end_col });
  };

  const goTo = async (loc: Location | null) => {
    if (!loc) return;
    await openFile(loc, { reveal: false });
  };
  const goBack = () => goTo(nav.back());
  const goForward = () => goTo(nav.forward());

  const runAction = (action: CodeAction) => {
    switch (action) {
      case "goToDefinition": {
        const c = editor.caret();
        if (c) void gotoDefinition(c);
        break;
      }
      case "back":
        void goBack();
        break;
      case "forward":
        void goForward();
        break;
      case "closeTab": {
        const a = tabs.active();
        if (a) void closeTab(a);
        break;
      }
      case "findInFiles":
        showPane("search");
        searchPanel.focus();
        break;
      case "quickOpen":
        openQuickOpen(files, (path, reveal) => {
          void openFile({ path, line: 0, col: 0 }).then(() => {
            if (!reveal) editor.focus();
          });
        });
        break;
      default:
        deps.toast(`${action} is not available yet`, "info");
    }
  };
  setupCodeShortcuts(deps.isShowing, runAction);

  const searchPanel = setupSearchPanel(paneBodies.search, {
    search: (q) => deps.api.codeSearch(q),
    jump: (loc, endCol) => void openFile(loc, { endCol }),
  });

  const renderTabs = () => {
    clear(tabsHost);
    for (const t of tabs.list()) {
      const name = t.path.split("/").pop() ?? t.path;
      const btn = el("div", { class: `code-tab${t.path === tabs.active() ? " active" : ""}${t.deleted ? " deleted" : ""}`, title: t.path, role: "tab" }, [
        el("span", { class: `code-tab-dot${t.dirty ? " on" : ""}` }),
        el("span", { class: "code-tab-name" }, [name]),
        el("button", { class: "code-tab-close", title: "Close" }, ["×"]),
      ]);
      btn.addEventListener("click", () => {
        if (t.path !== tabs.active()) {
          tabs.open(t.path, t);
          showTab(t.path);
        }
      });
      btn.addEventListener("auxclick", (e) => {
        if (e.button === 1) void closeTab(t.path);
      });
      btn.querySelector(".code-tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTab(t.path);
      });
      tabsHost.append(btn);
    }
  };
  tabs.onChange(renderTabs);

  const applyChanged = (ev: CodeFilesChanged) => {
    if (ev.rebuilt) {
      void deps.api.codeRefresh().then((f) => {
        files = f;
        renderTree();
      });
      return;
    }
    const byPath = new Map(files.map((f) => [f.path, f]));
    for (const p of ev.removed) byPath.delete(p);
    for (const e of ev.entries) byPath.set(e.path, e);
    files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    renderTree();
  };

  let subscribed = false;
  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    void deps.api.onCodeIndexReady((ev) => {
      indexing = false;
      deps.toast(`Indexed ${ev.symbols} symbols in ${ev.files} files (${ev.ms} ms)`, "info");
    });
    void deps.api.onCodeFilesChanged(applyChanged);
  };

  const start = () => {
    subscribe();
    if (opened) {
      void deps.api.codeRefresh().then((f) => {
        files = f;
        renderTree();
      });
      return;
    }
    opened = true;
    void deps.api
      .codeOpenWorkspace()
      .then((ws) => {
        files = ws.files;
        indexing = ws.indexing;
        renderTree();
      })
      .catch((err) => {
        opened = false;
        deps.reportError("Couldn't open the workspace", err);
      });
  };

  const reset = () => {
    for (const t of tabs.list()) {
      autosave.forget(t.path);
      editor.close(t.path);
      tabs.close(t.path);
    }
    files = [];
    opened = false;
    explorer.expanded.clear();
    explorer.selected = null;
    renderTree();
  };

  setupSplitters(host);

  return {
    start,
    stop: () => {},
    reset,
    openFile,
    closeTab,
    saveActive: async () => {
      const a = tabs.active();
      if (a) await autosave.saveNow(a);
    },
    gotoDefinition,
    goBack,
    goForward,
    runAction,
    tabs,
    nav,
    editor,
    editorDeps,
    get indexing() {
      return indexing;
    },
  } as CodeViewHandle;
}

/// The explorer | editor and editor / panel splitters, sizes kept in prefs.
function setupSplitters(host: HTMLElement): void {
  const layout = loadCodeLayout();
  host.style.setProperty("--code-explorer-w", `${layout.explorerW}px`);
  host.style.setProperty("--code-panel-h", `${layout.panelH}px`);
  const drag = (divider: HTMLElement, axis: "x" | "y", apply: (px: number) => void) => {
    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      divider.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      const move = (ev: MouseEvent) => {
        const rect = host.getBoundingClientRect();
        apply(axis === "x" ? ev.clientX - rect.left : rect.bottom - ev.clientY);
      };
      const stop = () => {
        divider.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", stop);
        saveCodeLayout(layout);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop);
    });
  };
  const explorerDivider = host.querySelector<HTMLElement>("#code-explorer-divider");
  const panelDivider = host.querySelector<HTMLElement>("#code-panel-divider");
  if (explorerDivider) {
    drag(explorerDivider, "x", (px) => {
      layout.explorerW = Math.max(140, Math.min(600, px));
      host.style.setProperty("--code-explorer-w", `${layout.explorerW}px`);
    });
  }
  if (panelDivider) {
    drag(panelDivider, "y", (px) => {
      layout.panelH = Math.max(100, Math.min(600, px));
      host.style.setProperty("--code-panel-h", `${layout.panelH}px`);
    });
  }
}
