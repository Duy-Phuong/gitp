// A minimal Markdown preview for the file editor: headings, paragraphs, lists,
// fenced code, inline code, emphasis, and links shown as text. Not CommonMark —
// enough to read a README while writing it.
//
// The file is the user's (or a cloned repo's) text, so it never goes through
// innerHTML: parseMarkdown produces plain data and renderMarkdown builds DOM
// nodes from it, with every piece of the file as a text node. A link isn't
// followed either — its target is only its tooltip.

import { el } from "../dom";

export type Inline =
  | { kind: "text" | "code" | "em" | "strong"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split("\n");
  // The paragraph or list still taking lines.
  let para: string[] | null = null;
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para) blocks.push({ kind: "paragraph", inlines: parseInline(para.join(" ")) });
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    para = null;
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      // Closed by the same kind of fence, at least as long; an unclosed one
      // runs to the end of the file, as in CommonMark.
      const marker = fence[1];
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = FENCE.exec(lines[i]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
        body.push(lines[i]);
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, inlines: parseInline(heading[2]) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(item[2]);
      continue;
    }
    // A line that is neither continues the open list item, or a paragraph.
    if (list) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else (para ??= []).push(line.trim());
  }
  flush();
  return blocks;
}

// `code`, **strong** / __strong__, *em* / _em_, and [text](href). Underscores
// only count at word edges, so snake_case_names stay as they are.
const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)|\[([^\]]+)\]\(([^)\s]*)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ kind: "strong", text: m[2] ?? m[3] });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ kind: "em", text: m[4] ?? m[5] });
    else out.push({ kind: "link", text: m[6], href: m[7] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function renderMarkdown(src: string): HTMLElement {
  const root = el("div", { class: "markdown-preview" });
  for (const b of parseMarkdown(src)) {
    switch (b.kind) {
      case "heading":
        root.append(el(`h${b.level}` as "h1", {}, inlineNodes(b.inlines)));
        break;
      case "paragraph":
        root.append(el("p", {}, inlineNodes(b.inlines)));
        break;
      case "list":
        root.append(el(b.ordered ? "ol" : "ul", {}, b.items.map((item) => el("li", {}, inlineNodes(item)))));
        break;
      case "code":
        root.append(el("pre", {}, [el("code", { text: b.text })]));
        break;
    }
  }
  return root;
}

function inlineNodes(inlines: Inline[]): Node[] {
  return inlines.map((i) => {
    switch (i.kind) {
      case "text":
        return document.createTextNode(i.text);
      case "code":
        return el("code", { text: i.text });
      case "strong":
        return el("strong", { text: i.text });
      case "em":
        return el("em", { text: i.text });
      case "link":
        return el("span", { class: "markdown-link", text: i.text, title: i.href });
    }
  });
}
