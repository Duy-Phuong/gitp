import { describe, expect, it } from "vitest";

import {
  checksSummary,
  lineKey,
  lineTarget,
  prMatches,
  prTimeline,
  quoteReply,
  reviewThreads,
  searchFiles,
  threadsByLine,
  threadsPerFile,
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
    additions: 0,
    deletions: 0,
    changed_files: 0,
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
