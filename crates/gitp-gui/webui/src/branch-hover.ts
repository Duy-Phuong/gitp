// Hovering a branch — a badge in the log or a row in the sidebar — fades the
// commits that aren't on it, GitKraken-style. Settings → History turns it off.
//
// Every branch element is already a drag handle (views/ref-drag.ts), which is
// what marks it as a branch here too. One mouseover listener for the whole
// window rather than enter/leave pairs per badge: the log rebuilds its rows on
// every scroll and the sidebar on every refresh, and an element removed under
// the pointer never gets its mouseleave, which would leave the log faded.

import { branchReach } from "./commit-refs";
import { loadBranchHoverFade } from "./prefs";
import { setLogHighlight } from "./views/log";
import { refUnder } from "./views/ref-drag";

// "kind:name" of the branch under the pointer, "" for none.
let hovered = "";

function hover(target: EventTarget | null): void {
  const ref = target && loadBranchHoverFade() ? refUnder(target) : null;
  const key = ref ? `${ref.kind}:${ref.name}` : "";
  if (key === hovered) return;
  hovered = key;
  setLogHighlight(ref ? branchReach(ref) : null);
}

export function setupBranchHover(): void {
  document.addEventListener("mouseover", (e) => hover(e.target));
  // Leaving the window over a badge gets no mouseover to clear it.
  document.documentElement.addEventListener("mouseleave", () => hover(null));
}
