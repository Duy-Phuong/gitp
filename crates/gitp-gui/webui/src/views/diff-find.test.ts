// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { closeDiffFind, openDiffFind } from "./diff-find";

const marks = () => [...document.querySelectorAll<HTMLElement>("mark.find-hit")];
const type = (text: string) => {
  const input = document.querySelector<HTMLInputElement>(".diff-find-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const key = (k: string, shift = false) =>
  document.querySelector<HTMLInputElement>(".diff-find-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));

function diff(): HTMLElement {
  const body = document.createElement("div");
  body.className = "staging-diff-body";
  body.innerHTML =
    '<div class="diff-line"><span class="hljs-keyword">return</span> count<span class="hljs-punct">;</span></div>' +
    '<div class="diff-line add">int <span>cou</span>nt = 1;</div>' +
    '<div class="diff-line">nothing here</div>';
  document.body.append(body);
  return body;
}

afterEach(() => {
  closeDiffFind();
  document.body.innerHTML = "";
});

describe("openDiffFind", () => {
  it("marks every match, across syntax spans, case-insensitively", () => {
    const body = diff();
    openDiffFind(() => body);
    type("COUNT");
    expect(marks().map((m) => m.textContent)).toEqual(["count", "cou", "nt"]);
    expect(document.querySelector(".diff-find-count")!.textContent).toBe("1 of 2");
    expect(marks()[0].classList.contains("current")).toBe(true);
  });

  it("Enter and Shift+Enter step through the matches, wrapping", () => {
    const body = diff();
    openDiffFind(() => body);
    type("count");
    key("Enter");
    expect(marks().map((m) => m.classList.contains("current"))).toEqual([false, true, true]);
    key("Enter");
    expect(marks()[0].classList.contains("current")).toBe(true);
    key("Enter", true);
    expect(document.querySelector(".diff-find-count")!.textContent).toBe("2 of 2");
  });

  it("Escape closes and leaves the lines as they were", () => {
    const body = diff();
    const before = body.innerHTML;
    openDiffFind(() => body);
    type("count");
    key("Escape");
    expect(document.querySelector(".diff-find")).toBeNull();
    expect(marks()).toEqual([]);
    expect(body.innerHTML).toBe(before);
  });

  it("puts the marks back after the diff is rendered again", async () => {
    const body = diff();
    openDiffFind(() => body);
    type("count");
    body.innerHTML = '<div class="diff-line">count me</div>';
    await new Promise((r) => setTimeout(r, 0));
    expect(marks().map((m) => m.textContent)).toEqual(["count"]);
  });
});
