// Runs inside a saved review page shown in gitp (added after the page's own
// scripts, so its findings already have their "Explain more" bars). The page
// is in a sandboxed frame with no clipboard and no way out, so:
// - "Explain more" asks gitp to run the explanation, instead of copying a
//   line for the chat;
// - links open in the browser, through gitp;
// - each finding the "Since the last review" table marks ✅ gets a ✓ Fixed.
// gitp answers with which findings are being explained.
(() => {
  const post = (msg) => parent.postMessage({ gitpReview: true, ...msg }, "*");
  const bars = [...document.querySelectorAll(".fx-bar")];
  // The page numbers its findings f1, f2, … in this order, as the board does.
  const idOf = (bar) => "f" + (bars.indexOf(bar) + 1);

  const style = document.createElement("style");
  style.textContent = `
    .gitp-fixed { display: inline-flex; align-items: center; gap: .25rem; margin-right: .5rem; padding: .05rem .5rem;
      border-radius: 999px; font-size: .8rem; font-weight: 600; color: #1a7f37; background: rgba(26,127,55,.12); }
    @media (prefers-color-scheme: dark) { .gitp-fixed { color: #56d364; background: rgba(86,211,100,.15); } }
    .fx-bar button[disabled] { opacity: .7; cursor: progress; }
    .gitp-failed { color: #cf222e; font-size: .85rem; }`;
  document.head.append(style);

  // "f1 save of the full case | 1 | ✅ fixed | f462530752, `X.java:117`"
  const since = [...document.querySelectorAll("h2")].find((h) => /since the last review/i.test(h.textContent));
  let table = since?.nextElementSibling;
  while (table && table.tagName !== "TABLE" && table.tagName !== "H2") table = table.nextElementSibling;
  const fixed = new Map();
  if (table?.tagName === "TABLE") {
    for (const row of table.querySelectorAll("tbody tr")) {
      const cells = [...row.cells].map((c) => c.textContent.trim());
      const id = /^(f\d+)\b/.exec(cells[0] ?? "")?.[1];
      if (id && cells.slice(1).some((c) => c.includes("✅"))) fixed.set(id, cells.slice(2).join(" · "));
    }
  }
  for (const bar of bars) {
    const note = fixed.get(idOf(bar));
    if (note === undefined) continue;
    const badge = document.createElement("span");
    badge.className = "gitp-fixed";
    badge.textContent = "✓ Fixed";
    badge.title = note;
    bar.prepend(badge);
  }

  addEventListener(
    "click",
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const button = target?.closest(".fx-bar button");
      if (button) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!button.disabled) post({ kind: "explain", finding: idOf(button.closest(".fx-bar")) });
        return;
      }
      const link = target?.closest("a[href]");
      if (link && /^https:\/\//.test(link.href)) {
        e.preventDefault();
        post({ kind: "open", url: link.href });
      }
    },
    true,
  );

  // { running: ["f3"], failed: { f2: "why" }, scrollTo: "f3" }
  addEventListener("message", (e) => {
    const msg = e.data;
    if (e.source !== parent || !msg || !msg.gitpReview) return;
    bars.forEach((bar) => {
      const id = idOf(bar);
      const button = bar.querySelector("button");
      if (!button) return;
      const running = (msg.running ?? []).includes(id);
      button.disabled = running;
      button.textContent = running ? "Explaining…" : "Explain more";
      bar.querySelector(".gitp-failed")?.remove();
      const failed = msg.failed?.[id];
      if (failed) {
        const why = document.createElement("span");
        why.className = "gitp-failed";
        why.textContent = "Couldn't explain: " + failed;
        bar.append(why);
      }
    });
    if (msg.scrollTo) {
      const bar = bars[Number(msg.scrollTo.slice(1)) - 1];
      // The new explanation is the last block of the finding, just below.
      bar?.scrollIntoView({ block: "start" });
    }
  });
  post({ kind: "ready" });
})();
