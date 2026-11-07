// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InboxPr, InboxRepo } from "../inbox";
import { setupInbox, type InboxCallbacks } from "./inbox";

function pr(over: Partial<InboxPr>): InboxPr {
  return {
    repo: "octo/hello",
    path: "/r/hello",
    number: 1,
    title: "A change",
    author: "me",
    url: "u",
    updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    checks: "success",
    review_decision: null,
    merge_state: "BLOCKED",
    mine: true,
    review_requested: false,
    unresolved: 0,
    prepared: 0,
    ...over,
  };
}

// A load whose answers the test hands over one repository at a time.
function controlledLoad() {
  const runs: { paths: string[]; onRepo: (r: InboxRepo) => void; finish: () => void }[] = [];
  const load = vi.fn(
    (paths: string[], onRepo: (r: InboxRepo) => void) =>
      new Promise<void>((resolve) => runs.push({ paths, onRepo, finish: resolve })),
  );
  return { load, runs };
}

function mount(over: Partial<InboxCallbacks> = {}) {
  const host = document.createElement("section");
  host.classList.add("hidden");
  document.body.append(host);
  const { load, runs } = controlledLoad();
  const cb: InboxCallbacks = { paths: () => ["/r/hello", "/r/lib", "/r/lab"], load, open: vi.fn(), close: vi.fn(), ...over };
  const handle = setupInbox(host, cb);
  return { host, cb, handle, load, runs };
}

const texts = (host: HTMLElement, sel: string) => [...host.querySelectorAll(sel)].map((n) => n.textContent);
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.replaceChildren();
});

describe("the review inbox", () => {
  it("rows appear per repo as each answers", async () => {
    const { host, handle, runs } = mount();
    handle.show();
    expect(host.classList.contains("hidden")).toBe(false);
    expect(runs[0].paths).toEqual(["/r/hello", "/r/lib", "/r/lab"]);
    expect(host.textContent).toContain("Reading 3 repositories");
    runs[0].onRepo({ path: "/r/lib", repo: "octo/lib", prs: [pr({ path: "/r/lib", repo: "octo/lib", number: 7, checks: "failure" })], error: null });
    expect(texts(host, ".inbox-row .inbox-number")).toEqual(["#7"]);
    runs[0].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [pr({ number: 3, mine: false, review_requested: true })], error: null });
    expect(texts(host, ".inbox-row .inbox-number")).toEqual(["#7", "#3"]);
  });

  it("groups needs-you first, then waiting on others", () => {
    const { host, handle, runs } = mount();
    handle.show();
    runs[0].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [pr({ number: 1 }), pr({ number: 2, unresolved: 2 })], error: null });
    expect(texts(host, ".inbox-group h3")).toEqual(["Needs you · 1", "Waiting on others · 1"]);
    expect(texts(host, ".inbox-group:first-of-type .inbox-number")).toEqual(["#2"]);
  });

  it("a row shows repo, number, title, author, check dot, threads, prepared and age", () => {
    const { host, handle, runs } = mount();
    handle.show();
    runs[0].onRepo({
      path: "/r/hello",
      repo: "octo/hello",
      prs: [pr({ number: 5, title: "Fix it", author: "anna", mine: false, review_requested: true, checks: "pending", unresolved: 3, prepared: 2 })],
      error: null,
    });
    const row = host.querySelector(".inbox-row")!;
    expect(row.querySelector(".inbox-repo")?.textContent).toBe("octo/hello");
    expect(row.querySelector(".inbox-number")?.textContent).toBe("#5");
    expect(row.querySelector(".inbox-title")?.textContent).toBe("Fix it");
    expect(row.querySelector(".inbox-author")?.textContent).toBe("anna");
    expect(row.querySelector(".pr-check-dot")?.className).toBe("pr-check-dot pending");
    expect(row.querySelector(".inbox-threads")?.textContent).toBe("3 unresolved · 2 prepared");
    expect(texts(row as HTMLElement, ".inbox-reason")).toEqual(["review requested"]);
    expect(row.querySelector(".inbox-age")?.textContent).toBe("2h ago");
  });

  it("lists unreadable repos at the bottom with the reason", () => {
    const { host, handle, runs } = mount();
    handle.show();
    runs[0].onRepo({ path: "/r/lab", repo: null, prs: [], error: "no GitHub remote" });
    runs[0].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [pr({ unresolved: 1 })], error: null });
    const sections = [...host.querySelectorAll(".inbox-body > *")].map((n) => n.className);
    expect(sections[sections.length - 1]).toContain("inbox-failed");
    expect(texts(host, ".inbox-failed .inbox-failed-name")).toEqual(["lab"]);
    expect(texts(host, ".inbox-failed .inbox-failed-reason")).toEqual(["no GitHub remote"]);
  });

  it("says when nothing needs you once every repo answered", async () => {
    const { host, handle, runs } = mount();
    handle.show();
    runs[0].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [], error: null });
    runs[0].finish();
    await flush();
    expect(host.querySelector(".inbox-empty")?.textContent).toBe("Nothing open needs you or waits on others.");
  });

  it("a click opens that repo on that pull request", () => {
    const { host, cb, handle, runs } = mount();
    handle.show();
    runs[0].onRepo({ path: "/r/lib", repo: "octo/lib", prs: [pr({ path: "/r/lib", number: 9, unresolved: 1 })], error: null });
    host.querySelector<HTMLElement>(".inbox-row")!.click();
    expect(cb.open).toHaveBeenCalledWith("/r/lib", 9);
  });

  it("an older refresh does not overwrite a newer", () => {
    const { host, handle, runs } = mount();
    handle.show();
    host.querySelector<HTMLButtonElement>(".inbox-refresh")!.click();
    runs[1].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [pr({ number: 2, unresolved: 1 })], error: null });
    runs[0].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [pr({ number: 1, unresolved: 1 })], error: null });
    expect(texts(host, ".inbox-number")).toEqual(["#2"]);
  });

  it("keeps a repo's rows until its new answer, and drops a repo that no longer answers", async () => {
    const { host, handle, runs, cb } = mount();
    handle.show();
    const newer = "2026-11-07T10:00:00Z";
    runs[0].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [pr({ number: 1, unresolved: 1, updated_at: newer })], error: null });
    runs[0].onRepo({ path: "/r/lib", repo: "octo/lib", prs: [pr({ path: "/r/lib", number: 2, unresolved: 1, updated_at: "2026-11-07T09:00:00Z" })], error: null });
    runs[0].finish();
    await flush();
    cb.paths = () => ["/r/hello"];
    host.querySelector<HTMLButtonElement>(".inbox-refresh")!.click();
    expect(texts(host, ".inbox-number")).toEqual(["#1", "#2"]);
    runs[1].onRepo({ path: "/r/hello", repo: "octo/hello", prs: [pr({ number: 1, unresolved: 1, updated_at: newer })], error: null });
    runs[1].finish();
    await flush();
    expect(texts(host, ".inbox-number")).toEqual(["#1"]);
  });

  it("closes with its Back button and with Esc", () => {
    const { host, cb, handle } = mount();
    handle.show();
    host.querySelector<HTMLButtonElement>(".inbox-close")!.click();
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cb.close).toHaveBeenCalledTimes(2);
  });
});

describe("the inbox's polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.dispatchEvent(new Event("focus"));
  });
  afterEach(() => vi.useRealTimers());

  it("reads again every 60 seconds while showing, and stops once hidden", async () => {
    const { handle, load, runs, host } = mount();
    handle.show();
    expect(handle.isShowing()).toBe(true);
    runs[0].finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);
    runs[1].finish();
    handle.hide();
    expect(host.classList.contains("hidden")).toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("stops polling when something else hid it", async () => {
    const { handle, load, runs, host } = mount();
    handle.show();
    runs[0].finish();
    host.classList.add("hidden");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(handle.isShowing()).toBe(false);
  });
});
