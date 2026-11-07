import { describe, expect, it } from "vitest";

import {
  checksSummary,
  lineKey,
  baseBranches,
  githubRemoteName,
  mergeAdvice,
  defaultMergeMethod,
  filterPrList,
  hasPrListFilters,
  prAttentionTags,
  mergeChoices,
  NO_PR_LIST_FILTERS,
  prListChoices,
  sortPrList,
  lineTarget,
  prMatches,
  prTimeline,
  quoteReply,
  reviewThreads,
  searchFiles,
  threadsByLine,
  threadsPerFile,
  listingOf,
  otherListings,
} from "./pull-requests";
import type { FileDiff, PrReviewComment, PullRequest, PullRequestDetail } from "./types";

function lineComment(id: number, at: string, over: Partial<PrReviewComment> = {}): PrReviewComment {
  return {
    id,
    author: "hubot",
    body: `c${id}`,
    path: "src/a.ts",
    line: 3,
    original_line: 3,
    side: "RIGHT",
    created_at: at,
    in_reply_to: null,
    url: "",
    diff_hunk: "",
    ...over,
  };
}

function detail(over: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number: 1,
    title: "t",
    body: "",
    state: "OPEN",
    is_draft: false,
    author: "octocat",
    base: "main",
    head: "fix",
    head_oid: "abc",
    url: "",
    created_at: "2026-10-01T00:00:00Z",
    review_decision: null,
    labels: [],
    checks: [],
    reviews: [],
    comments: [],
    review_comments: [],
    review_threads: [],
    commits: [],
    additions: 0,
    deletions: 0,
    changed_files: 0,
    mergeable: "MERGEABLE",
    merge_state: "CLEAN",
    ...over,
  };
}

describe("reviewThreads", () => {
  it("hangs replies under their first comment, oldest first", () => {
    const threads = reviewThreads([
      lineComment(3, "2026-10-03T00:00:00Z", { in_reply_to: 1 }),
      lineComment(1, "2026-10-01T00:00:00Z"),
      lineComment(2, "2026-10-02T00:00:00Z", { in_reply_to: 1 }),
      lineComment(4, "2026-10-01T12:00:00Z"),
    ]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      [1, [2, 3]],
      [4, []],
    ]);
  });

  it("starts a thread for a reply whose first comment is gone", () => {
    const threads = reviewThreads([lineComment(9, "2026-10-01T00:00:00Z", { in_reply_to: 8 })]);
    expect(threads.map((t) => t.root.id)).toEqual([9]);
  });
});

describe("prTimeline", () => {
  it("orders comments, reviews and threads by when each began", () => {
    const items = prTimeline(
      detail({
        comments: [
          { id: "IC_2", author: "a", body: "later", created_at: "2026-10-05T00:00:00Z", url: "" },
          { id: "IC_1", author: "a", body: "first", created_at: "2026-10-01T00:00:00Z", url: "" },
        ],
        reviews: [{ author: "b", state: "APPROVED", body: "", submitted_at: "2026-10-04T00:00:00Z" }],
        review_comments: [
          lineComment(1, "2026-10-02T00:00:00Z"),
          // A reply after the review doesn't move its thread.
          lineComment(2, "2026-10-06T00:00:00Z", { in_reply_to: 1 }),
        ],
      }),
    );
    expect(items.map((i) => (i.kind === "comment" ? i.comment.id : i.kind === "review" ? "review" : `thread ${i.thread.root.id}`))).toEqual([
      "IC_1",
      "thread 1",
      "review",
      "IC_2",
    ]);
  });

  it("leaves out a review that only carries line comments", () => {
    const items = prTimeline(
      detail({
        reviews: [
          { author: "b", state: "COMMENTED", body: "", submitted_at: "2026-10-02T00:00:00Z" },
          { author: "b", state: "COMMENTED", body: "Overall fine", submitted_at: "2026-10-03T00:00:00Z" },
          { author: "b", state: "CHANGES_REQUESTED", body: "", submitted_at: "2026-10-04T00:00:00Z" },
        ],
      }),
    );
    expect(items.map((i) => (i.kind === "review" ? i.review.state : i.kind))).toEqual(["COMMENTED", "CHANGES_REQUESTED"]);
  });
});

describe("line comments on the diff", () => {
  it("targets the new file for added and unchanged lines, the old one for removed lines", () => {
    expect(lineTarget({ origin: "+", old_lineno: null, new_lineno: 7, content: "" })).toEqual({ line: 7, side: "RIGHT" });
    expect(lineTarget({ origin: " ", old_lineno: 5, new_lineno: 6, content: "" })).toEqual({ line: 6, side: "RIGHT" });
    expect(lineTarget({ origin: "-", old_lineno: 4, new_lineno: null, content: "" })).toEqual({ line: 4, side: "LEFT" });
  });

  it("places current threads on their line and leaves outdated ones out", () => {
    const threads = reviewThreads([
      lineComment(1, "2026-10-01T00:00:00Z", { path: "x.ts", line: 4, side: "LEFT" }),
      lineComment(2, "2026-10-02T00:00:00Z", { path: "x.ts", line: null }),
    ]);
    const at = threadsByLine(threads);
    expect([...at.keys()]).toEqual([lineKey("x.ts", "LEFT", 4)]);
    expect(at.get(lineKey("x.ts", "LEFT", 4))![0].root.id).toBe(1);
  });
});

describe("quoteReply", () => {
  it("quotes every line of the comment it answers", () => {
    expect(quoteReply("hubot", "Line one\n\nLine two\n")).toBe("@hubot wrote:\n> Line one\n>\n> Line two\n\n");
  });
});

describe("checksSummary", () => {
  it("counts failing first", () => {
    expect(
      checksSummary([
        { name: "a", state: "success", url: null },
        { name: "b", state: "failure", url: null },
        { name: "c", state: "success", url: null },
        { name: "d", state: "skipped", url: null },
      ]),
    ).toBe("1 failing, 2 passing, 1 skipped");
    expect(checksSummary([])).toBe("No checks");
  });
});

describe("prMatches", () => {
  const pr: PullRequest = {
    number: 42,
    title: "Retry the identity check",
    author: "octocat",
    is_draft: false,
    review_decision: null,
    checks: null,
    head: "feature/retry",
    base: "main",
    updated_at: "",
    url: "",
    labels: [],
    merged_at: null,
    approvals: 0,
    unresolved_threads: null,
  };
  const matcher = (q: string) => (text: string) => text.toLowerCase().includes(q);
  it("matches the number, title, author and branch", () => {
    expect(prMatches(pr, matcher("#42"))).toBe(true);
    expect(prMatches(pr, matcher("identity"))).toBe(true);
    expect(prMatches(pr, matcher("octo"))).toBe(true);
    expect(prMatches(pr, matcher("feature/"))).toBe(true);
    expect(prMatches(pr, matcher("nothing"))).toBe(false);
  });
});

describe("searchFiles", () => {
  const file = (path: string, lines: string[], old_path: string | null = null): FileDiff => ({
    path,
    old_path,
    status: "Modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: lines.map((content, i) => ({ origin: i % 2 ? "+" : " ", old_lineno: i + 1, new_lineno: i + 1, content: `${content}\n` })),
      },
    ],
  });
  const files = [
    file("src/retry.ts", ["const MAX_RETRIES = 3;", "retry(MAX_RETRIES)", "done"]),
    file("docs/README.md", ["# Retry", "nothing here"]),
    file("src/new.ts", ["x"], "src/old-name.ts"),
  ];

  it("keeps every file and marks nothing for a blank query", () => {
    expect(searchFiles(files, "  ")).toEqual([[], [], []]);
  });

  it("keeps the files whose name or code matches, ignoring case, with the lines that match", () => {
    // A name match keeps the file; its matching lines are still marked.
    expect(searchFiles(files, "max_retries")).toEqual([[[0, 0], [0, 1]], null, null]);
    expect(searchFiles(files, "readme")).toEqual([null, [], null]);
    expect(searchFiles(files, "retry")).toEqual([[[0, 1]], [[0, 0]], null]);
    expect(searchFiles(files, "old-name")).toEqual([null, null, []]);
    expect(searchFiles(files, "absent")).toEqual([null, null, null]);
  });
});

describe("threadsPerFile", () => {
  it("counts each file's current threads, not replies or outdated ones", () => {
    const comments = [
      lineComment(1, "2026-10-27T10:00:00Z"),
      lineComment(2, "2026-10-27T11:00:00Z", { in_reply_to: 1 }),
      lineComment(3, "2026-10-27T12:00:00Z", { line: 9 }),
      lineComment(4, "2026-10-27T13:00:00Z", { line: null }),
      lineComment(5, "2026-10-27T14:00:00Z", { path: "src/b.ts" }),
    ];
    expect(threadsPerFile(reviewThreads(comments))).toEqual(new Map([["src/a.ts", 2], ["src/b.ts", 1]]));
  });
});

describe("mergeAdvice", () => {
  it("lets a clean pull request merge without a word", () => {
    expect(mergeAdvice(detail())).toEqual({ blocked: null, warning: null });
  });

  it("stops what GitHub can't merge", () => {
    expect(mergeAdvice(detail({ state: "MERGED" })).blocked).toMatch(/already merged/);
    expect(mergeAdvice(detail({ state: "CLOSED" })).blocked).toMatch(/closed/);
    expect(mergeAdvice(detail({ is_draft: true, merge_state: "DRAFT" })).blocked).toMatch(/draft/);
    expect(mergeAdvice(detail({ mergeable: "CONFLICTING", merge_state: "DIRTY" })).blocked).toMatch(/conflicts with main/);
  });

  it("warns of what GitHub may refuse, and lets the user try", () => {
    for (const [state, words] of [
      ["BLOCKED", /required review or check/],
      ["BEHIND", /fix is behind main/],
      ["UNSTABLE", /checks are failing/],
      ["UNKNOWN", /still checking/],
    ] as const) {
      const advice = mergeAdvice(detail({ merge_state: state }));
      expect(advice.blocked, state).toBeNull();
      expect(advice.warning, state).toMatch(words);
    }
  });
});

describe("defaultMergeMethod", () => {
  const all = [{ value: "squash" as const }, { value: "merge" as const }, { value: "rebase" as const }];

  it("squashes a feature or fix, and keeps a merge commit for a release or a branch sync", () => {
    for (const head of ["feature/UBIID-9772-e2e", "bugfix/UBIID-1-x", "hotfix/UBIID-2-y", "chore/bump"]) {
      expect(defaultMergeMethod(head, all), head).toBe("squash");
    }
    for (const head of ["release/3.33.0", "develop", "develop/3.33", "master", "main"]) {
      expect(defaultMergeMethod(head, all), head).toBe("merge");
    }
    expect(defaultMergeMethod("developer-notes", all), "only develop itself").toBe("squash");
  });

  it("falls back to the first allowed method", () => {
    expect(defaultMergeMethod("release/3.33.0", [{ value: "squash" }])).toBe("squash");
    expect(defaultMergeMethod("feature/x", [{ value: "merge" }, { value: "rebase" }])).toBe("merge");
  });
});

describe("mergeChoices", () => {
  const settings = { default_branch: "main", merge_commit: true, squash: true, rebase: true, delete_branch_on_merge: false };
  it("offers what the repository allows, squash first", () => {
    expect(mergeChoices(settings).map((c) => c.value)).toEqual(["squash", "merge", "rebase"]);
    expect(mergeChoices({ ...settings, squash: false, rebase: false })).toEqual([{ value: "merge", label: "Create a merge commit" }]);
  });

  it("offers them all when GitHub didn't say", () => {
    expect(mergeChoices({ ...settings, merge_commit: false, squash: false, rebase: false })).toHaveLength(3);
  });
});

describe("githubRemoteName", () => {
  const remotes = [
    { name: "origin", url: "git@github.com:me/hello.git" },
    { name: "upstream", url: "https://github.com/Octo/hello/" },
    { name: "corp", url: "ssh://git@github.corp.example/team/app.git" },
    { name: "none", url: null },
  ];
  it("finds the remote of the repository the pull requests are in", () => {
    expect(githubRemoteName(remotes, "octo/hello")).toBe("upstream");
    expect(githubRemoteName(remotes, "me/hello")).toBe("origin");
    expect(githubRemoteName(remotes, "github.corp.example/team/app")).toBe("corp");
    expect(githubRemoteName(remotes, "other/repo")).toBeNull();
  });
});

describe("baseBranches", () => {
  it("lists the remote's branches, the default first", () => {
    expect(baseBranches(["origin/HEAD", "origin/develop", "upstream/main", "origin/master", "origin/release/1.2"], "origin", "master")).toEqual([
      "master",
      "develop",
      "release/1.2",
    ]);
  });

  it("keeps the default even when it isn't fetched", () => {
    expect(baseBranches([], "origin", "main")).toEqual(["main"]);
  });
});

describe("the Pull Requests view's filters and sort", () => {
  const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
    number,
    title: `pr ${number}`,
    author: "hubot",
    is_draft: false,
    review_decision: null,
    checks: null,
    head: `feature/${number}`,
    base: "develop",
    updated_at: "2026-11-01T00:00:00Z",
    url: "",
    labels: [],
    merged_at: null,
    approvals: 0,
    unresolved_threads: null,
    ...over,
  });
  const list = [
    pr(1, { author: "phuong", checks: "success", review_decision: "APPROVED", updated_at: "2026-11-03T00:00:00Z" }),
    pr(2, { is_draft: true, checks: "failure", base: "master", title: "Add a cache" }),
    pr(3, { author: "ada", review_decision: "REVIEW_REQUIRED", updated_at: "2026-11-02T00:00:00Z" }),
  ];
  const numbers = (prs: PullRequest[]) => prs.map((p) => p.number);

  it("keeps the pull requests every set filter lets through", () => {
    expect(numbers(filterPrList(list, NO_PR_LIST_FILTERS))).toEqual([1, 2, 3]);
    expect(numbers(filterPrList(list, { ...NO_PR_LIST_FILTERS, authors: ["hubot"] }))).toEqual([2]);
    expect(numbers(filterPrList(list, { ...NO_PR_LIST_FILTERS, authors: ["ada", "phuong"] }))).toEqual([1, 3]);
    expect(numbers(filterPrList(list, { ...NO_PR_LIST_FILTERS, checks: "none" }))).toEqual([3]);
    expect(numbers(filterPrList(list, { ...NO_PR_LIST_FILTERS, review: "none", draft: "ready" }))).toEqual([]);
    expect(numbers(filterPrList(list, { ...NO_PR_LIST_FILTERS, base: "develop", draft: "ready" }))).toEqual([1, 3]);
  });

  it("knows when a filter is set", () => {
    expect(hasPrListFilters(NO_PR_LIST_FILTERS)).toBe(false);
    expect(hasPrListFilters({ ...NO_PR_LIST_FILTERS, authors: ["ada"] })).toBe(true);
    expect(hasPrListFilters({ ...NO_PR_LIST_FILTERS, draft: "draft" })).toBe(true);
  });

  it("offers each author and base once, A to Z", () => {
    expect(prListChoices(list)).toEqual({ authors: ["ada", "hubot", "phuong"], bases: ["develop", "master"] });
  });

  it("sorts by a column, either way", () => {
    expect(numbers(sortPrList(list, "updated", true))).toEqual([1, 3, 2]);
    expect(numbers(sortPrList(list, "number", false))).toEqual([1, 2, 3]);
    expect(numbers(sortPrList(list, "title", false))).toEqual([2, 1, 3]);
    // The same author: the newest number first.
    expect(numbers(sortPrList(list, "author", false))).toEqual([3, 2, 1]);
    // A merged one dates by its merge, not its last update.
    const merged = [
      pr(7, { updated_at: "2026-11-06T00:00:00Z", merged_at: "2026-11-01T00:00:00Z" }),
      pr(8, { updated_at: "2026-11-02T00:00:00Z", merged_at: "2026-11-02T00:00:00Z" }),
    ];
    expect(numbers(sortPrList(merged, "updated", true))).toEqual([8, 7]);
  });
});

describe("the tags that make a pull request stand out in the lists", () => {
  const pr = (approvals: number, unresolved_threads: number | null) => ({ approvals, unresolved_threads });

  it("flags unresolved threads, and two approvals or more", () => {
    expect(prAttentionTags(pr(0, 0))).toEqual([]);
    expect(prAttentionTags(pr(1, null))).toEqual([]);
    expect(prAttentionTags(pr(2, 3)).map((t) => [t.kind, t.text, t.short])).toEqual([
      ["unresolved", "3 unresolved", "💬 3"],
      ["approvals", "✓ 2 approvals", "✓ 2"],
    ]);
  });
});

describe("Fix on a pull request's review drafts", () => {
  it("is offered only on a pull request the signed-in user wrote", async () => {
    const { canFixDrafts } = await import("./pull-requests");
    expect(canFixDrafts("phuong", "phuong")).toBe(true);
    expect(canFixDrafts("phuong", "anna")).toBe(false);
    expect(canFixDrafts(null, "anna")).toBe(false);
    expect(canFixDrafts("", "")).toBe(false);
    expect(canFixDrafts("Phuong", "phuong"), "GitHub logins ignore case").toBe(true);
  });
});

describe("the list a filter reads", () => {
  it("is its own, but Reviewed narrows All's", () => {
    expect(listingOf("mine")).toBe("mine");
    expect(listingOf("reviewed")).toBe("all");
  });

  it("the other listings are read ahead, each once", () => {
    expect(otherListings("reviewed")).toEqual(["mine", "review_requested", "merged"]);
    expect(otherListings("merged")).toEqual(["all", "mine", "review_requested"]);
  });
});
