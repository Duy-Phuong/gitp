// The Code tab: explorer on the left, editor tabs and the editor in the
// middle, a panel underneath for search, usages and the call hierarchy. This
// module owns the glue — which file is open, saving, what the backend's
// events do to the tree and the tabs — and leaves rendering to its parts.

import { clear, el } from "../../dom";
import type { CodeFile, CodeFilesChanged, CodeWorkspace, FileEntry, HierarchyNode, IndexReady, Location, SearchQuery, SearchResult, Symbol, UsagesResult } from "../../types";
import { loadCodeLayout, saveCodeLayout } from "../../prefs";
import { AutoSave, CodeEditor, type CodeEditorDeps, type EditorLike } from "./editor";
import { buildTree, renderExplorer, revealPath, type ExplorerState } from "./explorer";
import { NavStack } from "./nav-stack";
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

  let files: FileEntry[] = [];
  let opened = false;
  let indexing = false;
  const explorer: ExplorerState = { expanded: new Set(), selected: null };
  const tabs = new Tabs();
  const nav = new NavStack();

  const editorDeps: CodeEditorDeps = {
    onEdit: (path) => autosave.edited(path),
    onSaveShortcut: (path) => void autosave.saveNow(path),
    gotoDefinition: () => {}, // wired by the navigation module
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
