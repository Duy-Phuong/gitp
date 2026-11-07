// The review inbox's backend call, kept out of api.ts: the `inbox` command
// streams one `inbox-repo` event per repository as each answers, and
// answers with them all at the end — an event may reach the webview after
// that answer, so whatever the events didn't bring, the answer does. Called
// straight through Tauri, not api.ts's counted invoke: a background refresh
// every minute shouldn't light the global progress bar.

import { isTauri } from "./api";
import type { InboxPr, InboxRepo } from "./inbox";

let nextId = 0;

/// Ask every repository of `paths` for its inbox; `onRepo` gets each answer
/// once, as it comes. Resolves when all have answered.
export async function loadInbox(paths: string[], onRepo: (repo: InboxRepo) => void): Promise<void> {
  if (!isTauri()) return mockInbox(paths, onRepo);
  const id = ++nextId;
  const seen = new Set<string>();
  const deliver = (repo: InboxRepo) => {
    if (seen.has(repo.path)) return;
    seen.add(repo.path);
    onRepo(repo);
  };
  const { listen } = await import("@tauri-apps/api/event");
  const { invoke } = await import("@tauri-apps/api/core");
  const unlisten = await listen<{ id: number; result: InboxRepo }>("inbox-repo", (e) => {
    if (e.payload.id === id) deliver(e.payload.result);
  });
  try {
    const all = await invoke<InboxRepo[]>("inbox", { paths, id });
    all.forEach(deliver);
  } finally {
    unlisten();
  }
}

// Preview mode: the first repository has pull requests, the second none
// readable, the rest none, each a little later than the one before.
async function mockInbox(paths: string[], onRepo: (repo: InboxRepo) => void): Promise<void> {
  const hours = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const pr = (path: string, over: Partial<InboxPr>): InboxPr => ({
    repo: "example/mideal",
    path,
    number: 1,
    title: "",
    author: "you",
    url: "https://github.com/example/mideal/pull/1",
    updated_at: hours(1),
    checks: "success",
    review_decision: null,
    merge_state: "BLOCKED",
    mine: true,
    review_requested: false,
    unresolved: 0,
    prepared: 0,
    ...over,
  });
  await Promise.all(
    paths.map(async (path, i) => {
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
      if (i === 1) return onRepo({ path, repo: null, prs: [], error: "no GitHub remote" });
      const prs =
        i > 0
          ? []
          : [
              pr(path, { number: 42, title: "Retry the identity check on timeouts", checks: "failure", unresolved: 3, prepared: 2 }),
              pr(path, { number: 57, title: "Bump the SDK", author: "anna", mine: false, review_requested: true, checks: "pending", updated_at: hours(5) }),
              pr(path, { number: 61, title: "Document the release flow", review_decision: "APPROVED", merge_state: "CLEAN", updated_at: hours(30) }),
              pr(path, { number: 63, title: "Cache the branch list", checks: null, updated_at: hours(72) }),
            ];
      onRepo({ path, repo: "example/mideal", prs, error: null });
    }),
  );
}
