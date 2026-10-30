// Stash & Switch: the question every checkout asks when the working tree has
// uncommitted changes, and the report of a switch made through the stash. The
// switch itself runs in gitp-core (`stash_and_switch`), which re-applies the
// work if the switch fails.

import { state } from "./app-state";
import { reportDone, setStatus } from "./report";
import { showView } from "./shell";
import type { StashSwitch } from "./types";
import { askChoice } from "./views/choice-dialog";
import { showErrorDialog } from "./views/message-dialog";

export type SwitchChoice = "stash" | "switch" | "cancel";

// `target` as the question names it, e.g. `"main"` or `a1b2c3d (detached HEAD)`.
export function askSwitchWithChanges(target: string): Promise<SwitchChoice> {
  const n = state.localChanges;
  return askChoice<SwitchChoice>(
    `You have ${n} uncommitted change${n === 1 ? "" : "s"}`,
    `Stash & Switch puts them away, switches to ${target}, and re-applies them there. ` +
      "Switch brings them along as they are; changes that clash with the target block it.",
    [
      { label: "Cancel", answer: "cancel", left: true },
      { label: "Switch", answer: "switch" },
      { label: "Stash & Switch", answer: "stash", primary: true },
    ],
    "cancel",
  );
}

// After the views are refreshed: a clean re-apply is a plain success; a
// conflicting one is a switch that worked with work left to finish, so it
// says where the work is (markers in the files, and still the top stash).
export function reportStashSwitch(target: string, r: StashSwitch): void {
  if (!r.stash_kept) {
    reportDone(`Checked out ${target} and re-applied your changes.`);
    return;
  }
  const title = `Checked out ${target}, but your changes didn't re-apply cleanly`;
  setStatus(title);
  showErrorDialog(
    title,
    "Re-applying your stashed changes didn't go cleanly (git's output is below): files may hold " +
      "conflict markers to resolve in Local Changes. Your changes are still saved in stash@{0}; " +
      "drop it once you're done.\n\n" +
      r.output,
    { label: "Local Changes", run: () => showView("changes") },
  );
}
