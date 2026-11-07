import { describe, expect, it } from "vitest";

import { prSuggestions, suggestionIn } from "./suggestions";
import type { PrReviewComment, PullRequestDetail } from "./types";

const comment = (id: number, body: string, over: Partial<PrReviewComment> = {}): PrReviewComment => ({
  id,
  author: "rev",
  body,
  path: "src/a.ts",
  line: 10,
  original_line: 10,
  start_line: null,
  side: "RIGHT",
  created_at: "",
  in_reply_to: null,
  url: "",
  diff_hunk: "",
  ...over,
});

describe("a suggestion in a comment", () => {
  it("is the first ```suggestion block, with \\n line ends", () => {
    expect(suggestionIn("Try:\n```suggestion\nconst a = 1;\n```\nok")).toBe("const a = 1;");
    expect(suggestionIn("```suggestion\r\nA\r\nB\r\n```")).toBe("A\nB");
    expect(suggestionIn("```suggestion\n```")).toBe("");
    expect(suggestionIn("```ts\nx\n```")).toBeNull();
  });
});

describe("a pull request's suggestions to apply", () => {
  const pr = (comments: PrReviewComment[], resolved: number[] = []) =>
    ({
      review_comments: comments,
      review_threads: comments.filter((c) => !c.in_reply_to).map((c) => ({ id: `T${c.id}`, resolved: resolved.includes(c.id), comment_ids: [c.id] })),
    }) as unknown as PullRequestDetail;

  it("are those on the new file's current lines, in open threads", () => {
    const list = prSuggestions(
      pr(
        [
          comment(1, "```suggestion\nX\n```", { start_line: 8 }),
          comment(2, "no block"),
          comment(3, "```suggestion\nY\n```", { line: null }),
          comment(4, "```suggestion\nZ\n```", { side: "LEFT" }),
          comment(5, "```suggestion\nW\n```"),
        ],
        [5],
      ),
    );
    expect(list).toEqual([{ comment_id: 1, author: "rev", path: "src/a.ts", start_line: 8, line: 10, text: "X" }]);
  });
});
