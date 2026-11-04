import { describe, expect, it } from "vitest";

import { checkAnchor, parseReviewFile, reviewedHeadIn, withOffDiffDrafts } from "./review-drafts";
import type { FileDiff } from "./types";

const REVIEW = `# Review of #42

## Summary

Some words, and a \`### fake\` inside prose.

## Suggested Changes & Comment Proposals

### \`src/identity/retry.ts:6\`

**Severity:** 🔴 blocking

**Explained simply:**

The third attempt is never made.

**Comment to paste:**

<!-- copy:start -->
The retry stops one attempt early: \`attempt === 3\` throws on the third try.

\`\`\`suggestion
      if (attempt === MAX_ATTEMPTS) throw err;
\`\`\`
<!-- copy:end -->

### src/identity/client.ts:11-12

**Severity:** 🟡 minor

**Comment to paste:**

Wrap the call so a timeout is retried too.

### docs/notes.md:3

Just a note block with no markers and no label — the whole text is the comment.

### src/skipped.ts:9

**Comment to paste:**

<!-- copy:start -->
<!-- copy:end -->

## Final Verdict
`;

describe("parseReviewFile", () => {
  it("reads each finding's location, severity and the comment between the copy markers", () => {
    const drafts = parseReviewFile(REVIEW);
    expect(drafts.map((d) => [d.path, d.line, d.severity])).toEqual([
      ["src/identity/retry.ts", 6, "blocking"],
      ["src/identity/client.ts", 12, "minor"],
      ["docs/notes.md", 3, null],
    ]);
    expect(drafts[0].body).toBe(
      "The retry stops one attempt early: `attempt === 3` throws on the third try.\n\n```suggestion\n      if (attempt === MAX_ATTEMPTS) throw err;\n```",
    );
    expect(drafts[1].body).toBe("Wrap the call so a timeout is retried too.");
    expect(drafts[2].body).toMatch(/^Just a note block/);
    expect(drafts.every((d) => d.side === "RIGHT")).toBe(true);
  });

  it("reads a JSON list, bare or under findings", () => {
    const list = `[{"path":"a.rs","line":3,"body":"x","severity":"nit"},{"path":"b.rs","line":"7","comment":"y","side":"LEFT"},{"path":"","line":1,"body":"z"}]`;
    expect(parseReviewFile(list)).toEqual([
      { path: "a.rs", line: 3, side: "RIGHT", body: "x", severity: "nit" },
      { path: "b.rs", line: 7, side: "LEFT", body: "y", severity: null },
    ]);
    expect(parseReviewFile(`{"findings": ${list}}`)).toHaveLength(2);
    expect(parseReviewFile("{not json")).toEqual([]);
  });

  it("reads the Markdown an HTML review page embeds", () => {
    const md = "# PR Review\n\n### `src/a.ts:6`\n\n**Severity:** 🟡 minor\n\n**Explained simply:**\n\nWhy.\n\n**Comment to paste:**\n\n<div class=\"copy-block\" data-i=\"0\">\n\nOff by one.\n\n</div>\n";
    const html = `<!doctype html>\n<html><head><script>const x = 1;</script></head><body><div id="root"></div>\n<script type="text/plain" id="markdown-source">${md}</script>\n</body></html>`;
    expect(parseReviewFile(html)).toEqual([{ path: "src/a.ts", line: 6, side: "RIGHT", body: "Off by one.", severity: "minor" }]);
    expect(parseReviewFile("<!doctype html><html><body>no review here</body></html>")).toEqual([]);
  });

  it("gives nothing for text without findings", () => {
    expect(parseReviewFile("# Nothing here\n\nAll good.")).toEqual([]);
  });
});

describe("checkAnchor", () => {
  const files: FileDiff[] = [
    {
      path: "src/a.ts",
      old_path: null,
      status: "Modified",
      hunks: [
        {
          header: "@@ -1,3 +1,4 @@",
          lines: [
            { origin: " ", old_lineno: 1, new_lineno: 1, content: "a" },
            { origin: "-", old_lineno: 2, new_lineno: null, content: "b" },
            { origin: "+", old_lineno: null, new_lineno: 2, content: "c" },
            { origin: "+", old_lineno: null, new_lineno: 3, content: "d" },
          ],
        },
      ],
    },
    { path: "big.ts", old_path: null, status: "Modified", hunks: [], truncated: true },
  ];
  const at = (path: string, line: number, side: "LEFT" | "RIGHT" = "RIGHT") => ({ path, line, side, body: "x", severity: null });

  it("accepts a line in the diff, on the side it names", () => {
    expect(checkAnchor(at("src/a.ts", 3), files)).toBe("ok");
    expect(checkAnchor(at("src/a.ts", 2, "LEFT"), files)).toBe("ok");
  });

  it("refuses a file not in the pull request, or a line outside its hunks", () => {
    expect(checkAnchor(at("src/other.ts", 1), files)).toBe("no-file");
    expect(checkAnchor(at("src/a.ts", 40), files)).toBe("no-line");
  });

  it("trusts a diff the backend cut short", () => {
    expect(checkAnchor(at("big.ts", 900), files)).toBe("ok");
  });
});

describe("withOffDiffDrafts", () => {
  const draft = (path: string, line: number, body: string, side: "LEFT" | "RIGHT" = "RIGHT") => ({ path, line, side, body, severity: null });
  const url = "https://github.com/octo/hello/pull/7";

  it("adds each off-diff draft after the message, linked to its line at the head commit", () => {
    expect(withOffDiffDrafts("Looks good.", [draft("ci/Jenkinsfile", 370, "Runs 10m. ")], url, "abc123")).toBe(
      "Looks good.\n\n---\n\n**[`ci/Jenkinsfile:370`](https://github.com/octo/hello/blob/abc123/ci/Jenkinsfile#L370)**\n\nRuns 10m.",
    );
  });

  it("leaves the message alone without them, and needs no message with them", () => {
    expect(withOffDiffDrafts("  Looks good. ", [], url, "abc")).toBe("Looks good.");
    expect(withOffDiffDrafts("", [draft("a.ts", 1, "x"), draft("b.ts", 2, "y", "LEFT")], url, "abc")).toBe(
      "**[`a.ts:1`](https://github.com/octo/hello/blob/abc/a.ts#L1)**\n\nx\n\n---\n\n" +
        "**[`b.ts:2 (removed line)`](https://github.com/octo/hello/blob/abc/b.ts)**\n\ny",
    );
  });
});

describe("reviewedHeadIn", () => {
  it("reads the head commit from the review's header line", () => {
    expect(reviewedHeadIn("**PR:** [x](y) · **Head:** `feature/UBIID-9772-delay` (`e0a21160a5`)")).toBe("e0a21160a5");
    expect(reviewedHeadIn("Head: `main` (`0123456789abcdef0123456789abcdef01234567`)")).toHaveLength(40);
    expect(reviewedHeadIn("### a.ts:1\nno header")).toBeNull();
  });
});
