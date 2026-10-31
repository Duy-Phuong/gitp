// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { setupCodeView, type CodeApi, type CodeViewDeps } from "./index";
import type { EditorLike } from "./editor";
import type { CodeFile, CodeFilesChanged, FileEntry, IndexReady, Location } from "../../types";

const entry = (path: string): FileEntry => ({ path, size: 1, lang: path.endsWith(".ts") ? "typescript" : null, mtime_ms: 5 });

function fakeEditor(): EditorLike & { opened: string[]; revealed: Location[] } {
  let active: string | null = null;
  const texts = new Map<string, string>();
  return {
    opened: [],
    revealed: [],
    open(path, text) {
      active = path;
      if (!texts.has(path)) texts.set(path, text);
      this.opened.push(path);
    },
    active: () => active,
    text: (p) => texts.get(p) ?? null,
    replaceText: (p, t) => void texts.set(p, t),
    setReadOnly: () => {},
    reveal(loc) {
      this.revealed.push(loc);
    },
    caret: () => (active ? { path: active, line: 0, col: 0 } : null),
    focus: () => {},
    close(p) {
      texts.delete(p);
      if (active === p) active = null;
    },
  };
}

function host(): HTMLElement {
  const h = document.createElement("section");
  h.innerHTML = `
    <div id="code-explorer"></div><div id="code-explorer-divider"></div>
    <div class="code-main"><div id="code-tabs"></div><div id="code-banner" class="hidden"></div><div id="code-editor"></div>
    <div id="code-panel-divider" class="hidden"></div><div id="code-panel" class="hidden"></div></div>`;
  document.body.append(h);
  return h;
}

function fakeApi(files: FileEntry[], contents: Record<string, string>) {
  const listeners = { ready: [] as ((e: IndexReady) => void)[], changed: [] as ((e: CodeFilesChanged) => void)[] };
  const api: CodeApi = {
    codeOpenWorkspace: vi.fn(async () => ({ files, indexing: false })),
    codeRefresh: vi.fn(async () => files),
    codeReadFile: vi.fn(async (p: string): Promise<CodeFile | null> => (p in contents ? { text: contents[p], crlf: false, mixed: false, mtime_ms: 5 } : null)),
    codeWriteFile: vi.fn(async () => 6),
    codeDefinition: vi.fn(async () => []),
    codeReferences: vi.fn(async () => {
      throw new Error("no_symbol");
    }),
    codeCallers: vi.fn(async () => []),
    codeCallees: vi.fn(async () => []),
    codeSearch: vi.fn(async () => ({ hits: [], truncated: false, files_searched: 0 })),
    onCodeIndexReady: async (cb) => void listeners.ready.push(cb),
    onCodeFilesChanged: async (cb) => void listeners.changed.push(cb),
  };
  return { api, listeners };
}

function setup(files = [entry("src/a.ts"), entry("README.md")], contents: Record<string, string> = { "src/a.ts": "let a = 1;\n" }) {
  const { api, listeners } = fakeApi(files, contents);
  const editor = fakeEditor();
  const toast = vi.fn();
  const deps: CodeViewDeps = { api, toast, reportError: vi.fn(), makeEditor: () => editor, isShowing: () => true };
  const h = host();
  const view = setupCodeView(h, deps);
  return { view, api, listeners, editor, toast, h, deps };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("setupCodeView", () => {
  it("start opens the workspace once and renders the files", async () => {
    const { view, api, h } = setup();
    view.start();
    view.start();
    await flush();
    expect(api.codeOpenWorkspace).toHaveBeenCalledTimes(1);
    const rows = [...h.querySelectorAll<HTMLElement>(".code-row")].map((r) => r.dataset.path);
    expect(rows).toEqual(["src", "README.md"]);
  });

  it("opening a file shows it in a tab and reveals the location", async () => {
    const { view, editor, h } = setup();
    view.start();
    await flush();
    await view.openFile({ path: "src/a.ts", line: 0, col: 4 });
    expect(view.tabs.list().map((t) => t.path)).toEqual(["src/a.ts"]);
    expect(editor.opened).toEqual(["src/a.ts"]);
    expect(editor.revealed).toEqual([{ path: "src/a.ts", line: 0, col: 4 }]);
    expect(h.querySelector("#code-tabs")?.textContent).toContain("a.ts");
    expect(h.querySelector(".code-row.selected")?.getAttribute("data-path")).toBe("src/a.ts");
  });

  it("a file that cannot be read leaves the tabs untouched and toasts", async () => {
    const { view, toast } = setup();
    view.start();
    await flush();
    await view.openFile({ path: "src/a.ts", line: 0, col: 0 });
    await view.openFile({ path: "README.md", line: 0, col: 0 });
    expect(view.tabs.list().map((t) => t.path)).toEqual(["src/a.ts"]);
    expect(view.tabs.active()).toBe("src/a.ts");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("README.md"), "error");
  });

  it("files-changed patches the explorer without a new walk", async () => {
    const { view, api, listeners, h } = setup();
    view.start();
    await flush();
    listeners.changed[0]({ paths: ["new.ts", "README.md"], external: ["new.ts"], entries: [entry("new.ts")], removed: ["README.md"], rebuilt: false });
    const rows = [...h.querySelectorAll<HTMLElement>(".code-row")].map((r) => r.dataset.path);
    expect(rows).toEqual(["src", "new.ts"]);
    expect(api.codeRefresh).not.toHaveBeenCalled();
  });

  it("an edit saves after the auto-save delay with the tab's mtime, then keeps the new one", async () => {
    vi.useFakeTimers();
    try {
      const { view, api, editor } = setup();
      view.start();
      await vi.advanceTimersByTimeAsync(0);
      await view.openFile({ path: "src/a.ts", line: 0, col: 0 });
      editor.replaceText("src/a.ts", "let a = 2;\n");
      // The host's onEdit hook is driven through the editor deps:
      view.editorDeps.onEdit("src/a.ts");
      expect(view.tabs.get("src/a.ts")?.dirty).toBe(true);
      await vi.advanceTimersByTimeAsync(1500);
      expect(api.codeWriteFile).toHaveBeenCalledWith("src/a.ts", "let a = 2;\n", false, 5);
      expect(view.tabs.get("src/a.ts")).toMatchObject({ dirty: false, mtime: 6 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing a tab activates its neighbour in the editor", async () => {
    const { view, editor } = setup([entry("a.ts"), entry("b.ts")], { "a.ts": "a", "b.ts": "b" });
    view.start();
    await flush();
    await view.openFile({ path: "a.ts", line: 0, col: 0 });
    await view.openFile({ path: "b.ts", line: 0, col: 0 });
    await view.closeTab("b.ts");
    expect(view.tabs.active()).toBe("a.ts");
    expect(editor.active()).toBe("a.ts");
  });
});
