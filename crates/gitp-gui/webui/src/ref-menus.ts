// The menus that act on refs, built as data: the drag-and-drop menu and the
// "Merge into" submenu. What each item does is handed in, so the shape of a
// menu — which entries, in which order, with which headings — is a pure
// function that ref-menus.test.ts pins. ref-actions.ts supplies the actions.

import type { DropAction, DropRef } from "./ref-drop";
import type { MenuItem } from "./views/context-menu";
import type { MergeMode, ResetMode } from "./types";

export interface DropMenuActions {
  merge: () => void;
  rebase: () => void;
  interactiveRebase: () => void;
  reset: (mode: ResetMode) => void;
  fastForward: () => void;
  push: () => void;
}

// The menu for dropping `src` on `dst`, one entry per applicable action in
// the order dropActions gives them. `outlook` is the merge dry run's verdict,
// shown as a heading above Merge and Rebase when there is one.
export function dropMenuItems(src: DropRef, dst: DropRef, actions: DropAction[], outlook: string | null, act: DropMenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  for (const action of actions) {
    switch (action) {
      case "merge":
        if (outlook) items.push({ heading: outlook });
        items.push({ label: `Merge ${src.name} into ${dst.name}`, run: act.merge });
        break;
      case "rebase":
        if (outlook) items.push({ heading: outlook });
        items.push({ label: `Rebase ${src.name} onto ${dst.name}`, run: act.rebase });
        break;
      case "interactive-rebase":
        items.push({ label: "Interactive Rebase…", run: act.interactiveRebase });
        break;
      case "reset":
        items.push({ heading: `Reset ${src.name} to ${dst.name}` });
        items.push({ label: "Soft (keep changes staged)…", run: () => act.reset("Soft") });
        items.push({ label: "Mixed (keep changes unstaged)…", run: () => act.reset("Mixed") });
        items.push({ label: "Hard (discard changes)…", danger: true, run: () => act.reset("Hard") });
        break;
      case "fast-forward":
        items.push({ label: `Fast-forward ${dst.name} to ${src.name}`, run: act.fastForward });
        break;
      case "push":
        items.push({ label: `Push ${src.name} to ${dst.name}`, run: act.push });
        break;
    }
  }
  return items;
}

// The question before a rebase from a drop or a branch menu, with the dry
// run's verdict when there is one.
export function rebaseQuestion(src: string, onto: string, outlook: string | null): string {
  return `Rebase ${src} onto ${onto}? This rewrites commits on ${src}.${outlook ? ` ${outlook}.` : ""}`;
}

// git's default merge and its three common variants, in menu order.
export const MERGE_MODES: { mode: MergeMode; label: string }[] = [
  { mode: "Default", label: "Merge" },
  { mode: "NoFastForward", label: "Merge (no fast-forward)" },
  { mode: "FastForwardOnly", label: "Fast-forward only" },
  { mode: "Squash", label: "Squash merge" },
];

// "Merge into '<current>' ▸": the modes, under the dry run's verdict when one
// was made.
export function mergeMenuItem(name: string, current: string, outlook: string | null, run: (mode: MergeMode) => void): MenuItem {
  return {
    label: `Merge into '${current}'`,
    submenu: [
      { heading: `Merge ${name} into ${current}` },
      ...(outlook ? [{ heading: outlook }] : []),
      ...MERGE_MODES.map(({ mode, label }) => ({ label, run: () => run(mode) })),
    ],
  };
}
