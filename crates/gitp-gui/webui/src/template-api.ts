// Config-template commands: export ~/.gitconfig + ~/.tigrc as one JSON file,
// or apply such a file to this machine. Kept out of api.ts so the Dotfiles
// view owns its own IPC surface. Like `browseForRepo`, the native file dialog
// runs here in the webview via plugin-dialog; only the chosen path crosses
// IPC, and the home side is always resolved in Rust.

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./api";

export interface ApplyTemplateResult {
  written: string[];
  backups: string[];
}

const TEMPLATE_FILTER = [{ name: "gitp template", extensions: ["json"] }];

// Save dialog, then export. Resolves to the written path, or null if the user
// cancelled (or we're outside Tauri, where there's no picker).
export async function exportConfigTemplate(): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    title: "Export config template",
    defaultPath: "gitp-template.json",
    filters: TEMPLATE_FILTER,
  });
  if (typeof dest !== "string") return null;
  await invoke("export_config_template", { dest });
  return dest;
}

// Open dialog only — the caller confirms with the user before `applyConfigTemplate`,
// so the two steps are separate. Null when cancelled or outside Tauri.
export async function pickConfigTemplate(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const src = await open({
    title: "Apply config template",
    multiple: false,
    directory: false,
    filters: TEMPLATE_FILTER,
  });
  return typeof src === "string" ? src : null;
}

export async function applyConfigTemplate(src: string): Promise<ApplyTemplateResult> {
  if (!isTauri()) return { written: [], backups: [] };
  return invoke<ApplyTemplateResult>("apply_config_template", { src });
}
