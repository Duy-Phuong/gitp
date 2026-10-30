// How every date in gitp reads: compact "how long ago" labels ("just now",
// "2m ago", "3h ago", "5d ago"), and formatTime, which shows a commit's or a
// tag's date in the format chosen in Settings.
//
// Lives on its own because many places show the same instants — the log, the
// commit details, file history, the reflog, tags, the status bar's fetch age —
// and a second, slightly different formatter would have them disagree.

import { loadDateFormat, type DateFormat } from "./prefs";

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

// `unixSeconds` in `format` (Settings → Appearance by default): relativeTime,
// "2026-10-30 14:05" in local time, or the locale's short date and time.
export function formatTime(unixSeconds: number, format: DateFormat = loadDateFormat()): string {
  if (format === "relative") return relativeTime(unixSeconds);
  const d = new Date(unixSeconds * 1000);
  if (format === "locale") return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The full date and time, for a tooltip: a relative date alone hides when.
export function fullTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}
