// The Claude jobs: the "Claude" button after PRs opens the full page, the
// status bar's "● N Claude jobs" chip opens the bottom panel, and both show
// the same list and the selected job's conversation. Polls the backend while
// gitp runs, reads a job's steps only while its conversation shows, and asks
// before a quit that would stop running jobs.

import {
  claudeJobEvents,
  claudeJobFull,
  claudeJobs,
  confirmDialog,
  isTauri,
  onQuitWithClaudeJobs,
  stopClaudeJob,
  stopClaudeJobsAndQuit,
  type ClaudeEvent,
  type ClaudeJob,
} from "./api";
import { state } from "./app-state";
import { jobsSummary, repoName } from "./claude-jobs-model";
import { $ } from "./dom";
import { setStatus } from "./report";
import { showPullRequest, showView, switchRepo } from "./shell";
import { setupClaudeJobsView, type ClaudeJobsView } from "./views/claude-jobs";

const POLL_MS = 1500;

interface Conversation {
  events: ClaudeEvent[];
  next: number;
  found: boolean;
  // The job's state at the last read: a run that just ended is read once more.
  readAs: string;
  // A new session merges by time, maybe before steps already read: read all again.
  sessions: number;
}

let jobs: ClaudeJob[] = [];
let selected: number | null = null;
const conversations = new Map<number, Conversation>();
let page: ClaudeJobsView | null = null;
let panel: ClaudeJobsView | null = null;

const pageShown = () => state.view === "claude";
const panelShown = () => !$("#claude-panel").classList.contains("hidden");

export function setupClaudeJobs(): void {
  const callbacks = {
    select: (id: number) => {
      selected = id;
      void tick();
    },
    stop: (job: ClaudeJob) => {
      void stopClaudeJob(job.id).then(() => {
        setStatus(`Stopping ${job.activity ? `${job.activity} · ` : ""}${job.label}…`);
        void tick();
      });
    },
    openThread: (job: ClaudeJob) => void openJobPlace(job),
    full: (job: ClaudeJob, tool: string) => claudeJobFull(job.id, tool),
  };
  page = setupClaudeJobsView($("#claude-jobs-page"), callbacks);
  panel = setupClaudeJobsView($("#claude-jobs-panel"), callbacks);

  $("#claude-btn").addEventListener("click", showClaudeJobsPage);
  $("#claude-back").addEventListener("click", () => showView("history"));
  $("#status-claude").addEventListener("click", toggleClaudePanel);
  $("#claude-panel-close").addEventListener("click", toggleClaudePanel);
  $("#claude-panel-full").addEventListener("click", () => {
    $("#claude-panel").classList.add("hidden");
    showClaudeJobsPage();
  });

  void onQuitWithClaudeJobs(async (labels) => {
    const which = labels.length <= 3 ? `\n\n${labels.map((l) => `• ${l}`).join("\n")}` : "";
    const n = labels.length;
    const message = `${n} Claude job${n === 1 ? " is" : "s are"} running. Stop ${n === 1 ? "it" : "them"} and quit?${which}`;
    if (await askStopAndQuit(message)) await stopClaudeJobsAndQuit();
  });

  void tick();
  setInterval(() => void tick(), POLL_MS);
}

export function showClaudeJobsPage(): void {
  showView("claude");
  void tick();
}

export function toggleClaudePanel(): void {
  $("#claude-panel").classList.toggle("hidden");
  void tick();
}

// "Stop and quit" or Cancel, in the native dialog when there is one.
async function askStopAndQuit(message: string): Promise<boolean> {
  if (!isTauri()) return confirmDialog(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title: "gitp", kind: "warning", okLabel: "Stop and quit", cancelLabel: "Cancel" });
}

// The pull request (and thread) the job belongs to, in its repository.
async function openJobPlace(job: ClaudeJob): Promise<void> {
  if (job.repo !== state.repoPath) {
    if (!state.repos.some((r) => r.path === job.repo)) {
      setStatus(`#${job.pr} is in ${repoName(job.repo)}, which isn't open in gitp.`);
      return;
    }
    await switchRepo(job.repo);
  }
  $("#claude-panel").classList.add("hidden");
  showPullRequest(job.pr);
}

let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    jobs = await claudeJobs();
    const running = jobs.filter((j) => j.state === "running").length;
    const badge = $("#claude-badge");
    badge.textContent = String(running);
    badge.classList.toggle("hidden", running === 0);
    const chip = $("#status-claude");
    chip.textContent = `● ${running} Claude job${running === 1 ? "" : "s"}`;
    chip.classList.toggle("hidden", running === 0);

    const summary = `${jobsSummary(jobs)} · all repositories`;
    $("#claude-summary").textContent = summary;
    $("#claude-panel-summary").textContent = jobsSummary(jobs);

    if (!pageShown() && !panelShown()) return;
    if (selected === null || !jobs.some((j) => j.id === selected)) {
      selected = (jobs.find((j) => j.state === "running") ?? jobs[0])?.id ?? null;
    }
    const job = jobs.find((j) => j.id === selected) ?? null;
    let data: Conversation | null = null;
    if (job) data = await readConversation(job);
    if (pageShown()) page?.render(jobs, selected, data, state.repoPath);
    if (panelShown()) panel?.render(jobs, selected, data, state.repoPath);
  } catch {
    // The next tick tries again; a failed read must not stop the poll.
  } finally {
    ticking = false;
  }
}

// The job's steps so far, reading only what was added since the last time.
async function readConversation(job: ClaudeJob): Promise<Conversation> {
  let c = conversations.get(job.id);
  if (!c) {
    c = { events: [], next: 0, found: false, readAs: "", sessions: job.sessions.length };
    conversations.set(job.id, c);
  }
  if (c.sessions !== job.sessions.length) {
    c.events = [];
    c.next = 0;
    c.sessions = job.sessions.length;
  }
  // A thread's new turn may add a session: read on while it runs, and once
  // more after each change of state.
  const readAs = `${job.state}|${job.turns}|${job.sessions.length}`;
  if (job.state === "running" || c.readAs !== readAs) {
    const page = await claudeJobEvents(job.id, c.next);
    c.events.push(...page.events);
    c.next = page.next;
    c.found = page.found;
    c.readAs = readAs;
  }
  return c;
}
