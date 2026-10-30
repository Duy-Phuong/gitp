import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fetch that runs until the test lets it finish.
const pending: (() => void)[] = [];
const workspaceFetch = vi.fn(() => new Promise<string>((resolve) => pending.push(() => resolve(""))));

vi.mock("../api", () => ({
  browseForFolder: async () => null,
  cancelWorkspaceOps: async () => {},
  confirmDialog: async () => true,
  isCancelled: () => false,
  isTauri: () => false,
  onWorkspaceProgress: async () => () => {},
  revealFolder: async () => {},
  workspaceFetch,
  workspacePull: async () => "",
  workspaceRepoSummary: async () => ({ missing: false, branch: "main", ahead: 0, behind: 0, has_upstream: true, changes: 0 }),
  workspaceScanFolder: async () => [],
}));
vi.mock("./form-dialog", () => ({ openFormDialog: () => {} }));
vi.mock("./message-dialog", () => ({ showErrorDialog: () => {} }));

const { closeWorkspacesDialog, openWorkspacesDialog } = await import("./workspaces");
type WorkspacesActions = Parameters<typeof openWorkspacesDialog>[0];

// Just enough DOM for the dialog to render, be clicked through, and close.
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  textContent = "";
  className = "";
  checked = false;
  disabled = false;
  indeterminate = false;
  style: Record<string, string> = {};
  classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  private listeners = new Map<string, () => void>();
  constructor(readonly tag = "") {}
  get isConnected(): boolean {
    return this.parent !== null;
  }
  setAttribute(): void {}
  append(...nodes: FakeNode[]): void {
    for (const n of nodes) n.parent = this;
    this.children.push(...nodes);
  }
  replaceChildren(): void {
    this.children = [];
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, fn);
  }
  fire(type: string): void {
    this.listeners.get(type)?.();
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

let body: FakeNode;
const button = (text: string) => body.all().find((n) => n.tag === "button" && n.textContent === text)!;
const checkboxes = () => body.all().filter((n) => n.tag === "input");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const actions: WorkspacesActions = {
  activeRepo: () => "",
  openRepos: async () => {},
  refreshActive: async () => {},
  pullMode: () => "FastForward",
  setStatus: () => {},
};

beforeEach(() => {
  body = new FakeNode("body");
  const store = new Map([["gitp-workspaces", JSON.stringify([{ name: "Work", repos: ["/r/one"] }])]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  vi.stubGlobal("document", {
    body,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode(), { textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
  });
});

afterEach(() => {
  closeWorkspacesDialog();
  for (const finish of pending.splice(0)) finish();
  vi.unstubAllGlobals();
});

describe("the Workspaces dialog", () => {
  it("shows a fetch still running after being closed and reopened, and won't start another", async () => {
    openWorkspacesDialog(actions);
    await settle();
    const [, repo] = checkboxes(); // "select all", then the repo's row
    repo.checked = true;
    repo.fire("change");
    button("Fetch").fire("click");
    await settle();
    expect(workspaceFetch).toHaveBeenCalledTimes(1);

    closeWorkspacesDialog();
    openWorkspacesDialog(actions);
    await settle();
    const [, again] = checkboxes();
    again.checked = true;
    again.fire("change");

    expect(button("Cancel").style.display).toBe("");
    expect(button("Fetch").disabled).toBe(true);
    button("Fetch").fire("click");
    await settle();
    expect(workspaceFetch).toHaveBeenCalledTimes(1);
  });
});
