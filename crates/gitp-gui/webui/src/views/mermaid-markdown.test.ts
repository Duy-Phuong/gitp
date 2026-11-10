// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { renderMarkdownWithMermaid, splitMermaid } from "./mermaid-markdown";

const md = "Before.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nBetween.\n\n```js\nlet a = 1;\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n";

it("takes the mermaid blocks out, and only them", () => {
  const { text, diagrams } = splitMermaid(md);
  expect(diagrams).toEqual(["flowchart LR\n  A --> B", "sequenceDiagram\n  A->>B: hi"]);
  expect(text).toContain("GITP-MERMAID-0");
  expect(text).toContain("```js\nlet a = 1;\n```");
  expect(text).not.toContain("flowchart");
});

it("puts a diagram block where each was, showing its source until it is drawn", () => {
  const root = renderMarkdownWithMermaid(md);
  const blocks = [...root.querySelectorAll(".mermaid-diagram")];
  expect(blocks.map((b) => b.querySelector("code")?.textContent)).toEqual(["flowchart LR\n  A --> B", "sequenceDiagram\n  A->>B: hi"]);
  expect(root.textContent).not.toContain("GITP-MERMAID");
  expect([...root.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Before.", "Between."]);
  const plain = [...root.querySelectorAll("pre")].filter((p) => !p.closest(".mermaid-diagram"));
  expect(plain.map((p) => p.textContent)).toEqual(["let a = 1;\n"]);
});
