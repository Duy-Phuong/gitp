// The Claude jobs list's plain logic: what a row says, how long a job ran,
// and how its tokens read. The views are in views/claude-jobs.ts.

import type { ClaudeJob, ClaudeUsage } from "./api";

export const usageTotal = (u: ClaudeUsage): number => u.input + u.cache_creation + u.cache_read + u.output;

// 950, 1.2k, 182k, 1.4M.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// 9s, 4m 12s, 1h 03m.
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// How long a job has run: its earlier turns, and the current one up to now
// while it runs (or up to its end).
export function jobElapsed(job: ClaudeJob, now: number): number {
  const end = job.state === "running" ? now : (job.ended ?? job.turn_started);
  return job.spent + Math.max(0, end - job.turn_started);
}

// "Check · OrderService.java:88 · #3426", or the label alone.
export function jobTitle(job: ClaudeJob): string {
  return job.activity ? `${job.activity} · ${job.label}` : job.label;
}

// The folder name of a repository path.
export function repoName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
const shortDate = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

// "Today", "Yesterday", or the date: "Wed, 4 Nov".
export function dayTitle(ms: number, now: number, date: (ms: number) => string = shortDate): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date(ms);
}

export interface JobDay {
  title: string;
  jobs: ClaudeJob[];
}

// Running first, then the rest by the day of their last turn; newest first
// within each.
export function groupJobs(jobs: ClaudeJob[], now: number = Date.now()): { running: ClaudeJob[]; days: JobDay[] } {
  const newest = [...jobs].sort((a, b) => b.turn_started - a.turn_started);
  const days: JobDay[] = [];
  for (const job of newest.filter((j) => j.state !== "running")) {
    const title = dayTitle(job.turn_started, now);
    const last = days[days.length - 1];
    if (last?.title === title) last.jobs.push(job);
    else days.push({ title, jobs: [job] });
  }
  return { running: newest.filter((j) => j.state === "running"), days };
}

// "2 running · 3 finished today · 9 earlier this week".
export function jobsSummary(jobs: ClaudeJob[], now: number = Date.now()): string {
  const { running, days } = groupJobs(jobs, now);
  const today = days.find((d) => d.title === "Today")?.jobs.length ?? 0;
  const earlier = days.reduce((n, d) => n + d.jobs.length, 0) - today;
  const parts = [];
  if (running.length) parts.push(`${running.length} running`);
  if (today) parts.push(`${today} finished today`);
  if (earlier) parts.push(`${earlier} earlier this week`);
  return parts.join(" · ") || "No Claude jobs in the last 7 days";
}

// The meta line's token part: "182k tokens · in 170k (cache 160k) · out 12k".
export function tokensDetail(u: ClaudeUsage): string {
  const input = u.input + u.cache_creation + u.cache_read;
  return `${formatTokens(usageTotal(u))} tokens · in ${formatTokens(input)} (cache ${formatTokens(u.cache_read + u.cache_creation)}) · out ${formatTokens(u.output)}`;
}

// The line a finished job ends on, when it didn't simply finish.
export function endNote(job: ClaudeJob, time: (ms: number) => string): string | null {
  switch (job.state) {
    case "stopped":
      return `Stopped by you at ${time(job.ended ?? job.turn_started)}.`;
    case "interrupted":
      return "Interrupted: gitp quit while this ran.";
    case "failed":
      return job.error || "It failed.";
    default:
      return null;
  }
}

// Whether a scrolled box is at (or within a few pixels of) its bottom, so
// new steps should keep it there.
export function atBottom(box: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}
