// The Settings dialog behind the top bar's gear.
//
// A sidebar of sections, each a list of labelled rows. Every control applies
// as soon as it changes — there is nothing to save — so Done only closes.
// A new setting is one more `row(...)` in the section it belongs to; a new
// section is one more entry in `sections`. Reuses the `.modal-overlay` /
// `.modal` shell.

import { el } from "../dom";
import {
  AUTO_FETCH_MINUTES,
  currentTheme,
  loadAutoFetchMinutes,
  loadDetailTab,
  loadPullDefault,
  PULL_DEFAULT_LABEL,
  PULL_DEFAULTS,
  saveDetailTab,
  savePullDefault,
  type PullDefault,
  type ThemeChoice,
} from "../prefs";
import type { DetailTab } from "./detail";

export interface SettingsActions {
  // Apply and persist a theme, redrawing whatever CSS alone can't restyle.
  setTheme: (choice: ThemeChoice) => void;
  allBranches: () => boolean;
  setAllBranches: (all: boolean) => void;
  // Persist the auto-fetch interval (0 = off) and restart the timer on it.
  setAutoFetch: (minutes: number) => void;
  // Leave the dialog for one of the Config view's tabs.
  openConfig: (tab: "git" | "dotfiles") => void;
}

interface Section {
  title: string;
  render: () => HTMLElement[];
}

// Each card previews the theme's background and accent. "System" is split
// down the middle: it follows the OS between light and dark.
const THEMES: { choice: ThemeChoice; label: string; bg: string; accent: string }[] = [
  { choice: "system", label: "System", bg: "linear-gradient(135deg, #f7f8fa 50%, #0f1117 50%)", accent: "#5b8cff" },
  { choice: "light", label: "Light", bg: "#f7f8fa", accent: "#2f6bff" },
  { choice: "dark", label: "Dark", bg: "#0f1117", accent: "#5b8cff" },
  { choice: "gitkraken", label: "GitKraken", bg: "#11151c", accent: "#00d2d3" },
  { choice: "gitkraken-neon", label: "GitKraken Neon", bg: "#11151c", accent: "#f368e0" },
];

const DETAIL_TABS: { tab: DetailTab; label: string }[] = [
  { tab: "changes", label: "Changes" },
  { tab: "commit", label: "Commit" },
  { tab: "tree", label: "Tree" },
];

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function closeSettingsDialog(): void {
  overlay?.remove();
  overlay = null;
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = null;
}

export function openSettingsDialog(actions: SettingsActions): void {
  closeSettingsDialog();

  const sections: Section[] = [
    { title: "Appearance", render: () => [row("Theme", themeCards(actions), "block")] },
    {
      title: "Pull",
      render: () => [
        row("Pull button runs", pullSelect(), "inline", "The Pull caret still offers every method."),
        row(
          "Auto-fetch",
          autoFetchSelect(actions),
          "inline",
          "Fetches all remotes of the open repository in the background. Opening History or Local Changes fetches either way.",
        ),
      ],
    },
    {
      title: "History",
      render: () => [
        row(
          "Branches in the log",
          segToggle(
            [
              { value: true, label: "All branches" },
              { value: false, label: "Current" },
            ],
            actions.allBranches(),
            actions.setAllBranches,
          ),
        ),
        row(
          "Commit details open on",
          segToggle(
            DETAIL_TABS.map((t) => ({ value: t.tab, label: t.label })),
            loadDetailTab(),
            saveDetailTab,
          ),
          "inline",
          "Used at the next launch. Switching tabs in the details pane also changes it.",
        ),
      ],
    },
    {
      title: "Git",
      render: () => [
        row("Git configuration", linkButton("Open Git Config", () => actions.openConfig("git"))),
        row("Dotfiles", linkButton("Open Dotfiles", () => actions.openConfig("dotfiles"))),
      ],
    },
  ];

  overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal settings-modal", role: "dialog", "aria-label": "Settings" });
  overlay.append(modal);
  document.body.append(overlay);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeSettingsDialog();
  });

  const nav = el("nav", { class: "settings-nav" });
  const body = el("div", { class: "settings-body" });
  const show = (i: number) => {
    for (const [j, b] of [...nav.children].entries()) b.classList.toggle("active", i === j);
    body.replaceChildren(el("div", { class: "settings-heading", text: sections[i].title }), ...sections[i].render());
  };
  sections.forEach((s, i) => {
    const b = el("button", { class: "settings-nav-item", text: s.title });
    b.addEventListener("click", () => show(i));
    nav.append(b);
  });
  show(0);

  const done = el("button", { class: "btn", text: "Done" });
  done.addEventListener("click", closeSettingsDialog);
  modal.append(
    el("div", { class: "modal-title", text: "Settings" }),
    el("div", { class: "settings-layout" }, [nav, body]),
    el("div", { class: "modal-actions" }, [done]),
  );

  onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeSettingsDialog();
  };
  document.addEventListener("keydown", onKey, true);
  requestAnimationFrame(() => (nav.firstElementChild as HTMLElement | null)?.focus());
}

// A label (and optional hint) with its control beside it, or below it when the
// control is too wide to share the line.
function row(label: string, control: HTMLElement, layout: "inline" | "block" = "inline", hint?: string): HTMLElement {
  const text = el("div", { class: "settings-row-text" }, [el("div", { class: "settings-row-label", text: label })]);
  if (hint) text.append(el("div", { class: "settings-row-hint", text: hint }));
  return el("div", { class: `settings-row ${layout}` }, [text, control]);
}

function themeCards(actions: SettingsActions): HTMLElement {
  const grid = el("div", { class: "theme-cards", role: "radiogroup", "aria-label": "Theme" });
  const mark = () => {
    const cur = currentTheme();
    for (const c of grid.querySelectorAll<HTMLElement>(".theme-card")) {
      const on = c.dataset.themeChoice === cur;
      c.classList.toggle("active", on);
      c.setAttribute("aria-checked", String(on));
    }
  };
  for (const t of THEMES) {
    const swatch = el("span", { class: "theme-swatch" }, [el("span", { class: "theme-swatch-accent" })]);
    swatch.style.background = t.bg;
    (swatch.firstElementChild as HTMLElement).style.background = t.accent;
    const card = el("button", { class: "theme-card", role: "radio", "data-theme-choice": t.choice }, [
      swatch,
      el("span", { class: "theme-card-label", text: t.label }),
    ]);
    card.addEventListener("click", () => {
      actions.setTheme(t.choice);
      mark();
    });
    grid.append(card);
  }
  mark();
  return grid;
}

function pullSelect(): HTMLElement {
  const select = el("select", { class: "settings-select" });
  for (const mode of PULL_DEFAULTS) select.append(el("option", { value: mode, text: PULL_DEFAULT_LABEL[mode] }));
  select.value = loadPullDefault();
  select.addEventListener("change", () => savePullDefault(select.value as PullDefault));
  return select;
}

function autoFetchSelect(actions: SettingsActions): HTMLElement {
  const select = el("select", { class: "settings-select" });
  for (const m of AUTO_FETCH_MINUTES) {
    const label = m === 0 ? "Off" : m === 1 ? "Every minute" : `Every ${m} minutes`;
    select.append(el("option", { value: String(m), text: label }));
  }
  select.value = String(loadAutoFetchMinutes());
  select.addEventListener("change", () => actions.setAutoFetch(Number(select.value)));
  return select;
}

function segToggle<T>(options: { value: T; label: string }[], current: T, onChange: (v: T) => void): HTMLElement {
  const group = el("div", { class: "seg-toggle", role: "group" });
  for (const o of options) {
    const b = el("button", { class: o.value === current ? "seg active" : "seg", text: o.label });
    b.addEventListener("click", () => {
      for (const s of group.children) s.classList.toggle("active", s === b);
      onChange(o.value);
    });
    group.append(b);
  }
  return group;
}

function linkButton(label: string, onClick: () => void): HTMLElement {
  const b = el("button", { class: "btn ghost small", text: label });
  b.addEventListener("click", onClick);
  return b;
}
