import { describe, expect, it } from "vitest";

import { signatureText } from "./detail";
import type { CommitSignature } from "../types";

function sig(over: Partial<CommitSignature>): CommitSignature {
  return { status: "Good", signer: "", key: "", detail: "", ...over };
}

describe("signatureText", () => {
  it("names the signer and key of a verified signature", () => {
    const t = signatureText(sig({ signer: "ada@example.com", key: "SHA256:abc" }));
    expect(t.label).toBe("Verified");
    expect(t.who).toBe("ada@example.com · SHA256:abc");
    expect(t.title).toBe(t.who);
  });

  it("explains an unverifiable signature with git's reason", () => {
    const t = signatureText(sig({ status: "Unverifiable", detail: "error: cannot run gpg" }));
    expect(t.label).toBe("Signed (can't verify)");
    expect(t.who).toBe("");
    expect(t.title).toBe("error: cannot run gpg");
  });

  it("shows just the key when git can't name the signer", () => {
    const t = signatureText(sig({ status: "UnknownKey", key: "SHA256:xyz" }));
    expect(t.label).toBe("Unknown key");
    expect(t.who).toBe("SHA256:xyz");
  });
});
