import { describe, expect, it } from "vitest";
import { jiraKeyIn, jiraSite, jiraTicketUrl } from "./jira";

describe("jiraKeyIn", () => {
  it("finds the first ticket key across the texts given", () => {
    expect(jiraKeyIn("Retry the check", "feature/UBIID-9794-retry")).toBe("UBIID-9794");
    expect(jiraKeyIn("[KW-4] fix", "main")).toBe("KW-4");
    expect(jiraKeyIn("fix typo", "feature/retry")).toBeNull();
  });

  it("ignores lowercase and sha-like words", () => {
    expect(jiraKeyIn("abc-123 and deadbeef-1")).toBeNull();
  });

  it("skips words that only look like keys", () => {
    expect(jiraKeyIn("Read UTF-8 and SHA-256 files for UBIID-9674")).toBe("UBIID-9674");
  });
});

describe("jiraTicketUrl", () => {
  it("builds the browse page from the site origin", () => {
    expect(jiraTicketUrl("https://x.atlassian.net", "KW-4")).toBe("https://x.atlassian.net/browse/KW-4");
    expect(jiraTicketUrl("https://x.atlassian.net/browse/", "KW-4")).toBe("https://x.atlassian.net/browse/KW-4");
  });

  it("uses only the site of a saved ticket link", () => {
    expect(jiraTicketUrl("https://mesoneerag.atlassian.net/browse/UBIID-9674", "UBIID-9800")).toBe(
      "https://mesoneerag.atlassian.net/browse/UBIID-9800",
    );
  });

  it("is null without a site or a key", () => {
    expect(jiraTicketUrl("", "KW-4")).toBeNull();
    expect(jiraTicketUrl("https://x.atlassian.net", null)).toBeNull();
  });
});

describe("jiraSite", () => {
  it("keeps only the origin of a pasted link", () => {
    expect(jiraSite("https://mesoneerag.atlassian.net/browse/UBIID-9674")).toBe("https://mesoneerag.atlassian.net");
    expect(jiraSite("mesoneerag.atlassian.net")).toBe("https://mesoneerag.atlassian.net");
    expect(jiraSite("  ")).toBe("");
  });
});
