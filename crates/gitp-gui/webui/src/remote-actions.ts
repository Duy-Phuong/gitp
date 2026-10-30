// Configured remotes: the sidebar's Remotes header ("+", right-click) and each
// remote's own menu — add, edit the URL, rename, remove, fetch, copy the URL.

import { addRemote, confirmDialog, fetchRemote, removeRemote, renameRemote, setRemoteUrl } from "./api";
import { showContextMenu } from "./views/context-menu";
import { openFormDialog } from "./views/form-dialog";
import { state } from "./app-state";
import { opFailed, reportDone, setStatus } from "./report";
import { copyText } from "./clipboard";
import { loadSidebar } from "./shell";
import { runBranchOp } from "./ref-actions";

// Right-click the Remotes header.
export function onRemotesMenu(x: number, y: number): void {
  showContextMenu(x, y, [{ label: "Add Remote…", run: addRemoteAction }]);
}

// Add a remote: a name and a URL. Not fetched — that's one right-click away,
// and a URL typed wrong is better found out before the wait than during it.
export function addRemoteAction(): void {
  const first = state.remoteList.length === 0;
  openFormDialog(
    {
      title: "Add Remote",
      fields: [
        { label: "Name:", value: first ? "origin" : "", placeholder: "upstream", required: true },
        { label: "URL:", placeholder: "git@github.com:owner/repo.git", required: true },
      ],
      submitLabel: "Add Remote",
    },
    ([name, url]) => void runRemoteOp(`Adding remote ${name}`, () => addRemote(name, url)),
  );
}

// Right-click a remote's folder row in the sidebar.
export function onRemoteFolderMenu(remote: string, x: number, y: number): void {
  const url = state.remoteList.find((r) => r.name === remote)?.url ?? null;
  const configured = state.remoteList.some((r) => r.name === remote);
  // A remote known only from leftover tracking branches has no config to edit.
  if (!configured) {
    showContextMenu(x, y, [{ label: "Add Remote…", run: addRemoteAction }]);
    return;
  }
  showContextMenu(x, y, [
    {
      label: "Fetch",
      run: () => void runBranchOp(`Fetching ${remote}`, () => fetchRemote(remote), true, remote),
    },
    { separator: true },
    {
      label: "Edit URL…",
      prompt: {
        placeholder: "Remote URL",
        value: url ?? "",
        onSubmit: (next) => void runRemoteOp(`Changing ${remote}'s URL`, () => setRemoteUrl(remote, next)),
      },
    },
    {
      label: "Rename…",
      prompt: {
        placeholder: "New remote name",
        value: remote,
        onSubmit: (name) => {
          if (name !== remote) void runRemoteOp(`Renaming ${remote} to ${name}`, () => renameRemote(remote, name));
        },
      },
    },
    { label: "Remove…", danger: true, run: () => void removeRemoteAction(remote) },
    { separator: true },
    ...(url ? [{ label: "Copy URL", run: () => void copyText(url, `Copied ${url}`) }] : []),
    { label: "Add Remote…", run: addRemoteAction },
  ]);
}

async function removeRemoteAction(remote: string): Promise<void> {
  const ok = await confirmDialog(
    `Remove the remote ${remote}?\n\n` +
      `Its remote-tracking branches go too, and branches tracking it lose their upstream. ` +
      `Nothing on the remote itself is deleted.`,
  );
  if (!ok) {
    setStatus("Remove cancelled.");
    return;
  }
  await runRemoteOp(`Removing remote ${remote}`, () => removeRemote(remote));
}

// A remote config change: run it, then reload the sidebar. Renaming or
// removing moves remote-tracking branches, so the log's chips follow along
// with the sidebar refresh; the commits themselves don't change.
async function runRemoteOp(label: string, op: () => Promise<string>): Promise<void> {
  setStatus(`${label}…`);
  try {
    const out = (await op()).trim();
    await loadSidebar();
    reportDone(out || `${label} done.`);
  } catch (err) {
    opFailed(`${label} failed`, err);
  }
}
