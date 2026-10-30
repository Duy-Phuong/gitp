// Which remotes a branch can be pushed to, the default first.

// The default is where a push without a remote goes, and where the branch's
// pull request is opened: the remote it tracks, else origin, else the only
// remote there is. An upstream that isn't a configured remote (a local branch,
// tracked as ".") doesn't count. With no remotes at all it's still "origin",
// so git's own error says what's missing.
export function pushTargets(upstreamRemote: string | null | undefined, remotes: string[]): string[] {
  let first = "origin";
  if (upstreamRemote && remotes.includes(upstreamRemote)) first = upstreamRemote;
  else if (remotes.length === 1) first = remotes[0];
  return [first, ...remotes.filter((r) => r !== first)];
}
