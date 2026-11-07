// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { setupPullRequestListView, type PullRequestListCallbacks } from "./pr-list";

function mount(over: Partial<PullRequestListCallbacks> = {}) {
  const host = document.createElement("section");
  const cb: PullRequestListCallbacks = {
    open: vi.fn(),
    openInTab: vi.fn(),
    menu: vi.fn(),
    setFilter: vi.fn(),
    search: vi.fn(),
    refresh: vi.fn(),
    signIn: vi.fn(),
    reviewBadge: () => null,
    ...over,
  };
  setupPullRequestListView(host, cb);
  return host;
}

describe("the pull request list's header", () => {
  it("opens the review inbox", () => {
    const inbox = vi.fn();
    mount({ inbox }).querySelector<HTMLButtonElement>(".prl-inbox")!.click();
    expect(inbox).toHaveBeenCalled();
  });

  it("has no inbox button without the callback", () => {
    expect(mount().querySelector(".prl-inbox")).toBeNull();
  });
});
