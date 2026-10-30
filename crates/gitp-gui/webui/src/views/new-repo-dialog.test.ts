import { describe, it, expect } from "vitest";
import { repoNameFromUrl } from "./new-repo-dialog";

describe("repoNameFromUrl", () => {
  it("takes the last path segment without .git, as git clone does", () => {
    expect(repoNameFromUrl("https://github.com/owner/repo.git")).toBe("repo");
    expect(repoNameFromUrl("https://github.com/owner/repo")).toBe("repo");
    expect(repoNameFromUrl("ssh://git@host:22/team/my.project.git")).toBe("my.project");
  });

  it("handles scp-style URLs and trailing slashes", () => {
    expect(repoNameFromUrl("git@github.com:owner/repo.git")).toBe("repo");
    expect(repoNameFromUrl("git@host:repo.git")).toBe("repo");
    expect(repoNameFromUrl("/srv/git/repo.git/")).toBe("repo");
    expect(repoNameFromUrl("  https://github.com/owner/repo/  ")).toBe("repo");
  });

  it("is empty while there is nothing to name yet", () => {
    expect(repoNameFromUrl("")).toBe("");
    expect(repoNameFromUrl("   ")).toBe("");
  });
});
