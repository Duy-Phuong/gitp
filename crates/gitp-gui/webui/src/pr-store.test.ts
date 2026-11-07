// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { storePullRequest, storedPullRequest } from "./pr-store";
import type { PullRequestDetail } from "./types";

const pr = (number: number, body = ""): PullRequestDetail => ({ number, title: `PR ${number}`, body }) as PullRequestDetail;

beforeEach(() => localStorage.clear());

describe("pull requests kept across restarts", () => {
  it("gives back the last one stored, by repository and number", () => {
    storePullRequest("/a", pr(7));
    storePullRequest("/a", { ...pr(7), title: "newer" });
    expect(storedPullRequest("/a", 7)?.title).toBe("newer");
    expect(storedPullRequest("/b", 7)).toBeNull();
    expect(storedPullRequest("/a", 8)).toBeNull();
  });

  it("keeps the newest twenty", () => {
    for (let n = 1; n <= 21; n++) storePullRequest("/a", pr(n));
    expect(storedPullRequest("/a", 1)).toBeNull();
    expect(storedPullRequest("/a", 2)?.number).toBe(2);
    storePullRequest("/a", pr(2));
    storePullRequest("/a", pr(22));
    expect(storedPullRequest("/a", 2)?.number).toBe(2);
    expect(storedPullRequest("/a", 3)).toBeNull();
  });

  it("drops the oldest when the storage is full, and reads nothing from a broken one", () => {
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((k: string, v: string) => {
      if (v.length > 5_000_000) throw new DOMException("full", "QuotaExceededError");
      setItem(k, v);
    });
    storePullRequest("/a", pr(1, "x".repeat(2_000_000)));
    storePullRequest("/a", pr(2, "y".repeat(2_000_000)));
    storePullRequest("/a", pr(3, "z".repeat(2_000_000)));
    expect(storedPullRequest("/a", 3)?.number).toBe(3);
    expect(storedPullRequest("/a", 2)?.number).toBe(2);
    expect(storedPullRequest("/a", 1)).toBeNull();
    vi.restoreAllMocks();
    localStorage.setItem("gitp-pr-details", "{not json");
    expect(storedPullRequest("/a", 3)).toBeNull();
    storePullRequest("/a", pr(4));
    expect(storedPullRequest("/a", 4)?.number).toBe(4);
  });
});
