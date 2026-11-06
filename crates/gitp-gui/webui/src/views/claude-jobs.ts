// The Claude jobs list and the conversation of the selected job — one view,
// used twice: on the full page (#claude-view) and in the bottom panel. The
// controller (claude-jobs.ts) feeds both the jobs and each job's steps.

import type { ClaudeEvent, ClaudeJob } from "../api";
import { atBottom, endNote, formatElapsed, formatTokens, groupJobs, jobElapsed, jobTitle, repoName, tokensDetail, usageTotal } from "../claude-jobs-model";
import { clear, el } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";

export interface ConversationData {
  events: ClaudeEvent[];
  found: boolean;
}

export interface ClaudeJobsCallbacks {
  select: (id: number) => void;
  stop: (job: ClaudeJob) => void;
  openThread: (job: ClaudeJob) => void;
  // The whole input and output of a cut tool call.
  full: (job: ClaudeJob, tool: string) => Promise<{ input: string; output: string }>;
}

export interface ClaudeJobsView {
  // Draw the list, and the conversation of `selected` with its steps so far.
  render(jobs: ClaudeJob[], selected: number | null, data: ConversationData | null, openRepo: string): void;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function setupClaudeJobsView(root: HTMLElement, cb: ClaudeJobsCallbacks): ClaudeJobsView {
  const list = el("div", { class: "cj-list", role: "listbox", "aria-label": "Claude jobs" });
  const detail = el("div", { class: "cj-detail" });
  root.append(list, detail);

  // What the conversation shows now, so new steps are appended, not redrawn.
  let shownJob: number | null = null;
  let shownCount = 0;
  let shownState = "";
  let shownOutput: string | null = null;
  let head: HTMLElement | null = null;
  let body: HTMLElement | null = null;
  let tail: HTMLElement | null = null;
  const toolRows = new Map<string, HTMLElement>();
  let firstPromptSeen = false;
  let earlierMarked = false;

  function renderList(jobs: ClaudeJob[], selected: number | null, openRepo: string): void {
    const keep = list.scrollTop;
    clear(list);
    const { running, today } = groupJobs(jobs);
    const now = Date.now();
    const section = (title: string, rows: ClaudeJob[]) => {
      if (!rows.length) return;
      list.append(el("div", { class: "cj-section" }, [title]));
      for (const job of rows) {
        const row = el("div", {
          class: `cj-row${job.id === selected ? " selected" : ""}`,
          role: "option",
          "aria-selected": job.id === selected,
          tabindex: 0,
          title: jobTitle(job),
        });
        const name = el("span", { class: "cj-row-title" }, [jobTitle(job)]);
        if (job.repo !== openRepo) name.append(el("span", { class: "cj-row-repo" }, [repoName(job.repo)]));
        row.append(
          el("span", { class: `cj-dot ${job.state}`, title: job.state }),
          name,
          el("span", { class: "cj-num" }, [formatElapsed(jobElapsed(job, now))]),
          el("span", { class: "cj-num" }, [formatTokens(usageTotal(job.tokens))]),
        );
        row.addEventListener("click", () => cb.select(job.id));
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            cb.select(job.id);
          }
        });
        list.append(row);
      }
    };
    section("Running", running);
    section("Today", today);
    if (!jobs.length) list.append(el("div", { class: "cj-empty" }, ["No Claude jobs today. Reviews, Explain more and the turns on pull request threads show here while they run."]));
    list.scrollTop = keep;
  }

  function renderHead(job: ClaudeJob, openRepo: string): void {
    if (!head) return;
    clear(head);
    const actions = el("span", { class: "cj-actions" });
    if (job.state === "running") {
      const stop = el("button", { class: "btn cj-stop", type: "button", title: "Stop this run" }, ["Stop"]);
      stop.addEventListener("click", () => cb.stop(job));
      actions.append(stop);
    }
    const open = el(
      "button",
      { class: "btn ghost", type: "button", title: job.repo === openRepo ? "" : `In ${repoName(job.repo)}` },
      [job.kind === "thread" ? "Open thread ↗" : "Open pull request ↗"],
    );
    open.addEventListener("click", () => cb.openThread(job));
    actions.append(open);
    const meta = [repoName(job.repo), job.ended && job.state !== "running" ? `${time(job.started)} → ${time(job.ended)}` : `started ${time(job.started)}`];
    meta.push(`${job.state === "running" ? "running" : job.state} ${formatElapsed(jobElapsed(job, Date.now()))}`);
    if (job.turns > 1) meta.push(`${job.turns} turns today`);
    meta.push(tokensDetail(job.tokens));
    if (job.kind === "thread" && job.state === "running" && job.turns > 1) meta.push(`this turn ${formatTokens(usageTotal(job.turn_tokens))}`);
    head.append(
      el("div", { class: "cj-head-line" }, [el("span", { class: "cj-head-title" }, [jobTitle(job)]), actions]),
      el("div", { class: "cj-meta" }, [meta.join(" · ")]),
    );
  }

  function startConversation(job: ClaudeJob, openRepo: string): void {
    clear(detail);
    toolRows.clear();
    firstPromptSeen = false;
    earlierMarked = false;
    head = el("div", { class: "cj-head" });
    body = el("div", { class: "cj-body" });
    tail = el("div", { class: "cj-tail" });
    body.append(commandBlock(job), tail);
    detail.append(head, body);
    renderHead(job, openRepo);
    shownJob = job.id;
    shownCount = 0;
    shownState = "";
    shownOutput = null;
  }

  // "Show the full command": the shell line and what went on its stdin.
  function commandBlock(job: ClaudeJob): HTMLElement {
    const box = el("details", { class: "cj-command" });
    box.append(
      el("summary", {}, ["Show the full command"]),
      el("pre", { class: "cj-pre" }, [job.command || "(none)"]),
    );
    if (job.stdin_bytes) box.append(el("div", { class: "cj-note" }, [`Its stdin: ${formatTokens(job.stdin_bytes)} bytes.`]));
    return box;
  }

  function append(job: ClaudeJob, events: ClaudeEvent[]): void {
    if (!body || !tail) return;
    for (const e of events) {
      if (job.kind === "thread" && e.at < job.started && !earlierMarked) {
        earlierMarked = true;
        body.insertBefore(el("div", { class: "cj-divider" }, ["Earlier, before today"]), tail);
      }
      if (job.kind === "thread" && earlierMarked && e.at >= job.started && body.querySelector(".cj-divider.today") === null) {
        body.insertBefore(el("div", { class: "cj-divider today" }, ["Today"]), tail);
      }
      const node = eventNode(job, e);
      if (!node) continue;
      if (e.at < job.started) node.classList.add("earlier");
      body.insertBefore(node, tail);
    }
  }

  function eventNode(job: ClaudeJob, e: ClaudeEvent): HTMLElement | null {
    switch (e.kind) {
      case "prompt": {
        const first = !firstPromptSeen;
        firstPromptSeen = true;
        const box = el("div", { class: "cj-msg cj-prompt folded" });
        const who = el("div", { class: "cj-who" }, [first ? "Prompt gitp sent" : "Sent", el("span", { class: "cj-when" }, [time(e.at)])]);
        const text = el("div", { class: "cj-prompt-text" }, [e.text]);
        const more = el("button", { class: "cj-link", type: "button" }, ["Show all"]);
        more.addEventListener("click", () => {
          box.classList.toggle("folded");
          more.textContent = box.classList.contains("folded") ? "Show all" : "Fold";
        });
        box.append(who, text, more);
        return box;
      }
      case "text": {
        const box = el("div", { class: "cj-msg cj-claude" });
        const who = el("div", { class: "cj-who" }, ["Claude", el("span", { class: "cj-when" }, [time(e.at) + (e.tokens ? ` · ${formatTokens(e.tokens)}` : "")])]);
        box.append(who, renderGitHubMarkdown(e.text));
        return box;
      }
      case "thinking": {
        const label = `Thinking${e.tokens ? ` · ${formatTokens(e.tokens)} tokens` : ""}`;
        if (!e.text.trim()) return el("div", { class: "cj-thinking" }, [label]);
        const box = el("details", { class: "cj-thinking" });
        box.append(el("summary", {}, [label]), el("div", { class: "cj-thinking-text" }, [e.text]));
        return box;
      }
      case "tool": {
        const row = el("details", { class: "cj-tool running" });
        const summary = el("summary", { class: "cj-tool-head" }, [
          el("span", { class: "cj-tool-name" }, [e.name]),
          el("code", { class: "cj-tool-summary" }, [e.summary]),
          el("span", { class: "cj-tool-state" }, ["running…"]),
        ]);
        const input = el("pre", { class: "cj-pre cj-tool-input" }, [e.input]);
        row.append(summary, el("div", { class: "cj-label" }, ["Input"]), input);
        if (e.cut) row.append(showAll(job, e.id, input, "input", e.cut));
        toolRows.set(e.id, row);
        return row;
      }
      case "result": {
        const row = toolRows.get(e.tool_id);
        const output = el("pre", { class: "cj-pre cj-tool-output" }, [e.text || "(no output)"]);
        if (!row) {
          // A result without its call on the page: show it on its own.
          const box = el("div", { class: `cj-tool ${e.ok ? "ok" : "error"}` }, [el("div", { class: "cj-label" }, ["Output"]), output]);
          return box;
        }
        row.classList.remove("running");
        row.classList.add(e.ok ? "ok" : "error");
        const state = row.querySelector(".cj-tool-state");
        if (state) state.textContent = e.ok ? "✓" : "✗";
        row.append(el("div", { class: "cj-label" }, ["Output"]), output);
        if (e.cut) row.append(showAll(job, e.tool_id, output, "output", e.cut));
        return null;
      }
    }
  }

  function showAll(job: ClaudeJob, tool: string, into: HTMLElement, part: "input" | "output", size: number): HTMLElement {
    const btn = el("button", { class: "cj-link", type: "button" }, [`Cut at 4 KB of ${formatTokens(size)} bytes · show all`]);
    btn.addEventListener("click", () => {
      btn.disabled = true;
      void cb.full(job, tool).then(
        (full) => {
          into.textContent = full[part];
          btn.remove();
        },
        () => {
          btn.disabled = false;
          btn.textContent = "Couldn't read it · try again";
        },
      );
    });
    return btn;
  }

  // The end of the conversation: what happened, or what is going on.
  function renderTail(job: ClaudeJob, data: ConversationData): void {
    if (!tail || !body) return;
    clear(tail);
    // The last message of a finished run is its answer.
    for (const n of body.querySelectorAll(".cj-claude.final")) n.classList.remove("final");
    if (job.state === "done") {
      const all = body.querySelectorAll<HTMLElement>(".cj-claude");
      const last = all[all.length - 1];
      if (last) last.classList.add("final");
    }
    if (!data.found) {
      if (job.state === "running" && Date.now() - job.turn_started < 20_000) {
        tail.append(el("div", { class: "cj-live" }, [el("span", { class: "cj-dot running" }), "Starting…"]));
        return;
      }
      tail.append(
        el("div", { class: "cj-note" }, [
          job.sessions.length
            ? 'No conversation to show: this command doesn\'t pass --session-id "$GITP_CLAUDE_NEW_SESSION", or Claude Code no longer has the session.'
            : "No conversation to show.",
        ]),
      );
      if (job.output) tail.append(el("div", { class: "cj-msg cj-claude final" }, [el("div", { class: "cj-who" }, ["Output"]), renderGitHubMarkdown(job.output)]));
    }
    if (job.state === "running") {
      if (data.found) tail.append(el("div", { class: "cj-live" }, [el("span", { class: "cj-dot running" }), `Working · ${formatElapsed(jobElapsed(job, Date.now()))}`]));
      return;
    }
    const note = endNote(job, time);
    if (note) tail.append(el("div", { class: `cj-end ${job.state}` }, [note]));
  }

  return {
    render(jobs, selected, data, openRepo) {
      renderList(jobs, selected, openRepo);
      const job = jobs.find((j) => j.id === selected) ?? null;
      if (!job) {
        if (shownJob !== null || !detail.childElementCount) {
          clear(detail);
          detail.append(el("div", { class: "cj-placeholder" }, [jobs.length ? "Pick a job to see its conversation." : ""]));
          shownJob = null;
        }
        return;
      }
      // Fewer steps than shown: they were read again from the start.
      if (shownJob !== job.id || (data && data.events.length < shownCount)) startConversation(job, openRepo);
      else renderHead(job, openRepo);
      if (!data || !body) return;
      const follow = atBottom(body) || shownCount === 0;
      if (data.events.length > shownCount) {
        append(job, data.events.slice(shownCount));
        shownCount = data.events.length;
      }
      const state = `${job.state}|${data.found}|${job.state === "running" ? Math.floor(Date.now() / 1000) : ""}`;
      if (state !== shownState || job.output !== shownOutput) {
        renderTail(job, data);
        shownState = state;
        shownOutput = job.output;
      }
      if (follow) body.scrollTop = body.scrollHeight;
    },
  };
}
