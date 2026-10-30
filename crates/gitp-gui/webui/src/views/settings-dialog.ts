// The Settings dialog behind the top bar's gear.
//
// A sidebar of sections, each a list of labelled rows. Every control applies
// as soon as it changes — there is nothing to save — so Done only closes.
// A new setting is one more `row(...)` in the section it belongs to; a new
// section is one more entry in `sections`. Reuses the `.modal-overlay` /
// `.modal` shell.

import { el } from "../dom";
import {
  applyZoom,
  AUTO_FETCH_MINUTES,
  currentTheme,
  DATE_FORMATS,
  FONT_FAMILIES,
  FONT_SIZES,
  loadAuthorInitials,
  loadAutoFetchMinutes,
  loadAutoFetchPrune,
  loadBranchHoverFade,
  loadCodePrefs,
  loadDateFormat,
  loadDefaultBranch,
  loadDetailTab,
  loadPullDefault,
  loadSyntaxHighlight,
  loadTerminalFont,
  loadZoom,
  PULL_DEFAULT_LABEL,
  PULL_DEFAULTS,
  saveAuthorInitials,
  saveAutoFetchPrune,
  saveBranchHoverFade,
  saveCodePrefs,
  saveDateFormat,
  saveDefaultBranch,
  saveDetailTab,
  savePullDefault,
  saveSyntaxHighlight,
  saveTerminalFont,
  TAB_SIZES,
  type CodePrefs,
  type DateFormat,
  type PullDefault,
  type TerminalFont,
  type ThemeChoice,
  ZOOM_LEVELS,
} from "../prefs";
import type { DetailTab } from "./detail";
import type { GhAccount } from "../types";

export interface SettingsActions {
  // Apply and persist a theme, redrawing whatever CSS alone can't restyle.
  setTheme: (choice: ThemeChoice) => void;
  allBranches: () => boolean;
  setAllBranches: (all: boolean) => void;
  // Persist the auto-fetch interval (0 = off) and restart the timer on it.
  setAutoFetch: (minutes: number) => void;
  // Redraw what shows dates and author avatars, after either setting changes.
  redrawDisplay: () => void;
  // The open repo's local core.hooksPath ("" when unset), or null when no repo
  // is open; and writing it ("" unsets it).
  hooksPath: () => Promise<string | null>;
  setHooksPath: (path: string) => Promise<void>;
  browseFolder: (title: string) => Promise<string | null>;
  // Draw the diffs on screen again (syntax highlighting was switched).
  redrawDiffs: () => void;
  // The open repo's text encoding label (gitp.encoding, "utf-8" when unset),
  // or null when no repo is open; and setting it, which re-reads the diffs.
  encoding: () => Promise<string | null>;
  setEncoding: (label: string) => Promise<void>;
  // Leave the dialog for one of the Config view's tabs.
  openConfig: (tab: "git" | "dotfiles") => void;
  // The GitHub CLI's account (gitp signs in through gh and keeps no token),
  // and signing it in and out.
  githubAccount: () => Promise<GhAccount>;
  githubSignIn: () => Promise<void>;
  githubSignOut: () => Promise<void>;
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

// The encodings offered for a repo's files, by WHATWG label (what gitp-core's
// encoding.rs reads from gitp.encoding).
const ENCODINGS: { label: string; name: string }[] = [
  { label: "utf-8", name: "UTF-8" },
  { label: "utf-16le", name: "UTF-16 LE" },
  { label: "utf-16be", name: "UTF-16 BE" },
  { label: "windows-1252", name: "Western (Windows-1252)" },
  { label: "iso-8859-1", name: "Western (ISO-8859-1)" },
  { label: "shift_jis", name: "Japanese (Shift_JIS)" },
  { label: "euc-jp", name: "Japanese (EUC-JP)" },
  { label: "gbk", name: "Chinese Simplified (GBK)" },
  { label: "big5", name: "Chinese Traditional (Big5)" },
  { label: "euc-kr", name: "Korean (EUC-KR)" },
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
    {
      title: "Appearance",
      render: () => [
        row("Theme", themeCards(actions), "block"),
        row("Zoom", zoomSelect(), "inline", "Cmd/Ctrl + = and − step through these levels; Cmd/Ctrl + 0 goes back to 100%."),
        row(
          "Dates",
          dateFormatSelect(actions),
          "inline",
          "In the log, commit details, file history, the reflog and tags. Hover a date in the log or details for the full time.",
        ),
        row(
          "Commit graph shows",
          segToggle(
            [
              { value: false, label: "Avatars" },
              { value: true, label: "Initials" },
            ],
            loadAuthorInitials(),
            (on) => {
              saveAuthorInitials(on);
              actions.redrawDisplay();
            },
          ),
          "inline",
          "Avatars come from gravatar.com, which is sent a hash of each author's email; initials fetch nothing.",
        ),
      ],
    },
    {
      title: "Editor & Diff",
      render: () => {
        const code = loadCodePrefs();
        const setCode = (change: Partial<CodePrefs>) => saveCodePrefs({ ...loadCodePrefs(), ...change });
        const term = loadTerminalFont();
        const setTerm = (change: Partial<TerminalFont>) => saveTerminalFont({ ...loadTerminalFont(), ...change });
        return [
          row(
            "Syntax highlighting",
            segToggle(
              [
                { value: true, label: "On" },
                { value: false, label: "Off" },
              ],
              loadSyntaxHighlight(),
              (on) => {
                saveSyntaxHighlight(on);
                actions.redrawDiffs();
              },
            ),
            "inline",
            "Colours code by file type in diffs and the blame view.",
          ),
          row("Font", fontPicker(code.font, (font) => setCode({ font })), "block", "Diffs, blame and the file editor."),
          row("Font size", sizeSelect(code.size, (size) => setCode({ size }))),
          row(
            "Tab width",
            segToggle(
              TAB_SIZES.map((n) => ({ value: n, label: String(n) })),
              code.tabSize,
              (tabSize) => setCode({ tabSize }),
            ),
          ),
          row(
            "Line numbers in diffs",
            segToggle(
              [
                { value: true, label: "Show" },
                { value: false, label: "Hide" },
              ],
              code.lineNumbers,
              (lineNumbers) => setCode({ lineNumbers }),
            ),
          ),
          row("Terminal font", fontPicker(term.font, (font) => setTerm({ font })), "block"),
          row("Terminal font size", sizeSelect(term.size, (size) => setTerm({ size }))),
        ];
      },
    },
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
        row(
          "Prune on auto-fetch",
          segToggle(
            [
              { value: true, label: "On" },
              { value: false, label: "Off" },
            ],
            loadAutoFetchPrune(),
            saveAutoFetchPrune,
          ),
          "inline",
          "Background fetches drop remote-tracking branches deleted on the remote (fetch --prune). Fetch and Refresh always prune.",
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
        row(
          "Hovering a branch",
          segToggle(
            [
              { value: true, label: "Fades other commits" },
              { value: false, label: "Does nothing" },
            ],
            loadBranchHoverFade(),
            saveBranchHoverFade,
          ),
          "inline",
          "In the graph or the sidebar: the commits that aren't on the branch fade.",
        ),
      ],
    },
    {
      title: "Git",
      render: () => [
        row(
          "Hooks folder",
          hooksField(actions),
          "block",
          "core.hooksPath in the open repository's own config. Empty uses .git/hooks.",
        ),
        row("Default branch", defaultBranchField(), "inline", "The branch Init Repository starts a new repository on."),
        row(
          "Text encoding",
          encodingSelect(actions),
          "inline",
          "How the open repository's files are read and saved: diffs, blame, the file editor and the conflict resolver. Kept in its config as gitp.encoding. UTF-16 files stay binary in diffs, as git sees them.",
        ),
        row(
          "GitHub account",
          githubAccountField(actions),
          "inline",
          "Pull requests come through the GitHub CLI (gh), signed in as you. gitp stores no token.",
        ),
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

function zoomSelect(): HTMLElement {
  const select = el("select", { class: "settings-select" });
  for (const z of ZOOM_LEVELS) select.append(el("option", { value: String(z), text: `${Math.round(z * 100)}%` }));
  select.value = String(loadZoom());
  select.addEventListener("change", () => void applyZoom(Number(select.value)));
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

function dateFormatSelect(actions: SettingsActions): HTMLElement {
  const select = el("select", { class: "settings-select" });
  for (const f of DATE_FORMATS) select.append(el("option", { value: f.format, text: f.label }));
  select.value = loadDateFormat();
  select.addEventListener("change", () => {
    saveDateFormat(select.value as DateFormat);
    actions.redrawDisplay();
  });
  return select;
}

// Saved when it changes (Enter or leaving it); emptied, it goes back to "main".
function defaultBranchField(): HTMLElement {
  const input = el("input", {
    class: "settings-select",
    placeholder: "main",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Default branch",
  }) as HTMLInputElement;
  input.value = loadDefaultBranch();
  input.addEventListener("change", () => {
    saveDefaultBranch(input.value);
    input.value = loadDefaultBranch();
  });
  return input;
}

// A font family: the app's monospace, one of FONT_FAMILIES, or any other typed
// in as Custom (saved when the field changes).
function fontPicker(current: string, onChange: (font: string) => void): HTMLElement {
  const CUSTOM = "(custom)";
  const select = el("select", { class: "settings-select" }) as HTMLSelectElement;
  select.append(el("option", { value: "", text: "Default monospace" }));
  for (const f of FONT_FAMILIES) select.append(el("option", { value: f, text: f }));
  select.append(el("option", { value: CUSTOM, text: "Custom…" }));
  const custom = el("input", {
    class: "settings-select settings-path",
    placeholder: "Font family, e.g. Iosevka",
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;
  const preset = current === "" || FONT_FAMILIES.includes(current);
  select.value = preset ? current : CUSTOM;
  custom.value = preset ? "" : current;
  custom.hidden = preset;
  select.addEventListener("change", () => {
    custom.hidden = select.value !== CUSTOM;
    if (select.value === CUSTOM) custom.focus();
    else onChange(select.value);
  });
  custom.addEventListener("change", () => onChange(custom.value.trim()));
  return el("div", { class: "settings-path-row" }, [select, custom]);
}

function sizeSelect(current: number, onChange: (size: number) => void): HTMLElement {
  const select = el("select", { class: "settings-select" }) as HTMLSelectElement;
  for (const n of FONT_SIZES) select.append(el("option", { value: String(n), text: `${n} px` }));
  select.value = String(current);
  select.addEventListener("change", () => onChange(Number(select.value)));
  return select;
}

// The open repo's text encoding. Disabled until the current value has loaded,
// and when no repo is open. A label set by hand that isn't offered is shown as
// it is, so the list never claims UTF-8 for it.
function encodingSelect(actions: SettingsActions): HTMLElement {
  const select = el("select", { class: "settings-select", disabled: true }) as HTMLSelectElement;
  for (const e of ENCODINGS) select.append(el("option", { value: e.label, text: e.name }));
  select.addEventListener("change", () => void actions.setEncoding(select.value));
  void actions.encoding().then(
    (label) => {
      if (label === null) {
        select.title = "No repository open";
        return;
      }
      const known = ENCODINGS.find((e) => e.label === label.toLowerCase());
      if (!known) select.append(el("option", { value: label, text: label }));
      select.value = known?.label ?? label;
      select.disabled = false;
    },
    () => (select.title = "Couldn't read the repository's config"),
  );
  return select;
}

// The repo's hooks folder: a path field that saves when it changes (Enter or
// leaving it), and Browse. Disabled until the current value has loaded, and
// when no repo is open.
function hooksField(actions: SettingsActions): HTMLElement {
  const input = el("input", {
    class: "settings-select settings-path",
    placeholder: ".git/hooks",
    spellcheck: "false",
    autocomplete: "off",
    disabled: true,
  }) as HTMLInputElement;
  const browse = el("button", { class: "btn ghost small", text: "Browse…", disabled: true }) as HTMLButtonElement;
  let saved = "";
  const save = () => {
    const path = input.value.trim();
    if (path === saved) return;
    saved = path;
    void actions.setHooksPath(path);
  };
  input.addEventListener("change", save);
  browse.addEventListener("click", async () => {
    const dir = await actions.browseFolder("Hooks Folder");
    if (dir === null) return;
    input.value = dir;
    save();
  });
  void actions.hooksPath().then(
    (path) => {
      if (path === null) {
        input.placeholder = "No repository open";
        return;
      }
      saved = input.value = path;
      input.disabled = browse.disabled = false;
    },
    () => (input.placeholder = "Couldn't read the repository's config"),
  );
  return el("div", { class: "settings-path-row" }, [input, browse]);
}

// Who gh is signed in as, with Sign In or Sign Out — or how to install gh.
function githubAccountField(actions: SettingsActions): HTMLElement {
  const host = el("div", { class: "settings-gh-account" }, [el("span", { class: "settings-row-hint", text: "Checking…" })]);
  const show = (account: GhAccount) => {
    const action = (label: string, run: () => Promise<void>) =>
      linkButton(label, () => void run().then(() => actions.githubAccount().then(show, () => {})));
    if (!account.installed) {
      host.replaceChildren(el("span", { class: "settings-row-hint", text: "GitHub CLI not installed: brew install gh" }));
    } else if (account.signed_in) {
      host.replaceChildren(el("span", { text: account.login ?? "Signed in" }), action("Sign Out", actions.githubSignOut));
    } else {
      host.replaceChildren(el("span", { class: "settings-row-hint", text: "Not signed in" }), action("Sign In", actions.githubSignIn));
    }
  };
  actions.githubAccount().then(show, () => host.replaceChildren(el("span", { class: "settings-row-hint", text: "Couldn't ask gh" })));
  return host;
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
