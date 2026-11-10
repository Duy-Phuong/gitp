// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { closeSettingsDialog, matchesSettingsQuery, openSettingsDialog, type SettingsActions } from "./settings-dialog";

// No repository open: the repository's own settings answer null.
const none = () => Promise.resolve(null);
const actions = {
  setTheme: () => {},
  allBranches: () => true,
  setAllBranches: () => {},
  setAutoFetch: () => {},
  redrawDisplay: () => {},
  hooksPath: none,
  setHooksPath: () => Promise.resolve(),
  hooks: none,
  setLocalHistory: () => {},
  setHookEnabled: () => Promise.resolve(),
  openHook: () => Promise.resolve(),
  browseFolder: none,
  redrawDiffs: () => {},
  encoding: none,
  reviewFolder: none,
  setReviewFolder: () => Promise.resolve(),
  setEncoding: () => Promise.resolve(),
  openConfig: () => {},
  githubAccount: () => Promise.reject(new Error("no gh")),
  githubSignIn: () => Promise.resolve(),
  githubSignOut: () => Promise.resolve(),
} satisfies SettingsActions;

const labels = () => [...document.querySelectorAll(".settings-body .settings-row-label")].map((n) => n.textContent);
const type = (text: string) => {
  const box = document.querySelector<HTMLInputElement>(".settings-search")!;
  box.value = text;
  box.dispatchEvent(new Event("input"));
};

describe("Settings search", () => {
  afterEach(() => closeSettingsDialog());

  it("matches every word, in any order", () => {
    expect(matchesSettingsQuery("Commit graph shows Avatars come from gravatar", "graph avatar")).toBe(true);
    expect(matchesSettingsQuery("Zoom", "zoom level")).toBe(false);
  });

  it("finds settings across the tabs, and goes back to the tab when cleared", () => {
    openSettingsDialog(actions);
    const first = labels();
    type("zoom");
    expect(labels()).toEqual(["Zoom"]);
    type("notifications");
    expect(labels()).toEqual(["A Claude job finishes or fails", "A check fails on my pull request or branch", "A review is asked of me"]);
    // Every Claude setting is in its own tab.
    type("claude");
    expect(labels()).toEqual(expect.arrayContaining(["Claude model", "Claude effort", "Review folder", "Review command", "Fix command", "Commit message command"]));
    type("review folder");
    expect(labels()).toEqual(["Review folder"]);
    type("nothing like this");
    expect(document.querySelector(".settings-body")?.textContent).toContain('No setting matches "nothing like this".');
    type("");
    expect(labels()).toEqual(first);
  });
});
