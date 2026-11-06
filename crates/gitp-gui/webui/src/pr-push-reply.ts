// What Push and reply all is about to do, as the confirm says it: the commits
// a push sends and the replies to post, one line each. Pure, so it is tested
// apart from the dialog.

import type { AheadCommit } from "./types";

export interface ReplyToPost {
  // "path:line" of the thread.
  where: string;
  body: string;
}

const FIRST_LINE_MAX = 80;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : (word.endsWith("y") ? "" : "s")}`;

export function pushAndReplyListing(o: { branch: string; remote: string; number: number; commits: AheadCommit[]; replies: ReplyToPost[] }): string {
  const push = o.commits.length ? `Push ${o.branch} (${plural(o.commits.length, "commit")} ahead of ${o.remote})` : "";
  const post = o.replies.length ? `post ${o.replies.length} ${o.replies.length === 1 ? "reply" : "replies"} on #${o.number}` : "";
  const head = push && post ? `${push} and ${post}?` : push ? `${push}?` : `${post.replace(/^post/, "Post")}?`;
  const lines = [head];
  if (o.commits.length) {
    lines.push("");
    for (const c of o.commits) lines.push(`${c.sha} ${c.subject}`);
  }
  if (o.replies.length) {
    lines.push("");
    for (const r of o.replies) {
      const first = r.body.trim().split("\n")[0];
      lines.push(`${r.where}  ${first.length > FIRST_LINE_MAX ? `${first.slice(0, FIRST_LINE_MAX - 1)}…` : first}`);
    }
  }
  return lines.join("\n");
}
