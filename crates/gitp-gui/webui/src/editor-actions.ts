// The in-app file editor's entry points: Edit in gitp (Local Changes, Quick
// Launch's file picker) and Create File. The editor itself is
// views/file-editor.ts.

import { createFile, listWorkFiles, readTextFile, stage, writeTextFile } from "./api";
import { ui } from "./app-state";
import { opFailed, setStatus } from "./report";
import { loadSidebar } from "./shell";
import { openFileEditor } from "./views/file-editor";
import { openFormDialog } from "./views/form-dialog";
import type { QuickStage } from "./views/quick-launch";

export function editFileAction(path: string): void {
  void openFileEditor(path, {
    read: readTextFile,
    write: writeTextFile,
    stage,
    onSaved: (msg) => {
      setStatus(msg);
      void refreshAfterEdit();
    },
    reportError: opFailed,
  });
}

// Ask for a repo-relative path, create the file (and its folders), and open
// it in the editor. The backend refuses an existing file and anything outside
// the working tree.
export function createFileAction(): void {
  openFormDialog(
    {
      title: "Create File",
      sub: "Relative to the repository's top folder. Missing folders are created.",
      fields: [{ label: "Path", placeholder: "docs/notes.md", required: true }],
      submitLabel: "Create",
    },
    ([raw]) => void createAndEdit(raw.replace(/^(\.\/)+/, "")),
  );
}

async function createAndEdit(path: string): Promise<void> {
  try {
    await createFile(path);
  } catch (err) {
    opFailed("Create File failed", err);
    return;
  }
  setStatus(`Created ${path}.`);
  await refreshAfterEdit();
  editFileAction(path);
}

// Quick Launch's "Edit File…" picker: every tracked and untracked file of the
// working tree, not only the changed ones.
export async function editFileStage(): Promise<QuickStage> {
  const paths = await listWorkFiles();
  return {
    chip: "Edit File",
    placeholder: "file",
    emptyNote: "The working tree has no files.",
    sections: [
      {
        title: "Files",
        items: paths.map((path) => ({
          kind: "file" as const,
          label: path.split("/").pop() ?? path,
          detail: path,
          run: () => editFileAction(path),
        })),
      },
    ],
  };
}

// The sidebar snapshot carries the staging lists (to Local Changes) and the
// Undo label; the open diff is re-read too, since a second save to a file
// already listed as modified leaves its status as it was.
async function refreshAfterEdit(): Promise<void> {
  await loadSidebar();
  await ui.changesView?.recheckDiff();
}
