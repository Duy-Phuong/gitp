import { describe, expect, it } from "vitest";

import { isRateLimit, listChanged, refreshNotice, signatureChanged } from "./pr-refresh";
import type { PrSignature, PullRequest, PullRequestDetail } from "./types";

const sig = (over: Partial<PrSignature> = {}): PrSignature => ({
  head: "a1",
  updated_at: "2026-11-07T10:00:00Z",
  threads: [["T1", false]],
  checks: [["build", "pending"]],
  ...over,
});

const detail = (over: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 7,
  title: "t",
  body: "",
  state: "OPEN",
  is_draft: false,
  author: "octo",
  base: "main",
  head: "feature",
  head_oid: "a1",
  url: "",
  created_at: "",
  review_decision: null,
  labels: [],
  checks: [{ name: "build", state: "pending", url: null }],
  reviews: [],
  comments: [],
  review_comments: [],
  review_threads: [{ id: "T1", resolved: false, comment_ids: [1] }],
  commits: [{ oid: "a1", headline: "one", body: "", authors: [], committed_at: "" }],
  additions: 1,
  deletions: 0,
  changed_files: 1,
  mergeable: "MERGEABLE",
  merge_state: "CLEAN",
  ...over,
});

describe("signatureChanged", () => {
  it("same signature is no change", () => {
    expect(signatureChanged(sig(), sig())).toBe(false);
  });

  it("no baseline yet is no change", () => {
    expect(signatureChanged(null, sig())).toBe(false);
  });

  it.each([
    ["head", { head: "b2" }],
    ["updatedAt", { updated_at: "2026-11-07T10:01:00Z" }],
    ["a thread resolved", { threads: [["T1", true]] as [string, boolean][] }],
    ["a new thread", { threads: [["T1", false], ["T2", false]] as [string, boolean][] }],
    ["a check finished", { checks: [["build", "success"]] as [string, string][] }],
  ])("%s is a change", (_, over) => {
    expect(signatureChanged(sig(), sig(over))).toBe(true);
  });
});

describe("refreshNotice", () => {
  it("counts new commits, comments, resolved threads and finished checks", () => {
    const now = detail({
      head_oid: "b2",
      commits: [
        { oid: "a1", headline: "one", body: "", authors: [], committed_at: "" },
        { oid: "b2", headline: "two", body: "", authors: [], committed_at: "" },
      ],
      comments: [{ id: "IC1", author: "a", body: "hi", created_at: "", url: "" }],
      review_comments: [
        { id: 1, author: "a", body: "x", path: "f", line: 1, original_line: 1, side: "RIGHT", created_at: "", in_reply_to: null, url: "", diff_hunk: "" },
      ],
      reviews: [
        { author: "b", state: "COMMENTED", body: "Looks fine", submitted_at: "2026-11-07T10:01:00Z" },
        { author: "c", state: "APPROVED", body: "", submitted_at: "2026-11-07T10:02:00Z" },
      ],
      review_threads: [{ id: "T1", resolved: true, comment_ids: [1] }],
      checks: [{ name: "build", state: "success", url: null }],
    });
    const old = detail({ review_comments: now.review_comments });
    expect(refreshNotice(old, now)).toBe("Updated: 1 new commit · 2 new comments · 1 thread resolved · checks finished");
  });

  it("uses plurals", () => {
    const commit = (oid: string) => ({ oid, headline: oid, body: "", authors: [], committed_at: "" });
    const old = detail({ commits: [], review_threads: [{ id: "T1", resolved: false, comment_ids: [] }, { id: "T2", resolved: false, comment_ids: [] }] });
    const now = detail({
      commits: [commit("x"), commit("y")],
      comments: [{ id: "IC1", author: "a", body: "", created_at: "", url: "" }],
      review_threads: [{ id: "T1", resolved: true, comment_ids: [] }, { id: "T2", resolved: true, comment_ids: [] }],
    });
    expect(refreshNotice(old, now)).toBe("Updated: 2 new commits · 1 new comment · 2 threads resolved");
  });

  it("checks still running are not finished", () => {
    const old = detail({ checks: [{ name: "a", state: "pending", url: null }, { name: "b", state: "pending", url: null }] });
    const now = detail({ checks: [{ name: "a", state: "success", url: null }, { name: "b", state: "pending", url: null }] });
    expect(refreshNotice(old, now)).toBe("Updated");
  });

  it("only updatedAt moved says Updated", () => {
    expect(refreshNotice(detail(), detail({ title: "renamed" }))).toBe("Updated");
  });
});

describe("isRateLimit", () => {
  it("matches the core's message and gh's own", () => {
    expect(isRateLimit("GitHub's API rate limit was reached. Wait a few minutes, then try again.")).toBe(true);
    expect(isRateLimit(new Error("GraphQL: API rate limit exceeded for user ID 1."))).toBe(true);
    expect(isRateLimit("HTTP 502")).toBe(false);
  });
});

describe("listChanged", () => {
  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    number: 1,
    title: "t",
    author: "a",
    is_draft: false,
    review_decision: null,
    checks: null,
    head: "h",
    base: "main",
    updated_at: "x",
    url: "",
    labels: [],
    merged_at: null,
    approvals: 0,
    unresolved_threads: null,
    conflicting: false,
    ...over,
  });

  it("is false for the same rows and true for any difference", () => {
    expect(listChanged([pr()], [pr()])).toBe(false);
    expect(listChanged(null, [pr()])).toBe(true);
    expect(listChanged([pr()], [pr({ updated_at: "y" })])).toBe(true);
    expect(listChanged([pr()], [pr(), pr({ number: 2 })])).toBe(true);
  });
});
