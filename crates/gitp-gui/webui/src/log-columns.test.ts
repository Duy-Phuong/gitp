import { describe, it, expect } from "vitest";
import {
  authorsOf,
  authorSearchValue,
  authorTerm,
  normalizeLogColumns,
  shownColumns,
  withAuthorTerm,
  withColumnMoved,
  withColumnToggled,
} from "./log-columns";
import type { CommitRow } from "./types";

describe("normalizeLogColumns", () => {
  it("falls back to every column in the default order", () => {
    expect(normalizeLogColumns(undefined)).toEqual({ order: ["author", "date", "sha"], hidden: [] });
  });

  it("drops unknown and repeated names and appends missing columns", () => {
    expect(normalizeLogColumns({ order: ["sha", "bogus", "sha", "author"], hidden: ["date", 3, "nope"] })).toEqual({
      order: ["sha", "author", "date"],
      hidden: ["date"],
    });
  });
});

describe("column changes", () => {
  const base = normalizeLogColumns(undefined);

  it("hides a column and shows it again in its old place", () => {
    const hidden = withColumnToggled(base, "date");
    expect(shownColumns(hidden)).toEqual(["author", "sha"]);
    expect(shownColumns(withColumnToggled(hidden, "date"))).toEqual(["author", "date", "sha"]);
  });

  it("moves a column before another, or to the end", () => {
    expect(withColumnMoved(base, "sha", "author").order).toEqual(["sha", "author", "date"]);
    expect(withColumnMoved(base, "author", null).order).toEqual(["date", "sha", "author"]);
    expect(withColumnMoved(base, "date", "date").order).toEqual(["author", "date", "sha"]);
  });

  it("round-trips through storage", () => {
    const moved = withColumnToggled(withColumnMoved(base, "sha", "author"), "author");
    expect(normalizeLogColumns(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
  });
});

describe("author filter terms", () => {
  it("reads the author: term, quotes removed", () => {
    expect(authorTerm("fix author:ada@example.com")).toBe("ada@example.com");
    expect(authorTerm('author:"Ada Lovelace" path:src')).toBe("Ada Lovelace");
    expect(authorTerm("fix author:")).toBe(null);
    expect(authorTerm("fix")).toBe(null);
  });

  it("replaces the author: term and keeps every other term", () => {
    expect(withAuthorTerm('fix author:old path:"a b"', "ada@example.com")).toBe('fix path:"a b" author:ada@example.com');
    expect(withAuthorTerm("", "Ada Lovelace")).toBe('author:"Ada Lovelace"');
    expect(withAuthorTerm("fix AUTHOR:old", null)).toBe("fix");
  });

  it("builds a term the search can read from a name with quotes in it", () => {
    const query = withAuthorTerm("fix", 'Ada "The Countess" Lovelace');
    expect(query).toBe('fix author:"The Countess"');
    expect(authorTerm(query)).toBe("The Countess");
    expect(withAuthorTerm("", 'O"Brien')).toBe("author:Brien");
  });

  it("is what the author menu compares the term with, so its checkmark shows", () => {
    expect(authorSearchValue('Ada "The Countess" Lovelace')).toBe(authorTerm(withAuthorTerm("", 'Ada "The Countess" Lovelace')));
    expect(authorSearchValue("ada@example.com")).toBe("ada@example.com");
  });
});

describe("authorsOf", () => {
  const row = (name: string, email: string): CommitRow => ({
    id: name + Math.random(),
    short_id: "",
    summary: "",
    author_name: name,
    author_email: email,
    time: 0,
    parents: [],
    lane: 0,
    color: 0,
  });

  it("lists each author once by email, most commits first", () => {
    const rows = [row("Grace", "g@x"), row("Ada", "a@x"), row("Ada L.", "A@x"), row("Linus", "l@x")];
    expect(authorsOf(rows)).toEqual([
      { name: "Ada", email: "a@x", commits: 2 },
      { name: "Grace", email: "g@x", commits: 1 },
      { name: "Linus", email: "l@x", commits: 1 },
    ]);
  });
});
