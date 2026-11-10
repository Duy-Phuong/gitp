// Markdown with its ```mermaid blocks drawn as diagrams, for the review's
// explanations of a finding (the review skill and /explain-simply draw their
// flows in Mermaid). The rest is GitHub Markdown as everywhere else. Mermaid
// is loaded the first time a diagram is drawn, so the app doesn't carry it
// until then; until it draws — or when the diagram doesn't parse — the
// block's source stays on screen.

import { el } from "../dom";
import { renderGitHubMarkdown } from "./github-markdown";

const FENCE = /^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
const MARK = /^GITP-MERMAID-(\d+)$/;

/// The Mermaid sources of `md`, and `md` with a placeholder line for each.
export function splitMermaid(md: string): { text: string; diagrams: string[] } {
  const diagrams: string[] = [];
  const text = md.replace(FENCE, (_, code: string) => {
    diagrams.push(code.trimEnd());
    return `\nGITP-MERMAID-${diagrams.length - 1}\n`;
  });
  return { text, diagrams };
}

export function renderMarkdownWithMermaid(md: string): HTMLElement {
  const { text, diagrams } = splitMermaid(md);
  const root = renderGitHubMarkdown(text);
  for (const p of root.querySelectorAll("p")) {
    const m = MARK.exec(p.textContent?.trim() ?? "");
    const code = m ? diagrams[Number(m[1])] : undefined;
    if (code === undefined) continue;
    const node = el("div", { class: "mermaid-diagram" }, [el("pre", {}, [el("code", { text: code })])]);
    p.replaceWith(node);
    void draw(node, code);
  }
  return root;
}

type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | null = null;
let drawn = 0;

function isDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme) return theme !== "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

async function draw(node: HTMLElement, code: string): Promise<void> {
  try {
    loading ??= import("mermaid").then((m) => m.default);
    const mermaid = await loading;
    // The text is a review's, not ours: strict keeps scripts and links out.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default" });
    const { svg } = await mermaid.render(`gitp-mermaid-${++drawn}`, code);
    node.innerHTML = svg;
    node.classList.add("drawn");
  } catch (err) {
    node.append(el("div", { class: "mermaid-error", text: `Couldn't draw this diagram: ${String(err).split("\n")[0]}` }));
  }
}
