import { describe, expect, it } from "vitest";
import { quitQuestion, unpushedLabel, unpushedTitle } from "./quit-check";

describe("the quit check", () => {
  it("names the unpushed default branch on the badge", () => {
    expect(unpushedLabel({ branch: "main", ahead: 3 })).toBe("↑3 unpushed on main");
    expect(unpushedTitle({ branch: "main", ahead: 1 })).toBe("1 commit on main that its remote doesn't have yet. Click to push main.");
  });

  it("asks about unpushed work alone with Quit", () => {
    const q = quitQuestion({ jobs: [], unpushed: [{ repo: "gitp", branch: "main", ahead: 13 }] });
    expect(q).toEqual({ message: "Not pushed yet:\n• gitp: 13 commits on main\n\nQuit anyway?", ok: "Quit" });
  });

  it("puts running jobs first, and stops them on OK", () => {
    const q = quitQuestion({ jobs: ["Review · #7"], unpushed: [{ repo: "gitp", branch: "main", ahead: 1 }] });
    expect(q.message).toBe("1 Claude job is running.\n• Review · #7\n\nNot pushed yet:\n• gitp: 1 commit on main\n\nStop it and quit?");
    expect(q.ok).toBe("Stop and quit");
  });
});
