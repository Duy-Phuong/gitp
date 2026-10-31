// GitHub-flavoured Markdown for pull request descriptions and comments, which
// mix Markdown with HTML (Dependabot's release notes are <details> blocks of
// it). `marked` turns it into HTML as GitHub would — tables, task lists,
// strikethrough, a newline as a line break — and only what an allowlist names
// is rebuilt from that, as fresh nodes: the text is someone else's, so no
// script, style, event handler or attribute of theirs reaches the page.
//
// A link keeps its web address in `data-href` rather than an href — clicked,
// an href would take the app's own window there — and the view opens it in
// the browser (see the pull request view). Images aren't loaded from the web
// (the app's CSP allows none); their description stands in for them.

import { marked } from "marked";

import { el } from "../dom";

// Rebuilt as they are, with none of their attributes but those below.
const KEEP = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s",
  "code", "pre", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "details", "summary", "sup", "sub", "kbd", "dl", "dt", "dd",
]);

// Dropped with everything in them. Any other tag is unwrapped: its content
// stays, the tag goes.
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "form", "button",
  "textarea", "select", "option", "svg", "math", "noscript", "template", "link", "meta",
  "base", "title", "head", "audio", "video", "canvas",
]);

// What the app will open: the backend opens https pages and nothing else.
const SAFE_URL = /^https:\/\//i;

export function renderGitHubMarkdown(src: string): HTMLElement {
  const html = marked.parse(src, { gfm: true, breaks: true, async: false });
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = el("div", { class: "markdown-preview github-markdown" });
  copyAllowed(doc.body, root);
  return root;
}

function copyAllowed(from: Node, to: Node): void {
  for (const child of from.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      to.appendChild(document.createTextNode(child.textContent ?? ""));
      continue;
    }
    // Comments and the like are left out.
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const source = child as Element;
    const tag = source.tagName.toLowerCase();
    if (DROP.has(tag)) continue;
    const made = rebuild(source, tag);
    if (made === null) {
      copyAllowed(source, to);
      continue;
    }
    to.appendChild(made);
    if (tag !== "img" && tag !== "input") copyAllowed(source, made);
  }
}

// The allowed element standing in for `source`, empty; `null` to unwrap it.
function rebuild(source: Element, tag: string): HTMLElement | null {
  if (tag === "a") {
    const href = source.getAttribute("href")?.trim() ?? "";
    const link = el("span", { class: "markdown-link" });
    if (SAFE_URL.test(href)) {
      link.dataset.href = href;
      link.title = href;
    }
    return link;
  }
  if (tag === "img") {
    const alt = source.getAttribute("alt")?.trim();
    return alt ? el("span", { class: "markdown-image", text: alt }) : null;
  }
  // A task list's box, shown and never editable.
  if (tag === "input") {
    if (source.getAttribute("type") !== "checkbox") return null;
    const box = el("input", { type: "checkbox" });
    box.checked = source.hasAttribute("checked");
    box.disabled = true;
    return box;
  }
  if (!KEEP.has(tag)) return null;
  const node = document.createElement(tag);
  const align = source.getAttribute("align");
  if ((tag === "th" || tag === "td") && align && /^(left|center|right)$/.test(align)) node.setAttribute("align", align);
  const start = source.getAttribute("start");
  if (tag === "ol" && start && /^\d{1,6}$/.test(start)) node.setAttribute("start", start);
  if (tag === "details" && source.hasAttribute("open")) node.setAttribute("open", "");
  return node;
}
