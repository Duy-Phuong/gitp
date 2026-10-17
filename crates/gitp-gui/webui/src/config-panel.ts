// The Config view: the git config editor and the Dotfiles panel.

import {
  confirmDialog,
  fetchConfig,
  DOTFILE_DISPLAY_PATH,
  readDotfile,
  writeDotfile,
  saveConfig,
} from "./api";
import { $ } from "./dom";
import { renderConfig } from "./views/config";
import { renderDotfiles } from "./views/dotfiles";
import type { ConfigScope, DotfileKind } from "./types";
import { opFailed, reportDone, setStatus } from "./report";

// Which sub-view the Config tab shows: the structured git key/value editor,
// or the raw ~/.gitconfig + ~/.tigrc panel.
let configTab: "git" | "dotfiles" = "git";

export function setConfigTab(tab: "git" | "dotfiles"): void {
  configTab = tab;
  $("#config-seg-git").classList.toggle("active", tab === "git");
  $("#config-seg-dotfiles").classList.toggle("active", tab === "dotfiles");
}

export async function refreshConfig(): Promise<void> {
  if (configTab === "dotfiles") return refreshDotfiles();
  const entries = await fetchConfig();
  renderConfig($("#config-editor"), entries, handleConfigSave);
}

async function handleConfigSave(scope: ConfigScope, name: string, value: string): Promise<void> {
  try {
    await saveConfig(scope, name, value);
    setStatus(`Saved ${name} (${scope})`);
    await refreshConfig();
  } catch (err) {
    opFailed(`Failed to save ${name}`, err);
  }
}

const DOTFILE_KINDS: DotfileKind[] = ["GitConfig", "Tigrc"];

async function refreshDotfiles(): Promise<void> {
  const files = await Promise.all(
    DOTFILE_KINDS.map(async (kind) => ({
      kind,
      path: DOTFILE_DISPLAY_PATH[kind],
      content: await readDotfile(kind),
    })),
  );
  renderDotfiles($("#config-editor"), files, {
    confirm: confirmDialog,
    save: async (kind, content) => {
      await writeDotfile(kind, content);
      setStatus(`Saved ${DOTFILE_DISPLAY_PATH[kind]}.`);
    },
    reportDone,
    reportError: opFailed,
    reload: refreshDotfiles,
  });
}

// The Git Config / Dotfiles segmented control at the top of the Config view.
export function setupConfigTabs(): void {
  $("#config-seg-git").addEventListener("click", () => {
    if (configTab === "git") return;
    setConfigTab("git");
    void refreshConfig();
  });
  $("#config-seg-dotfiles").addEventListener("click", () => {
    if (configTab === "dotfiles") return;
    setConfigTab("dotfiles");
    void refreshConfig();
  });
}
