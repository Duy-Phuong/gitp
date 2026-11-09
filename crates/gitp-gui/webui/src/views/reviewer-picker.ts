// "+ Add" in a pull request's Reviewers row: a box to type a login or an
// org/team in, with the repository's people that match under it. Enter
// takes the first match, or what was typed when nothing matches (a team);
// Escape or a click outside closes it.

import { el } from "../dom";
import { reviewerMatches } from "../pull-requests";

let open: HTMLElement | null = null;

export function closeReviewerPicker(): void {
  open?.remove();
  open = null;
}

export function openReviewerPicker(
  anchor: HTMLElement,
  people: () => Promise<string[]>,
  exclude: string[],
  onPick: (id: string) => void,
): void {
  closeReviewerPicker();
  let all: string[] = [];
  const input = el("input", { class: "reviewer-picker-input", placeholder: "Login or org/team", spellcheck: "false" });
  const list = el("ul", { class: "reviewer-picker-list" });
  const note = el("div", { class: "reviewer-picker-note", text: "Loading the people of this repository…" });
  const box = el("div", { class: "reviewer-picker" }, [input, list, note]);
  open = box;

  const pick = (id: string) => {
    const clean = id.trim().replace(/^@/, "");
    if (!clean) return;
    closeReviewerPicker();
    onPick(clean);
  };
  const show = () => {
    const matches = reviewerMatches(all, input.value, exclude);
    list.replaceChildren(
      ...matches.map((login) => {
        const item = el("li", { text: login });
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(login);
        });
        return item;
      }),
    );
    list.firstElementChild?.classList.add("first");
  };
  input.addEventListener("input", show);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") closeReviewerPicker();
    else if (e.key === "Enter") pick(reviewerMatches(all, input.value, exclude, 1)[0] ?? input.value);
  });
  const outside = (e: MouseEvent) => {
    if (!open) return document.removeEventListener("mousedown", outside, true);
    if (!box.contains(e.target as Node)) {
      document.removeEventListener("mousedown", outside, true);
      closeReviewerPicker();
    }
  };
  document.addEventListener("mousedown", outside, true);

  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`;
  box.style.top = `${r.bottom + 4}px`;
  document.body.append(box);
  input.focus();
  void people()
    .then((logins) => {
      all = logins;
      note.textContent = "Enter adds the first match, or what you typed (org/team for a team).";
      show();
    })
    .catch(() => {
      note.textContent = "Couldn't read the people of this repository: type a login or org/team.";
    });
}
