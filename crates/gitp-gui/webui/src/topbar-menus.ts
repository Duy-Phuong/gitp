// The top bar's dropdown menus: Branch and the Pull caret; and the Settings gear.

import { browseForFolder, fetchConfig, listHooks, openHook, saveConfig, setHookEnabled, setLocalHistoryEnabled, unsetConfig } from "./api";
import { clear, el, $ } from "./dom";
import { state, ui } from "./app-state";
import { ensureAvatars } from "./avatar";
import { opFailed, reportDone } from "./report";
import {
  applyTheme,
  loadJiraSite,
  loadPullDefault,
  PULL_DEFAULT_LABEL,
  PULL_DEFAULTS,
  saveAutoFetchMinutes,
  savePullDefault,
  type ThemeChoice,
} from "./prefs";
import { setConfigTab } from "./config-panel";
import { reloadDiffs, showView, startAutoFetch, updateLogView } from "./shell";
import { createBranchAction, runPullMethod } from "./repo-actions";
import { checkoutBranchAction, openTicket } from "./ref-actions";
import { branchTicket } from "./jira";
import { matchBranches, recentBranches } from "./branch-filter";
import type { BranchRef } from "./types";
import { githubAccountForSettings, signInToGitHub, signOutOfGitHub } from "./pr-actions";
import { closeSettingsDialog, openSettingsDialog } from "./views/settings-dialog";

// The Branch button's dropdown: pick a local branch to check out, or create a
// new one from the current HEAD. Rebuilt from current refs each time it opens.
export function setupBranchMenu(): void {
  const btn = $("#branch-btn");
  const menu = $("#branch-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) buildBranchMenu(menu, close);
    const nowHidden = menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });
  document.addEventListener("click", (e) => {
    if (!$("#branch-wrap").contains(e.target as Node)) close();
  });
}

function buildBranchMenu(menu: HTMLElement, close: () => void): void {
  clear(menu);
  // Typing narrows the branches; the arrows pick one and Enter checks it out.
  const filter = el("input", {
    class: "branch-menu-filter",
    type: "search",
    placeholder: "Filter branches",
    spellcheck: "false",
    "aria-label": "Filter branches",
  });
  // The branches scroll on their own: the filter above and the new-branch row
  // under them stay in view however many there are.
  const list = el("div", { class: "branch-menu-list" });
  menu.append(filter, list);

  const branches = state.refs.branches;
  let shown: BranchRef[] = branches;
  // The row the arrows picked, shown once a key moved it or text was typed.
  let picked = 0;
  let keyed = false;
  // With nothing typed, the branches checked out last come first, then all.
  const byName = new Map(branches.map((b) => [b.name, b]));
  const head = branches.find((b) => b.is_head)?.name ?? null;
  const recent = recentBranches(state.refs.recent, branches.map((b) => b.name), head).map((n) => byName.get(n)!);
  const jiraSite = loadJiraSite();
  const paint = () => {
    clear(list);
    const names = new Set(matchBranches(branches.map((b) => b.name), filter.value));
    const typed = filter.value.trim() !== "";
    const top = typed ? [] : recent;
    shown = [...top, ...branches.filter((b) => names.has(b.name))];
    picked = Math.min(picked, Math.max(shown.length - 1, 0));
    if (branches.length === 0) list.append(el("div", { class: "menu-item", text: "No branches" }));
    else if (shown.length === 0) {
      list.append(el("div", { class: "menu-item branch-menu-none", text: `No branch matches "${filter.value.trim()}" · Enter to make it` }));
    }
    shown.forEach((b, i) => {
      if (top.length && (i === 0 || i === top.length)) {
        list.append(el("div", { class: "branch-menu-group", text: i === 0 ? "Recent" : "All branches" }));
      }
      const item = el("button", {
        class: `menu-item${b.is_head ? " head" : ""}${keyed && i === picked ? " picked" : ""}`,
        text: b.is_head ? `● ${b.name}` : b.name,
      });
      item.addEventListener("click", () => {
        close();
        void checkoutBranchAction(b);
      });
      // The ticket the branch is named for, when Settings has a Jira site.
      const ticket = branchTicket(b.name, jiraSite);
      if (ticket) {
        const jira = el("span", { class: "branch-menu-jira", text: "Jira", title: `Open ${ticket.key} in Jira` });
        jira.addEventListener("click", (e) => {
          e.stopPropagation();
          close();
          openTicket(ticket.url);
        });
        item.append(jira);
      }
      list.append(item);
    });
  };
  paint();
  filter.addEventListener("input", () => {
    picked = 0;
    keyed = filter.value.trim() !== "";
    paint();
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (keyed) picked = (picked + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
      keyed = true;
      paint();
      list.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const b = shown[picked];
      if (keyed && b) {
        close();
        void checkoutBranchAction(b);
      } else if (!shown.length && filter.value.trim()) {
        // No branch by that name: it goes to the new-branch box, to make it.
        input.value = filter.value.trim();
        input.focus();
      }
    } else if (e.key === "Escape") close();
  });

  menu.append(el("div", { class: "menu-sep" }));
  const input = el("input", {
    placeholder: "New branch name",
    spellcheck: "false",
  });
  const create = el("button", { class: "btn small", text: "Create" });
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    close();
    void createBranchAction(name);
  };
  create.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") close();
  });
  menu.append(el("div", { class: "menu-newbranch" }, [input, create]));
  requestAnimationFrame(() => {
    filter.focus();
    // The branch checked out, in view in a long list.
    list.querySelector(".head")?.scrollIntoView({ block: "center" });
  });
}

// The Pull caret's dropdown: pick a pull method to run once, or hover a row to
// set it as the plain Pull button's default (GitKraken-style).
export function setupPullMenu(): void {
  const btn = $("#pull-caret-btn");
  const menu = $("#pull-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    buildPullMenu(menu, close);
    const nowHidden = menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });
  document.addEventListener("click", (e) => {
    if (!$("#pull-wrap").contains(e.target as Node)) close();
  });
}

function buildPullMenu(menu: HTMLElement, close: () => void): void {
  clear(menu);
  const current = loadPullDefault();
  for (const mode of PULL_DEFAULTS) {
    const isDefault = mode === current;
    const row = el("div", { class: `pull-item${isDefault ? " default" : ""}`, role: "menuitemradio" });
    const setDefault = el("button", { class: "pull-set-default", text: "Set as default" });
    setDefault.addEventListener("click", (e) => {
      e.stopPropagation();
      savePullDefault(mode);
      buildPullMenu(menu, close); // refresh radios without closing
    });
    row.append(
      el("span", { class: "pull-radio" }),
      el("span", { class: "pull-label", text: PULL_DEFAULT_LABEL[mode] }),
      ...(isDefault ? [] : [setDefault]),
    );
    row.addEventListener("click", () => {
      close();
      void runPullMethod(mode);
    });
    menu.append(row);
  }
}

// The settings gear opens the Settings dialog.
export function setupSettingsMenu(): void {
  $("#settings-btn").addEventListener("click", () => openSettings());
}

// Open the Settings dialog, at `section` ("Git", say) when given — also what
// Quick Launch runs.
export function openSettings(section?: string): void {
  openSettingsDialog(
    {
      setTheme: (choice: ThemeChoice) => {
        applyTheme(choice);
        // The GitKraken themes draw the graph differently, which CSS alone can't
        // do, so the log is redrawn in the new style.
        if (state.view === "history") void updateLogView();
      },
      allBranches: () => state.allBranches,
      // The toggle above the log owns the switch (persisting it and reloading
      // the history), so the dialog just presses it.
      setAllBranches: (all) => $(all ? "#branches-all" : "#branches-current").click(),
      setAutoFetch: (minutes) => {
        saveAutoFetchMinutes(minutes);
        startAutoFetch(minutes);
      },
      // The log and the reflog redraw now; the details pane shows the new
      // format from the next commit selected.
      redrawDisplay: () => {
        if (state.view === "reflog") void ui.reflogView?.reload();
        // Back from initials, the loaded rows' avatars were never looked up.
        void ensureAvatars(state.rows.map((r) => r.author_email)).then(() => {
          if (state.view === "history") void updateLogView();
        });
      },
      // libgit2 lists keys with the variable name lowercased.
      hooksPath: async () => {
        if (!state.repoPath) return null;
        const entries = await fetchConfig();
        return entries.find((e) => e.scope === "Local" && e.name.toLowerCase() === "core.hookspath")?.value ?? "";
      },
      setHooksPath: async (path) => {
        try {
          if (path) await saveConfig("Local", "core.hooksPath", path);
          else await unsetConfig("Local", "core.hooksPath");
          reportDone(path ? `Hooks folder set to ${path}` : "Hooks folder reset to .git/hooks");
        } catch (err) {
          opFailed("Couldn't set the hooks folder", err);
        }
      },
      reviewFolder: async () => {
        if (!state.repoPath) return null;
        const entries = await fetchConfig();
        return entries.find((e) => e.scope === "Local" && e.name.toLowerCase() === "gitp.reviewfolder")?.value ?? "";
      },
      // A folder picked inside the repository is kept relative to it, so
      // every worktree of a branch review has its own.
      setReviewFolder: async (path) => {
        const root = state.repoPath.replace(/\/+$/, "");
        const folder = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        try {
          if (folder) await saveConfig("Local", "gitp.reviewFolder", folder);
          else await unsetConfig("Local", "gitp.reviewFolder");
          reportDone(folder ? `Reviews are saved in ${folder}` : "Reviews are saved in review/");
        } catch (err) {
          opFailed("Couldn't set the review folder", err);
        }
      },
      browseFolder: browseForFolder,
      hooks: async () => (state.repoPath ? listHooks() : null),
      setLocalHistory: (on) => void setLocalHistoryEnabled(on),
      setHookEnabled: async (name, enabled) => {
        try {
          await setHookEnabled(name, enabled);
          reportDone(`${name} hook turned ${enabled ? "on" : "off"}`);
        } catch (err) {
          opFailed(`Couldn't change the ${name} hook`, err);
        }
      },
      openHook: async (name) => {
        try {
          await openHook(name);
        } catch (err) {
          opFailed(`Couldn't open the ${name} hook`, err);
        }
      },
      redrawDiffs: () => {
        ui.detailView?.redraw();
        // Re-renders from the status it has; the diff itself isn't re-read.
        void ui.changesView?.reload();
      },
      encoding: async () => {
        if (!state.repoPath) return null;
        const entries = await fetchConfig();
        return entries.find((e) => e.scope === "Local" && e.name.toLowerCase() === "gitp.encoding")?.value ?? "utf-8";
      },
      // UTF-8 is the default, so choosing it unsets the key.
      setEncoding: async (label) => {
        try {
          if (label === "utf-8") await unsetConfig("Local", "gitp.encoding");
          else await saveConfig("Local", "gitp.encoding", label);
          reportDone(`Text encoding set to ${label}`);
          reloadDiffs();
        } catch (err) {
          opFailed("Couldn't set the text encoding", err);
        }
      },
      openConfig: (tab) => {
        closeSettingsDialog();
        setConfigTab(tab);
        showView("config");
      },
      githubAccount: githubAccountForSettings,
      githubSignIn: signInToGitHub,
      githubSignOut: signOutOfGitHub,
    },
    section,
  );
}
