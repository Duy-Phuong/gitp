// Syntax highlighting for the diffs and the blame view (Settings → Editor &
// Diff), with highlight.js: its core here, and the languages in
// highlight-languages.ts, registered on first use — the full bundle carries ~190.
//
// Highlighting works on text, not on DOM. The language comes from the file
// name; a block of lines is highlighted as one text, so a comment or string
// that spans lines is coloured right; and the HTML highlight.js returns is
// flattened into runs of (text, class) cut at the line breaks. The diff
// renderers lay those runs over the word-diff segments, so each line keeps the
// one element with `data-line` that line selection and staging go by — token
// spans only ever appear inside its code text.

import hljs from "highlight.js/lib/core";

import type { Seg } from "./worddiff";

// The languages highlight-languages.ts registers, by the name highlight.js
// knows them under.
type Language =
  | "bash"
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "diff"
  | "dockerfile"
  | "go"
  | "ini"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "makefile"
  | "markdown"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "scss"
  | "sql"
  | "swift"
  | "typescript"
  | "xml"
  | "yaml";

let languagesLoading: Promise<void> | null = null;

/// Load and register the languages (one chunk, fetched once). Diffs drawn
/// before this settles are plain; the caller redraws them when it does.
export function ensureLanguages(): Promise<void> {
  languagesLoading ??= import("./highlight-languages").then((m) => m.registerAll());
  return languagesLoading;
}


const BY_EXTENSION: Record<string, Language> = {
  sh: "bash", bash: "bash", zsh: "bash",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp",
  css: "css", scss: "scss",
  diff: "diff", patch: "diff",
  go: "go",
  ini: "ini", toml: "ini", cfg: "ini", conf: "ini", properties: "ini",
  java: "java",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json",
  kt: "kotlin", kts: "kotlin",
  mk: "makefile",
  md: "markdown", markdown: "markdown",
  php: "php",
  py: "python", pyi: "python",
  rb: "ruby",
  rs: "rust",
  sql: "sql",
  swift: "swift",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", plist: "xml", vue: "xml",
  yml: "yaml", yaml: "yaml",
};

// Files known by their whole name rather than an extension.
const BY_NAME: Record<string, Language> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
};

// The language to highlight `path` as, or null for a file gitp has none for
// (it is then shown plain).
export function languageFor(path: string): Language | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

// A piece of highlighted text and highlight.js's class for it ("" for text
// outside any token).
export interface Run {
  text: string;
  cls: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

// highlight.js's output — text with the five entities above escaped, inside
// nested `<span class="…">` — as runs. A run takes its innermost span's class:
// a string inside a template's `meta` is coloured as a string.
export function parseHighlighted(html: string): Run[] {
  const runs: Run[] = [];
  const open: string[] = [];
  for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    if (m[1] !== undefined) open.push(m[1]);
    else if (m[0] === "</span>") open.pop();
    else runs.push({ text: m[0].replace(/&(?:amp|lt|gt|quot|#x27);/g, (e) => ENTITIES[e]), cls: open[open.length - 1] ?? "" });
  }
  return runs;
}

// Runs cut at each "\n" into one list per line (the breaks themselves
// dropped): n breaks give n + 1 lines, an empty line an empty list.
export function splitLines(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const r of runs) {
    r.text.split("\n").forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: r.cls });
    });
  }
  return lines;
}

// Characters one file may spend on highlighting. A diff is capped at 5,000
// lines, but "Show full diff" lifts that, and highlighting a generated file of
// megabytes would stall the pane; past the budget the rest is shown plain.
export const MAX_HIGHLIGHT_CHARS = 400_000;
// A block with a line longer than this is shown plain. highlight.js's time
// grows with the square of a token's length — a 4,000-character base64 string
// takes ~40ms, 300,000 characters minutes — and such lines are minified or
// generated, not read.
export const MAX_HIGHLIGHT_LINE = 1000;

// Highlights blocks of `path`'s lines, each block as one text, for as long as
// the file's budget lasts (null after, and for a block with an overlong
// line). Null when the file has no language.
export type Highlighter = (lines: string[]) => Run[][] | null;

export function highlighter(path: string): Highlighter | null {
  const language = languageFor(path);
  if (!language || !hljs.getLanguage(language)) return null;
  let budget = MAX_HIGHLIGHT_CHARS;
  return (lines) => {
    if (lines.some((l) => l.length > MAX_HIGHLIGHT_LINE)) return null;
    const text = lines.join("\n");
    budget -= text.length;
    if (budget < 0) return null;
    return splitLines(parseHighlighted(hljs.highlight(text, { language, ignoreIllegals: true }).value));
  };
}

// Runs for a diff hunk's lines, keyed by the line's index in the hunk. The old
// side (context and deletions) and the new side (context and additions) are
// each highlighted as one text, so every line is read with what came before it
// in its own version. The "\ No newline" markers get nothing.
export function hunkRuns(lines: { origin: string; content: string }[], hl: Highlighter): Map<number, Run[]> {
  const out = new Map<number, Run[]>();
  const side = (keep: (origin: string) => boolean) => {
    const idx = lines.flatMap((l, i) => (keep(l.origin) ? [i] : []));
    const runs = hl(idx.map((i) => lines[i].content));
    if (runs) idx.forEach((i, k) => out.set(i, runs[k]));
  };
  // Context lines are in both, so deletions read in context; they keep the
  // new side's runs, set last.
  side((o) => o === "-" || o === " ");
  side((o) => o === "+" || o === " ");
  return out;
}

// `runs` (one line's) cut at the boundaries of the word-diff segments `segs`
// covering the same text, so each segment can be wrapped in its change mark
// with the token spans inside it.
export function overlay(runs: Run[], segs: Seg[]): { seg: Seg; runs: Run[] }[] {
  const out: { seg: Seg; runs: Run[] }[] = [];
  let r = 0; // current run
  let used = 0; // characters of runs[r] already placed
  for (const seg of segs) {
    const pieces: Run[] = [];
    let need = seg.text.length;
    while (need > 0 && r < runs.length) {
      const take = Math.min(need, runs[r].text.length - used);
      pieces.push({ text: runs[r].text.slice(used, used + take), cls: runs[r].cls });
      need -= take;
      used += take;
      if (used === runs[r].text.length) {
        r++;
        used = 0;
      }
    }
    out.push({ seg, runs: pieces });
  }
  return out;
}
