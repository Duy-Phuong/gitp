// Compact "how long ago" labels: "just now", "2m ago", "3h ago", "5d ago".
//
// Lives on its own because two places need the same phrasing — the commit list's
// per-row age and the status bar's fetch age — and a second, slightly different
// formatter would have them disagree about the same instant.

const UNITS: [number, string][] = [
  [31536000, "y"],
  [2592000, "mo"],
  [604800, "w"],
  [86400, "d"],
  [3600, "h"],
  [60, "m"],
];

export function relativeTime(unixSeconds: number): string {
  const secondsAgo = Math.floor(Date.now() / 1000) - unixSeconds;
  for (const [size, label] of UNITS) {
    if (secondsAgo >= size) return `${Math.floor(secondsAgo / size)}${label} ago`;
  }
  return "just now";
}
