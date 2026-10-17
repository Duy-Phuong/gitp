// The top bar's dropdown menus: Branch, the Pull caret, and Settings.

import { clear, el, $ } from "./dom";
import { state } from "./app-state";
import {
  applyTheme,
  loadPullDefault,
  PULL_DEFAULT_LABEL,
  PULL_DEFAULTS,
  savePullDefault,
  type ThemeChoice,
  updateThemeMenu,
} from "./prefs";
import { setConfigTab } from "./config-panel";
import { showView } from "./shell";
import { createBranchAction, runPullMethod } from "./repo-actions";
import { checkoutBranchAction } from "./ref-actions";

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

// The settings gear opens a small menu; "Git Config" jumps to the config view.
export function setupSettingsMenu(): void {
  const btn = $("#settings-btn");
  const menu = $("#settings-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowHidden = menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });
  menu.querySelector('[data-action="git-config"]')?.addEventListener("click", () => {
    close();
    setConfigTab("git");
    showView("config");
  });
  menu.querySelector('[data-action="dotfiles"]')?.addEventListener("click", () => {
    close();
    setConfigTab("dotfiles");
    showView("config");
  });
  for (const choice of menu.querySelectorAll<HTMLElement>("[data-theme-choice]")) {
    choice.addEventListener("click", () => {
      applyTheme(choice.dataset.themeChoice as ThemeChoice);
      updateThemeMenu();
      close();
    });
  }
  updateThemeMenu();
  document.addEventListener("click", (e) => {
    if (!$("#settings").contains(e.target as Node)) close();
  });
}
