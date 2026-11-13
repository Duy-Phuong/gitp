import { describe, expect, it } from "vitest";

import { DRAFT_KEYS, draftKeyText } from "../shortcuts";
import { sheetRows } from "./shortcuts-dialog";

describe("sheetRows", () => {
  it("lists the Code keys and every Drafts tab key, from the one table", () => {
    const groups = sheetRows(true);
    expect(groups.map((g) => g.group)).toContain("Code");
    const drafts = groups.find((g) => g.group === "Pull request drafts")!;
    expect(drafts.rows).toEqual(DRAFT_KEYS.map((k) => ({ label: k.label, keys: draftKeyText(k) })));
    expect(drafts.rows[0]).toEqual({ label: "Next draft", keys: "J or ↓" });
  });
});
