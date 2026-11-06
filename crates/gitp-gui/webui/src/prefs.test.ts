import { beforeEach, describe, it, expect } from "vitest";
import {
  codeCssVars,
  fontStack,
  nextToggleTheme,
  parseTabAliases,
  parseCodeRecent,
  withCodeRecent,
  SKILL_REVIEW_COMMAND,
  DEFAULT_THREAD_COMMANDS,
  loadThreadCommand,
  saveThreadCommand,
  THREAD_TOOLS,
  steppedZoom,
  withFavoriteToggled,
  withTabAlias,
  ZOOM_LEVELS,
} from "./prefs";

describe("withFavoriteToggled", () => {
  it("stars a repo at the end, so earlier favorites keep their shortcut", () => {
    expect(withFavoriteToggled(["/a", "/b"], "/c")).toEqual(["/a", "/b", "/c"]);
  });

  it("unstars a starred repo and closes the gap", () => {
    expect(withFavoriteToggled(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
  });
});

describe("tab aliases", () => {
  it("names a tab and drops the name again", () => {
    const named = withTabAlias({}, "/a", "  Work  ");
    expect(named).toEqual({ "/a": "Work" });
    expect(withTabAlias(named, "/a", null)).toEqual({});
    expect(withTabAlias(named, "/a", "   "), "a blank name resets too").toEqual({});
  });

  it("leaves the other tabs' names alone", () => {
    expect(withTabAlias({ "/a": "A", "/b": "B" }, "/b", "Bee")).toEqual({ "/a": "A", "/b": "Bee" });
  });

  it("reads back only well-formed names", () => {
    expect(parseTabAliases(null)).toEqual({});
    expect(parseTabAliases("not json")).toEqual({});
    expect(parseTabAliases('["/a"]')).toEqual({});
    expect(parseTabAliases('{"/a":"A","/b":3}')).toEqual({ "/a": "A" });
  });
});

describe("steppedZoom", () => {
  it("walks the preset levels", () => {
    expect(steppedZoom(1, 1)).toBe(1.1);
    expect(steppedZoom(1.1, 1)).toBe(1.25);
    expect(steppedZoom(1, -1)).toBe(0.9);
    expect(steppedZoom(1.25, -1)).toBe(1.1);
  });

  it("stays put at either end", () => {
    expect(steppedZoom(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1)).toBe(2);
    expect(steppedZoom(ZOOM_LEVELS[0], -1)).toBe(0.8);
  });

  it("snaps an in-between level to the next preset", () => {
    expect(steppedZoom(1.05, 1)).toBe(1.1);
    expect(steppedZoom(1.05, -1)).toBe(1);
  });
});

describe("nextToggleTheme", () => {
  it("goes to Light from any dark theme", () => {
    expect(nextToggleTheme("dark", false, "dark")).toBe("light");
    expect(nextToggleTheme("gitkraken-neon", false, "gitkraken-neon")).toBe("light");
  });

  it("goes back from Light to the dark theme last chosen", () => {
    expect(nextToggleTheme("light", true, "gitkraken")).toBe("gitkraken");
  });

  it("reads System as whatever the OS is showing", () => {
    expect(nextToggleTheme("system", true, "dark")).toBe("light");
    expect(nextToggleTheme("system", false, "gitkraken")).toBe("gitkraken");
  });
});

describe("fontStack", () => {
  it("falls back to the given stack when no family is chosen", () => {
    expect(fontStack("  ", "var(--mono)")).toBe("var(--mono)");
  });

  it("quotes one family name with spaces and keeps the fallback after it", () => {
    expect(fontStack("JetBrains Mono", "var(--mono)")).toBe('"JetBrains Mono", var(--mono)');
    expect(fontStack("Menlo", "monospace")).toBe("Menlo, monospace");
  });

  it("uses a typed list or quoted name as written", () => {
    expect(fontStack("Iosevka Term, Menlo", "monospace")).toBe("Iosevka Term, Menlo, monospace");
    expect(fontStack("'Fira Code'", "monospace")).toBe("'Fira Code', monospace");
  });
});

describe("codeCssVars", () => {
  it("turns the Editor & Diff settings into the CSS variables styles.css reads", () => {
    expect(codeCssVars({ font: "Fira Code", size: 14, tabSize: 2, lineNumbers: false })).toEqual({
      "--code-font": '"Fira Code", var(--mono)',
      "--code-size": "14px",
      "--tab-size": "2",
    });
    expect(codeCssVars({ font: "", size: 12, tabSize: 4, lineNumbers: true })["--code-font"]).toBe("var(--mono)");
  });
});

describe("Code tab recent files", () => {
  it("parses only repo → list-of-paths entries", () => {
    expect(parseCodeRecent(null)).toEqual({});
    expect(parseCodeRecent("not json")).toEqual({});
    expect(parseCodeRecent('["/a"]')).toEqual({});
    expect(parseCodeRecent('{"/a":["x.ts",3,"y.ts"],"/b":"z"}')).toEqual({ "/a": ["x.ts", "y.ts"] });
  });

  it("sets one repo's list, keeps the others, and drops an empty one", () => {
    const all = { "/a": ["x.ts"], "/b": ["y.ts"] };
    expect(withCodeRecent(all, "/a", ["z.ts", "x.ts"])).toEqual({ "/a": ["z.ts", "x.ts"], "/b": ["y.ts"] });
    expect(withCodeRecent(all, "/b", [])).toEqual({ "/a": ["x.ts"] });
  });
});

describe("the review skill command", () => {
  it("gives the prompt before --allowedTools, which would swallow it", () => {
    const prompt = SKILL_REVIEW_COMMAND.indexOf('"/review-pr-phuong');
    expect(prompt).toBeGreaterThan(0);
    expect(prompt).toBeLessThan(SKILL_REVIEW_COMMAND.indexOf("--allowedTools"));
    expect(SKILL_REVIEW_COMMAND.trimEnd().endsWith('"'), "nothing after the tool list").toBe(true);
  });
});

describe("thread commands", () => {
  it("has a read-only tool list and resumes the session when one is set", () => {
    expect(THREAD_TOOLS).toContain("Read");
    expect(THREAD_TOOLS).toContain("Bash(gh pr view *)");
    const writes = THREAD_TOOLS.filter((t) => t.startsWith("Edit") || /mkdir|\brm |python3|curl|ArtifactData/.test(t));
    expect(writes).toEqual([]);
    for (const kind of ["check", "explain", "followup", "reply-draft"] as const) {
      const c = DEFAULT_THREAD_COMMANDS[kind];
      expect(c.startsWith('claude -p "'), kind).toBe(true);
      expect(c, kind).toContain("--output-format json");
      expect(c, kind).toContain('${GITP_CLAUDE_SESSION:+--resume "$GITP_CLAUDE_SESSION"}');
      expect(c, kind).toContain("$GITP_THREAD_FILE");
      // The prompt comes before --allowedTools, which would swallow it.
      expect(c.indexOf("$GITP_THREAD_FILE"), kind).toBeLessThan(c.indexOf("--allowedTools"));
    }
    expect(DEFAULT_THREAD_COMMANDS["reply-draft"]).toContain("@$GITP_GH_LOGIN");
    expect(DEFAULT_THREAD_COMMANDS.check).toContain("git show $GITP_PR_HEAD:");
  });

  describe("saved per kind", () => {
    // vitest runs in node: a small localStorage of our own.
    beforeEach(() => {
      const store = new Map<string, string>();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };
    });

    it("saves a custom command per kind and blank restores the default", () => {
      expect(loadThreadCommand("check")).toBe(DEFAULT_THREAD_COMMANDS.check);
      saveThreadCommand("check", "my-check");
      expect(loadThreadCommand("check")).toBe("my-check");
      expect(loadThreadCommand("explain")).toBe(DEFAULT_THREAD_COMMANDS.explain);
      saveThreadCommand("check", "  ");
      expect(loadThreadCommand("check")).toBe(DEFAULT_THREAD_COMMANDS.check);
      saveThreadCommand("check", DEFAULT_THREAD_COMMANDS.check);
      expect(localStorage.getItem("gitp-thread-command-check")).toBeNull();
    });
  });
});
