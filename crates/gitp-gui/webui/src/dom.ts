// Tiny DOM helpers to keep view code declarative.

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(tag: string, attrs: Attrs = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== false) node.setAttribute(k, String(v));
  }
  return node;
}

function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
}

export function clear(node: Element): void {
  node.replaceChildren();
}

// A rounded down-pointing chevron for collapsible sections/folders. Points down
// as-is; callers rotate it (via a CSS class) to point right when collapsed.
// Grow a text input's width to fit its current value, remeasured on each
// keystroke. The CSS min-width/max-width bound it, so a long branch/file name
// stays fully visible instead of scrolling inside a fixed field.
export function autoGrowInput(input: HTMLInputElement): void {
  const fit = () => {
    input.style.width = "0px"; // clamped up to CSS min-width; lets scrollWidth remeasure
    input.style.width = `${input.scrollWidth + 2}px`;
  };
  input.addEventListener("input", fit);
  requestAnimationFrame(fit);
}

// Grow a textarea's height to fit its content as the user types, up to `maxPx`
// (after which it scrolls). Keeps a long commit description fully visible.
export function autoGrowTextarea(area: HTMLTextAreaElement, maxPx = 320): void {
  const fit = () => {
    area.style.height = "auto";
    area.style.height = `${Math.min(maxPx, area.scrollHeight)}px`;
  };
  area.addEventListener("input", fit);
  requestAnimationFrame(fit);
}

export function chevronIcon(): SVGElement {
  const s = svg("svg", { viewBox: "0 0 16 16", class: "chevron-icon" });
  s.appendChild(
    svg("path", {
      d: "M4 6l4 4 4-4",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  return s;
}

// A small tag/label glyph, colored via `currentColor` so it inherits the chip's
// text color. Used on tag ref chips in the commit log.
export function tagIcon(): SVGElement {
  const s = svg("svg", { viewBox: "0 0 16 16", class: "tag-icon" });
  s.appendChild(
    svg("path", {
      d: "M7.6 1.8H2.6a.8.8 0 0 0-.8.8v5a.8.8 0 0 0 .24.57l6 6a.8.8 0 0 0 1.13 0l5-5a.8.8 0 0 0 0-1.13l-6-6a.8.8 0 0 0-.57-.24Z",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.2",
      "stroke-linejoin": "round",
    }),
  );
  s.appendChild(svg("circle", { cx: "5", cy: "5", r: "1", fill: "currentColor" }));
  return s;
}
