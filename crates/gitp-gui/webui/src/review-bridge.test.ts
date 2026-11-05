// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import BRIDGE from "./review-bridge.js?raw";

// A review page as the review skill renders it, before the bridge runs.
function page(): void {
  document.body.innerHTML = `
    <h2>Since the last review</h2>
    <table><thead><tr><th>Finding</th><th>Round</th><th>Result</th><th>Where</th></tr></thead><tbody>
      <tr><td>f1 save of the full case</td><td>1</td><td>✅ fixed</td><td>f462530752</td></tr>
      <tr><td>f2 Q&amp;A on Confluence</td><td>1</td><td>⏳ open</td><td>Confluence</td></tr>
    </tbody></table>
    <h2>Suggested Changes</h2>
    <h3>a.java:1</h3><div class="fx-bar"><button>Explain more</button></div>
    <h3>b.java:2</h3><div class="fx-bar"><button>Explain more</button></div>
    <a id="out" href="https://github.com/o/r/pull/7">#7</a>`;
}

// The bridge listens on the window, so it runs once, on one page.
const posted = vi.fn();
beforeAll(() => {
  page();
  vi.spyOn(window.parent, "postMessage").mockImplementation(posted);
  // A page script, run as the page runs it.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function(BRIDGE) as () => void)();
});

describe("the review page bridge", () => {
  it("marks the findings the last review table says are fixed", () => {
    const bars = document.querySelectorAll(".fx-bar");
    expect(bars[0].querySelector(".gitp-fixed")?.textContent).toBe("✓ Fixed");
    expect(bars[1].querySelector(".gitp-fixed")).toBeNull();
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ gitpReview: true, kind: "ready" }), "*");
  });

  it("asks gitp to explain a finding, and to open links, instead of copying a line", () => {
    const second = document.querySelectorAll<HTMLButtonElement>(".fx-bar button")[1];
    const pageOwn = vi.fn();
    second.addEventListener("click", pageOwn);
    second.click();
    expect(pageOwn).not.toHaveBeenCalled();
    expect(posted).toHaveBeenCalledWith({ gitpReview: true, kind: "explain", finding: "f2" }, "*");
    document.getElementById("out")!.click();
    expect(posted).toHaveBeenCalledWith({ gitpReview: true, kind: "open", url: "https://github.com/o/r/pull/7" }, "*");
  });

  it("shows which findings are being explained, and why one failed", () => {
    window.dispatchEvent(
      new MessageEvent("message", { source: window.parent, data: { gitpReview: true, running: ["f2"], failed: { f1: "exit code 1" } } }),
    );
    const bars = document.querySelectorAll(".fx-bar");
    const second = bars[1].querySelector("button")!;
    expect([second.textContent, second.disabled]).toEqual(["Explaining…", true]);
    expect(bars[0].querySelector(".gitp-failed")?.textContent).toBe("Couldn't explain: exit code 1");
  });
});
