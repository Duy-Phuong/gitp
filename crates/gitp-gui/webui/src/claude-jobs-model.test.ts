import { describe, expect, it } from "vitest";
import type { ClaudeJob } from "./api";
import { atBottom, endNote, formatElapsed, formatTokens, groupJobs, jobElapsed, jobsSummary, jobTitle, repoName, tokensDetail } from "./claude-jobs-model";

const usage = { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
const job = (j: Partial<ClaudeJob>): ClaudeJob => ({
  id: 1,
  kind: "review",
  label: "Generate Drafts · #7",
  activity: "",
  repo: "/src/app",
  pr: 7,
  thread: null,
  finding: null,
  state: "running",
  started: 1000,
  ended: null,
  turn_started: 1000,
  spent: 0,
  turns: 1,
  error: null,
  command: "claude -p",
  stdin_bytes: 0,
  output: null,
  sessions: [],
  tokens: usage,
  turn_tokens: usage,
  ...j,
});

describe("the Claude jobs list", () => {
  it("reads tokens and time short", () => {
    expect([950, 1200, 9_999, 182_400, 1_400_000].map(formatTokens)).toEqual(["950", "1.2k", "10k", "182k", "1.4M"]);
    expect([9_400, 252_000, 3_780_000].map(formatElapsed)).toEqual(["9s", "4m 12s", "1h 03m"]);
    expect(tokensDetail({ input: 4, cache_creation: 1000, cache_read: 169_000, output: 12_000 })).toBe(
      "182k tokens · in 170k (cache 170k) · out 12k",
    );
  });

  it("counts a thread's earlier turns and the running one up to now", () => {
    expect(jobElapsed(job({ turn_started: 1000, spent: 5000 }), 4000)).toBe(8000);
    expect(jobElapsed(job({ state: "done", turn_started: 1000, ended: 3000, spent: 5000 }), 99_000)).toBe(7000);
  });

  it("puts running jobs first, newest first, and says how many", () => {
    const jobs = [
      job({ id: 1, state: "done", turn_started: 5 }),
      job({ id: 2, state: "running", turn_started: 1 }),
      job({ id: 3, state: "failed", turn_started: 9 }),
      job({ id: 4, state: "running", turn_started: 3 }),
    ];
    const g = groupJobs(jobs);
    expect(g.running.map((j) => j.id)).toEqual([4, 2]);
    expect(g.today.map((j) => j.id)).toEqual([3, 1]);
    expect(jobsSummary(jobs)).toBe("2 running · 2 finished today");
    expect(jobsSummary([])).toBe("No Claude jobs today");
  });

  it("names a thread job by what it does now", () => {
    expect(jobTitle(job({ activity: "Check", label: "Order.java:88 · #7" }))).toBe("Check · Order.java:88 · #7");
    expect(jobTitle(job({}))).toBe("Generate Drafts · #7");
    expect(repoName("/Users/me/src/mideal/")).toBe("mideal");
  });

  it("ends a stopped, interrupted or failed job with a note", () => {
    const time = () => "10:47";
    expect(endNote(job({ state: "stopped", ended: 5 }), time)).toBe("Stopped by you at 10:47.");
    expect(endNote(job({ state: "interrupted" }), time)).toBe("Interrupted: gitp quit while this ran.");
    expect(endNote(job({ state: "failed", error: "exit 2" }), time)).toBe("exit 2");
    expect(endNote(job({ state: "done" }), time)).toBeNull();
  });

  it("follows the run only while scrolled to the bottom", () => {
    expect(atBottom({ scrollTop: 980, scrollHeight: 1500, clientHeight: 500 })).toBe(true);
    expect(atBottom({ scrollTop: 600, scrollHeight: 1500, clientHeight: 500 })).toBe(false);
  });
});
