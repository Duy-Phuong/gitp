// The top bar's dropdown menus: Branch and the Pull caret; and the Settings gear.

import { browseForFolder, fetchConfig, saveConfig, unsetConfig } from "./api";
import { clear, el, $ } from "./dom";
import { state, ui } from "./app-state";
import { ensureAvatars } from "./avatar";
import { opFailed, reportDone } from "./report";
import {
  applyTheme,
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
import { checkoutBranchAction } from "./ref-actions";
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

  if (state.refs.branches.length === 0) {
    menu.append(el("div", { class: "menu-item", text: "No branches" }));
  }
  for (const b of state.refs.branches) {
    const item = el("button", {
      class: `menu-item${b.is_head ? " head" : ""}`,
      text: b.is_head ? `● ${b.name}` : b.name,
    });
    item.addEventListener("click", () => {
      close();
      void checkoutBranchAction(b);
    });
    menu.append(item);
  }

  menu.append(el("div", { class: "menu-sep" }));
  const input = el("input", {
    placeholder: "New branch name",
    spellcheck: "false",
  }) as HTMLInputElement;
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
  });
  menu.append(el("div", { class: "menu-newbranch" }, [input, create]));
  requestAnimationFrame(() => input.focus());
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
  $("#settings-btn").addEventListener("click", () =>
    openSettingsDialog({
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
      browseFolder: browseForFolder,
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
    }),
  );
}
