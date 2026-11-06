import { expect, it } from "vitest";
import { pushAndReplyListing } from "./pr-push-reply";

const replies = [
  { where: "src/retry.ts:12", body: "Good catch — restored `>` so the documented three tries stay.\n\nMore." },
  { where: "src/sync.ts:77", body: "x".repeat(100) },
];
const commits = [
  { sha: "a1b2c3d", subject: "fix(review): src/retry.ts:12 — restore >" },
  { sha: "d4e5f6a", subject: "fix(review): src/upload.ts:40 — cap at 30 s" },
];

it("lists the commits and the replies, with the first line of each reply clipped", () => {
  const text = pushAndReplyListing({ branch: "feature/x", remote: "origin", number: 42, commits, replies });
  expect(text.split("\n")[0]).toBe("Push feature/x (2 commits ahead of origin) and post 2 replies on #42?");
  expect(text).toContain("a1b2c3d fix(review): src/retry.ts:12 — restore >");
  expect(text).toContain("src/retry.ts:12  Good catch — restored `>` so the documented three tries stay.");
  expect(text).not.toContain("More.");
  expect(text).toContain(`src/sync.ts:77  ${"x".repeat(79)}…`);
});

it("says only what there is to do", () => {
  expect(pushAndReplyListing({ branch: "b", remote: "origin", number: 1, commits: [], replies: replies.slice(0, 1) }).split("\n")[0]).toBe("Post 1 reply on #1?");
  expect(pushAndReplyListing({ branch: "b", remote: "origin", number: 1, commits: commits.slice(0, 1), replies: [] }).split("\n")[0]).toBe("Push b (1 commit ahead of origin)?");
});
