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

// Copy `text` to the clipboard, falling back to a hidden textarea for webviews
// where the async clipboard API is unavailable.
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
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

// The GitHub mark, colored via `currentColor`. Marks remote-tracking ref chips
// (origin/…) in the commit log so they read as remote branches.
export function githubIcon(): SVGElement {
  const s = svg("svg", { viewBox: "0 0 24 24", class: "remote-icon" });
  s.appendChild(
    svg("path", {
      fill: "currentColor",
      d:
        "M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58" +
        " 0-.29-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.73.08-.73" +
        " 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93" +
        " 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016 0c2.29-1.55 3.3-1.23" +
        " 3.3-1.23.66 1.65.24 2.87.12 3.17.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22" +
        " 0 1.6-.01 2.89-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0024 12.5C24 5.87 18.63.5 12 .5z",
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
