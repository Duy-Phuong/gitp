// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { renderGitHubMarkdown } from "./github-markdown";

const render = (src: string) => renderGitHubMarkdown(src);

describe("renderGitHubMarkdown", () => {
  it("renders the HTML a pull request body mixes with Markdown, not its tags", () => {
    const out = render(
      [
        "Updates `undici` from 6.28.1 to 6.29.1",
        "<details>",
        "<summary>Release notes</summary>",
        '<p><em>Sourced from <a href="https://github.com/nodejs/undici/releases">undici\'s releases</a>.</em></p>',
        "<blockquote>",
        "<h2>v6.29.1</h2>",
        "<ul><li>fix(fetch): fix aborting Streams</li></ul>",
        "</blockquote>",
        "</details>",
      ].join("\n"),
    );
    expect(out.textContent).not.toContain("<");
    expect(out.querySelector("p code")?.textContent).toBe("undici");
    expect(out.querySelector("details > summary")?.textContent).toBe("Release notes");
    expect(out.querySelector("details blockquote h2")?.textContent).toBe("v6.29.1");
    expect(out.querySelector("blockquote li")?.textContent).toBe("fix(fetch): fix aborting Streams");
  });

  it("renders GitHub's Markdown: tables, task lists, strikethrough, line breaks", () => {
    const out = render("| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~old~~ new\nnext line");
    expect([...out.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["a", "b"]);
    expect(out.querySelectorAll("td")[1].getAttribute("align")).toBe("center");
    const boxes = [...out.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(out.querySelector("del")?.textContent).toBe("old");
    expect(out.querySelector("br")).not.toBeNull();
  });

  it("drops scripts, styles, frames and event handlers, keeping harmless text", () => {
    const out = render(
      '<script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe>' +
        '<p onclick="alert(2)" style="color:red" class="x">kept <b onmouseover="alert(3)">bold</b></p>' +
        "<form><button>Go</button></form><!-- a comment -->",
    );
    expect(out.querySelector("script, style, iframe, form, button")).toBeNull();
    expect(out.textContent).not.toContain("alert");
    expect(out.textContent).not.toContain("a comment");
    const p = out.querySelector("p")!;
    expect(p.textContent).toBe("kept bold");
    expect(p.attributes.length).toBe(0);
    expect(p.querySelector("b")!.attributes.length).toBe(0);
  });

  it("keeps an https link's address for the app to open, but never as an href", () => {
    const out = render(
      "[docs](https://example.com/a) [mail](mailto:a@b.c) [bad](javascript:alert(1)) <a href=\"data:text/html,x\">data</a>",
    );
    const links = [...out.querySelectorAll<HTMLElement>(".markdown-link")];
    expect(links.map((l) => [l.textContent, l.dataset.href ?? null])).toEqual([
      ["docs", "https://example.com/a"],
      ["mail", null],
      ["bad", null],
      ["data", null],
    ]);
    expect(out.querySelector("[href]")).toBeNull();
  });

  it("shows an image as its description: the app loads no images from the web", () => {
    const out = render("[![Dependabot compatibility score](https://badges.example/x.svg)](https://example.com/c)");
    expect(out.querySelector("img")).toBeNull();
    const link = out.querySelector<HTMLElement>(".markdown-link")!;
    expect(link.dataset.href).toBe("https://example.com/c");
    expect(link.textContent).toBe("Dependabot compatibility score");
  });
});
