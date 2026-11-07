// The Review panel of a local branch, before any pull request exists: run
// the review skill or command on the branch's diff against a base ("Against"),
// then the findings in two tabs — Drafts, the list, and Files, the diff with
// each draft's card under its line. Both tabs edit the same drafts
// (pr-reviews.ts), so a change in one shows in the other. A draft can be fixed
// in the branch's worktree; nothing goes to GitHub from here.
//
// The drafts' lines are those of the reviewed head; when the branch moved on
// they are carried to the current head (branch-reviews.ts), and a line that
// changed meanwhile says "line moved", with no card and no Fix.

import { clear, el } from "../dom";
import { branchState, fixDisabledReason, placeDraft, type BranchReviewState } from "../branch-reviews";
import { isOpen, reviewFor, reviewsChanged, saveSoon, type Draft, type PrReview } from "../pr-reviews";
import { checkAnchor } from "../review-drafts";
import { draftCard, placeDraftCards } from "./draft-cards";
import { renderFile } from "./detail";

export interface BranchReviewCallbacks {
  repoPath(): string;
  // The refs offered in Against.
  bases(): string[];
  // Read the panel's data again (the diff, the saved review, the worktree).
  load(branch: string): void;
  run(branch: string, base: string, skill: boolean): void;
  cancel(branch: string): void;
  fix(branch: string, d: Draft): void;
  openCommit(sha: string): void;
  clear(branch: string): void;
  changeBase(branch: string, base: string): void;
}

export interface BranchReviewHandle {
  show(branch: string): void;
  redraw(): void;
  // The branch on screen, if any.
  branch(): string | null;
}

type Tab = "drafts" | "files";

export function setupBranchReviewView(host: HTMLElement, cb: BranchReviewCallbacks): BranchReviewHandle {
  let branch: string | null = null;
  let tab: Tab = "drafts";
  let scrollTo: number | null = null;
  // The tab drawn last: a redraw of the same one keeps its scroll (an
  // Approve on the 15th card must not jump to the top); a switch starts at it.
  let renderedTab: Tab | null = null;

  const state = (): BranchReviewState => branchState(cb.repoPath(), branch ?? "");
  const review = (): PrReview => reviewFor(cb.repoPath(), { branch: branch ?? "" });

  function render(): void {
    const scrolled = renderedTab === tab && scrollTo === null ? (host.querySelector<HTMLElement>(".pr-body")?.scrollTop ?? 0) : 0;
    renderedTab = tab;
    clear(host);
    if (!branch) return;
    const s = state();
    const r = review();
    const b = branch;
    const view = el("div", { class: "pr-view branch-review" });
    host.append(view);

    const against = el("select", { class: "branch-review-against", "aria-label": "Review against" }) as HTMLSelectElement;
    const bases = cb.bases();
    for (const name of s.base && !bases.includes(s.base) ? [s.base, ...bases] : bases) {
      const o = el("option", { value: name, text: name }) as HTMLOptionElement;
      o.selected = name === s.base;
      against.append(o);
    }
    against.addEventListener("change", () => cb.changeBase(b, against.value));
    const button = (text: string, onClick: () => void, title: string) => {
      const x = el("button", { class: "btn small ghost", text, title }) as HTMLButtonElement;
      x.addEventListener("click", onClick);
      return x;
    };
    const actions: HTMLElement[] = s.running
      ? [el("span", { class: "pr-drafts-summary", text: "Reviewing…" }), button("Cancel", () => cb.cancel(b), "Stop the review")]
      : [
          button("Run Review Skill", () => cb.run(b, s.base, true), "Run the /review-pr-phuong skill on the branch's diff in its worktree, in the background"),
          button("Run Review Command", () => cb.run(b, s.base, false), "Run the review command (Settings → Git) on the branch's diff, in the background"),
        ];
    for (const a of actions) if (a instanceof HTMLButtonElement && s.fixing !== null) a.disabled = true;
    if (r.drafts.length && !s.running) actions.push(button("Clear", () => cb.clear(b), "Forget this branch's review"));
    const meta = el("div", { class: "pr-meta" }, [
      el("span", { class: "pr-author", text: "Against" }),
      against,
      ...actions,
    ]);
    const head = s.data?.head;
    if (r.head && head && !head.startsWith(r.head) && !r.head.startsWith(head)) {
      meta.append(el("span", { class: "pr-draft-note", text: `Reviewed at ${r.head.slice(0, 7)} · now ${head.slice(0, 7)}` }));
    }
    view.append(
      el("div", { class: "pr-header" }, [el("div", { class: "pr-title" }, [el("span", { text: `Review of ${b}` })]), meta]),
    );
    if (s.error) view.append(el("div", { class: "pr-draft-warn branch-review-error", text: s.error }));

    const tabs = el("div", { class: "pr-tabs" });
    const tabButton = (t: Tab, label: string) => {
      const x = el("button", { class: `pr-tab${tab === t ? " active" : ""}`, text: label });
      x.addEventListener("click", () => {
        tab = t;
        render();
      });
      return x;
    };
    tabs.append(
      tabButton("drafts", `Drafts (${r.drafts.filter(isOpen).length})`),
      tabButton("files", `Files (${s.data?.files.length ?? 0})`),
    );
    const body = el("div", { class: "pr-body" });
    view.append(tabs, body);
    if (!s.data) {
      body.append(el("div", { class: "pr-empty", text: s.loading ? `Loading ${b}…` : `No diff of ${b} loaded.` }));
      return;
    }
    if (tab === "drafts") renderDrafts(body, s, r);
    else renderFiles(body, s, r);
    if (scrolled) body.scrollTop = scrolled;
  }

  function card(d: Draft, s: BranchReviewState, where: "list" | "inline"): HTMLElement {
    const placed = placeDraft(d, s.data?.moves ?? null);
    const inDiff = !placed.moved && d.path !== "" && checkAnchor({ ...d, path: placed.path, line: placed.line }, s.data?.files ?? []) === "ok";
    const note = placed.moved ? "line moved" : d.path && !inDiff ? "line not in this diff" : null;
    return draftCard(d, {
      where,
      note: where === "list" ? note : null,
      fix: d.path ? { reason: fixDisabledReason(s, d, placed), run: () => cb.fix(s.branch, d) } : null,
      showInDiff: where === "list" && inDiff ? () => showInDiff(d) : null,
      openCommit: cb.openCommit,
      changed: (redraw) => (redraw ? reviewsChanged() : saveSoon()),
    });
  }

  function renderDrafts(body: HTMLElement, s: BranchReviewState, r: PrReview): void {
    if (!r.drafts.length) {
      body.append(el("div", { class: "pr-empty", text: s.running ? "Reviewing in the background…" : "No findings yet. Run Review Skill or Run Review Command." }));
      return;
    }
    const open = r.drafts.filter(isOpen).length;
    const fixed = r.drafts.filter((d) => d.status === "fixed").length;
    body.append(
      el("div", { class: "pr-drafts-bar" }, [
        el("span", { class: "pr-drafts-summary", text: `${open} open · ${fixed} fixed · ${r.drafts.length - open - fixed} discarded` }),
      ]),
    );
    for (const d of r.drafts) body.append(card(d, s, "list"));
  }

  function renderFiles(body: HTMLElement, s: BranchReviewState, r: PrReview): void {
    const files = s.data!.files;
    if (!files.length) {
      body.append(el("div", { class: "pr-empty", text: `Nothing to review: ${s.branch} has no changes against ${s.base}.` }));
      return;
    }
    const placed = r.drafts
      .map((d) => ({ d, at: placeDraft(d, s.data!.moves) }))
      .filter((x) => !x.at.moved && x.d.path);
    for (const file of files) {
      const node = renderFile(file);
      placeDraftCards(
        node,
        file,
        placed.filter((x) => x.at.path === file.path).map((x) => ({ d: x.d, line: x.at.line, side: x.at.side })),
        (d) => card(d, s, "inline"),
      );
      body.append(node);
    }
    if (scrollTo !== null) {
      const id = scrollTo;
      scrollTo = null;
      setTimeout(() => host.querySelector<HTMLElement>(`.pr-draft.inline[data-draft="${id}"]`)?.scrollIntoView({ block: "center" }), 0);
    }
  }

  function showInDiff(d: Draft): void {
    tab = "files";
    scrollTo = d.id;
    render();
  }

  return {
    show(next: string) {
      if (branch !== next) {
        tab = "drafts";
        renderedTab = null;
      }
      branch = next;
      render();
      cb.load(next);
    },
    redraw: render,
    branch: () => branch,
  };
}
