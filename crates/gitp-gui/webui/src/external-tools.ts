// Opening a file in the user's external diff / merge tool (`git difftool` /
// `git mergetool`). The tool is whatever diff.tool / merge.tool says; when
// none is set, explain how to set one and offer the Git Config view.

import { openDiffTool, openMergeTool } from "./api";
import { setConfigTab } from "./config-panel";
import { opFailed, setStatus } from "./report";
import { showView } from "./shell";
import type { DiffToolTarget } from "./types";

const openGitConfig = {
  label: "Open Git Config",
  run: () => {
    setConfigTab("git");
    showView("config");
  },
};

export async function openInDiffTool(target: DiffToolTarget, paths: string[]): Promise<void> {
  try {
    if (await openDiffTool(target, paths)) {
      setStatus("Opened in the external diff tool.");
      return;
    }
    opFailed(
      "No external diff tool configured",
      "git difftool uses the diff.tool setting, which isn't set. Set it to your tool's name " +
        "(e.g. bc, kaleidoscope, p4merge, meld, vscode) in Git Config, or run\n\n" +
        "    git config --global diff.tool <name>",
      openGitConfig,
    );
  } catch (err) {
    opFailed("External diff tool failed", err);
  }
}

// When the tool reports success, git marks the file resolved; the conflict
// view then picks that up from disk like any other change.
export async function openInMergeTool(path: string): Promise<void> {
  try {
    if (await openMergeTool(path)) {
      setStatus(`Opened ${path} in the merge tool.`);
      return;
    }
    opFailed(
      "No merge tool configured",
      "git mergetool uses the merge.tool setting, which isn't set. Set it to your tool's name " +
        "(e.g. bc, kaleidoscope, p4merge, meld, vscode) in Git Config, or run\n\n" +
        "    git config --global merge.tool <name>",
      openGitConfig,
    );
  } catch (err) {
    opFailed("Merge tool failed", err);
  }
}
