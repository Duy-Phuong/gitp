import { describe, expect, it } from "vitest";

import { searchLog } from "./api";

// Preview mode (no Tauri) searches the mock log, so the search box still
// behaves under plain `vite dev`.
describe("searchLog in preview mode", () => {
  const summaries = async (query: string) => (await searchLog(query, { all_branches: true, pinned: null, hidden: [], solo: [] })).map((r) => r.summary);

  it("ANDs bare words, and keeps quoted phrases whole", async () => {
    expect(await summaries("config fix")).toEqual(["fix: config loader precedence"]);
    expect(await summaries('"config loader"')).toEqual(["fix: config loader precedence", "feat: add config loader"]);
    expect(await summaries('"loader config"')).toEqual([]);
  });

  it("narrows by author and date, ignoring path: and content:", async () => {
    expect(await summaries("config author:d@example")).toEqual(["fix: config loader precedence"]);
    expect(await summaries("after:2023-11-18 path:src content:x")).toEqual([
      "Merge branch 'feature/widget'",
      "docs: expand config guide",
      "feat: add dashboard widget",
    ]);
    expect(await summaries("before:2023-11-16")).toEqual(["chore: initial layout", "chore: initial commit"]);
  });

  it("returns nothing for a blank query", async () => {
    expect(await searchLog("   ", { all_branches: true, pinned: null, hidden: [], solo: [] })).toEqual([]);
  });
});
