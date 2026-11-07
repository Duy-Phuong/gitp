// The review inbox: across every repository in Open Recent and the starred
// ones, the pull requests that need the user — reviews asked of them, and
// their own with unresolved threads, failed checks, or approved and ready to
// merge — then their others, waiting on someone else. Laid over the main
// panel like the welcome screen, so it works with no repository open. Rows
// come in per repository as each answers; a refresh keeps a repository's
// rows until its new answer. Reads again every minute while showing.

import { clear, el } from "../dom";
import { groupInbox, inboxReasons, type InboxPr, type InboxRepo } from "../inbox";
import { startPolling } from "../poller";
import { isoSeconds } from "../pull-requests";
import { relativeTime } from "../timeago";

export interface InboxCallbacks {
  // The repositories to ask, in order (Open Recent, then starred).
  paths: () => string[];
  load: (paths: string[], onRepo: (repo: InboxRepo) => void) => Promise<void>;
  // Open repository `path` (switching to it if needed) on pull request `number`.
  open: (path: string, number: number) => void;
  close: () => void;
}

export interface InboxHandle {
  show: () => void;
  hide: () => void;
  isShowing: () => boolean;
}

const POLL_MS = 60_000;
const POLL_KEY = "review-inbox";

export function setupInbox(host: HTMLElement, cb: InboxCallbacks): InboxHandle {
  // Each repository's latest answer, by path.
  const results = new Map<string, InboxRepo>();
  let run = 0;
  let asked = 0;
  let reading = false;
  // The repositories the latest run asked, in order.
  let paths: string[] = [];
  let stopPolling: (() => void) | null = null;

  const status = el("span", { class: "inbox-status", "aria-live": "polite" });
  const refreshButton = el("button", { class: "btn small ghost inbox-refresh", text: "⟳ Refresh", title: "Ask GitHub again" });
  refreshButton.addEventListener("click", () => void refresh());
  const close = el("button", { class: "btn ghost inbox-close", type: "button", text: "← Back" });
  close.addEventListener("click", () => cb.close());
  const body = el("div", { class: "inbox-body" });
  host.append(
    el("div", { class: "inbox-head" }, [
      el("span", { class: "inbox-heading", text: "Review inbox" }),
      status,
      el("span", { class: "spacer" }),
      refreshButton,
      close,
    ]),
    body,
  );
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    cb.close();
  });

  const row = (pr: InboxPr): HTMLElement => {
    const unresolved = pr.unresolved ?? 0;
    // Unknown (GitHub's thread query failed) is not none.
    const threads =
      pr.unresolved === null
        ? "? unresolved"
        : unresolved > 0
          ? `${unresolved} unresolved${pr.prepared > 0 ? ` · ${pr.prepared} prepared` : ""}`
          : "";
    const button = el("button", { class: "inbox-row", type: "button", title: `Open ${pr.repo}#${pr.number}` }, [
      el("span", { class: `pr-check-dot ${pr.checks ?? "none"}`, title: pr.checks ? `checks: ${pr.checks}` : "no checks" }),
      el("span", { class: "inbox-repo", text: pr.repo }),
      el("span", { class: "inbox-number", text: `#${pr.number}` }),
      el("span", { class: "inbox-title", text: pr.title }),
      ...inboxReasons(pr).map((r) => el("span", { class: "inbox-reason", text: r })),
      el("span", { class: "spacer" }),
      el("span", { class: "inbox-threads", text: threads, title: "Unresolved threads, and how many have a reply or a fix prepared" }),
      el("span", { class: "inbox-author", text: pr.author }),
      el("span", { class: "inbox-age", text: pr.updated_at ? relativeTime(isoSeconds(pr.updated_at)) : "" }),
    ]);
    button.addEventListener("click", () => cb.open(pr.path, pr.number));
    return button;
  };

  const group = (title: string, prs: InboxPr[]): HTMLElement =>
    el("section", { class: "inbox-group" }, [el("h3", { text: `${title} · ${prs.length}` }), ...prs.map(row)]);

  const render = () => {
    clear(body);
    // In the order asked, so of two paths of one GitHub repository (both
    // answered while the recent list changed) the first one's rows show.
    const order = (r: InboxRepo) => {
      const i = paths.indexOf(r.path);
      return i < 0 ? paths.length : i;
    };
    const answers = [...results.values()].sort((a, b) => order(a) - order(b));
    const seen = new Set<string>();
    const prs = answers
      .flatMap((r) => r.prs)
      .filter((pr) => {
        const key = `${pr.repo.toLowerCase()}#${pr.number}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const failed = answers.filter((r) => r.error);
    const left = asked - answers.length;
    status.textContent = reading && left > 0 ? `Reading ${left} ${left === 1 ? "repository" : "repositories"}…` : "";
    const { needs, waiting } = groupInbox(prs);
    if (needs.length > 0) body.append(group("Needs you", needs));
    if (waiting.length > 0) body.append(group("Waiting on others", waiting));
    if (prs.length === 0 && !reading && answers.some((r) => !r.error)) {
      body.append(el("div", { class: "inbox-empty", text: "Nothing open needs you or waits on others." }));
    }
    if (failed.length > 0) {
      body.append(
        el("section", { class: "inbox-group inbox-failed" }, [
          el("h3", { text: `Couldn't read · ${failed.length}` }),
          ...failed.map((r) =>
            el("div", { class: "inbox-failed-row", title: r.path }, [
              el("span", { class: "inbox-failed-name", text: r.path.split("/").filter(Boolean).pop() ?? r.path }),
              el("span", { class: "inbox-failed-reason", text: r.error ?? "" }),
            ]),
          ),
        ]),
      );
    }
  };

  // Ask every repository again. An older run's answers, still coming, are
  // dropped; a repository keeps its rows until its new answer, and one that
  // didn't answer this run (gone from the list, or merged into another path
  // of the same GitHub repository) goes when the run ends.
  const refresh = async () => {
    const mine = ++run;
    paths = cb.paths();
    const answered = new Set<string>();
    asked = paths.length;
    reading = true;
    render();
    try {
      await cb.load(paths, (repo) => {
        if (mine !== run) return;
        answered.add(repo.path);
        results.set(repo.path, repo);
        render();
      });
    } catch (err) {
      if (mine === run) status.textContent = `Couldn't read the inbox: ${String(err)}`;
      return;
    } finally {
      if (mine === run) reading = false;
    }
    if (mine !== run) return;
    for (const path of [...results.keys()]) if (!answered.has(path)) results.delete(path);
    render();
  };

  const isShowing = () => !host.classList.contains("hidden");

  return {
    show() {
      host.classList.remove("hidden");
      host.focus?.();
      void refresh();
      stopPolling?.();
      stopPolling = startPolling(POLL_KEY, POLL_MS, () => {
        // Something else (another view) hid it: stop until shown again.
        if (!isShowing()) {
          stopPolling?.();
          stopPolling = null;
          return;
        }
        return refresh();
      });
    },
    hide() {
      host.classList.add("hidden");
      stopPolling?.();
      stopPolling = null;
    },
    isShowing,
  };
}
