import { describe, it, expect } from "vitest";
import {
  activeProfile,
  deleteBlocker,
  deleteProfile,
  ensureStore,
  loadStore,
  profileIdentity,
  profileInitials,
  profileSwitchPrompt,
  putProfile,
  switchProfile,
  type KeyValueStorage,
  type Profile,
} from "./profiles";

// localStorage's shape over a Map, in insertion order like the real one.
function memoryStorage(entries: Record<string, string> = {}): KeyValueStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const ADA = { name: "Ada Lovelace", email: "ada@example.com", signing_key: "" };

const work: Profile = {
  id: "work",
  name: "Work",
  authorName: "Ada L.",
  authorEmail: "ada@work.example",
  signingKey: "ABC123",
  scope: "local",
};

describe("ensureStore", () => {
  it("makes the first run's settings and tabs the Default profile's, untouched", () => {
    const before = {
      "gitp-theme": "dark",
      "gitp-repos": JSON.stringify({ paths: ["/r/a", "/r/b"], active: "/r/b" }),
      "gitp-graph:/r/a": '{"pinned":"refs/heads/main","hidden":[],"solo":[]}',
    };
    const storage = memoryStorage(before);

    const store = ensureStore(storage, ADA);

    expect(activeProfile(store)).toMatchObject({
      name: "Default",
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
      scope: "global",
    });
    const { "gitp-profiles": _store, ...rest } = storage.dump();
    expect(rest).toEqual(before);
  });

  it("keeps an existing store", () => {
    const storage = memoryStorage();
    ensureStore(storage, ADA);
    putProfile(storage, work);

    expect(ensureStore(storage, { name: "Other", email: "o@x", signing_key: "" }).profiles).toHaveLength(2);
  });
});

describe("switchProfile", () => {
  it("swaps every setting, including keys no one registered, and swaps them back", () => {
    const storage = memoryStorage({
      "gitp-theme": "dark",
      "gitp-repos": '{"paths":["/r/a"],"active":"/r/a"}',
      "gitp-some-future-setting": "1",
    });
    ensureStore(storage, ADA);
    putProfile(storage, work);

    switchProfile(storage, "work");
    expect(loadStore(storage)?.active).toBe("work");
    // A profile never used before starts from the defaults: no theme, no tabs.
    expect(storage.getItem("gitp-theme")).toBeNull();
    expect(storage.getItem("gitp-repos")).toBeNull();
    expect(storage.getItem("gitp-some-future-setting")).toBeNull();

    storage.setItem("gitp-theme", "light");
    storage.setItem("gitp-repos", '{"paths":["/w/x"],"active":"/w/x"}');

    switchProfile(storage, "default");
    expect(storage.getItem("gitp-theme")).toBe("dark");
    expect(storage.getItem("gitp-repos")).toBe('{"paths":["/r/a"],"active":"/r/a"}');
    expect(storage.getItem("gitp-some-future-setting")).toBe("1");

    switchProfile(storage, "work");
    expect(storage.getItem("gitp-theme")).toBe("light");
    expect(storage.getItem("gitp-repos")).toBe('{"paths":["/w/x"],"active":"/w/x"}');
    expect(storage.getItem("gitp-some-future-setting")).toBeNull();
  });

  it("leaves no stale snapshot for the profile that is now live", () => {
    const storage = memoryStorage({ "gitp-theme": "dark" });
    ensureStore(storage, ADA);
    putProfile(storage, work);

    switchProfile(storage, "work");
    switchProfile(storage, "default");

    expect(Object.keys(storage.dump()).sort()).toEqual(["gitp-profile-data:work", "gitp-profiles", "gitp-theme"]);
  });

  it("ignores an unknown profile or the one already active", () => {
    const storage = memoryStorage({ "gitp-theme": "dark" });
    ensureStore(storage, ADA);

    switchProfile(storage, "nope");
    switchProfile(storage, "default");

    expect(storage.getItem("gitp-theme")).toBe("dark");
    expect(loadStore(storage)?.active).toBe("default");
  });
});

describe("deleteProfile", () => {
  it("refuses the last profile and the active one", () => {
    const storage = memoryStorage();
    const store = ensureStore(storage, ADA);
    expect(deleteBlocker(store, "default")).toMatch(/only profile/);

    putProfile(storage, work);
    expect(deleteBlocker(loadStore(storage)!, "default")).toMatch(/Switch to another/);
    deleteProfile(storage, "default");
    expect(loadStore(storage)?.profiles).toHaveLength(2);
  });

  it("removes an inactive profile with its saved settings", () => {
    const storage = memoryStorage({ "gitp-theme": "dark" });
    ensureStore(storage, ADA);
    putProfile(storage, work);
    switchProfile(storage, "work");
    switchProfile(storage, "default");

    deleteProfile(storage, "work");

    expect(loadStore(storage)?.profiles.map((p) => p.id)).toEqual(["default"]);
    expect(storage.getItem("gitp-profile-data:work")).toBeNull();
  });
});

describe("putProfile", () => {
  it("edits a profile in place", () => {
    const storage = memoryStorage();
    ensureStore(storage, ADA);
    putProfile(storage, work);

    putProfile(storage, { ...work, authorEmail: "ada@new.example" });

    expect(loadStore(storage)?.profiles.map((p) => p.authorEmail)).toEqual(["ada@example.com", "ada@new.example"]);
  });
});

describe("profileIdentity", () => {
  it("maps to git's keys, and is null without both name and email", () => {
    expect(profileIdentity(work)).toEqual({ name: "Ada L.", email: "ada@work.example", signing_key: "ABC123" });
    expect(profileIdentity({ ...work, authorEmail: "" })).toBeNull();
  });
});

describe("profileInitials", () => {
  it("takes the first and last word, or the start of a single one", () => {
    expect(profileInitials("Ada Byron Lovelace")).toBe("AL");
    expect(profileInitials("work")).toBe("WO");
    expect(profileInitials("  ")).toBe("?");
  });
});

describe("profileSwitchPrompt", () => {
  const noIdentity: Profile = { ...work, id: "default", name: "Default", authorName: "", authorEmail: "", signingKey: "" };

  it("refuses while a git operation is running, and says why", () => {
    const prompt = profileSwitchPrompt(work, 3, true, ADA);
    expect(prompt).toEqual({ refuse: expect.stringMatching(/still running/) });
  });

  it("lists what the switch drops before it happens", () => {
    const prompt = profileSwitchPrompt(work, 3, false, ADA);
    if (!("confirm" in prompt)) throw new Error("expected a confirmation");
    expect(prompt.confirm).toMatch(/“Work”/);
    expect(prompt.confirm).toMatch(/3 open tabs close/);
    expect(prompt.confirm).toMatch(/terminal/);
    expect(prompt.confirm).toMatch(/Undo history/);
    expect(prompt.confirm).not.toMatch(/no commit identity/);
  });

  it("says who git keeps committing as when the target has no identity", () => {
    const prompt = profileSwitchPrompt(noIdentity, 1, false, { name: "Ada L.", email: "ada@work.example", signing_key: "" });
    if (!("confirm" in prompt)) throw new Error("expected a confirmation");
    expect(prompt.confirm).toMatch(/1 open tab closes/);
    expect(prompt.confirm).toMatch(/“Default” has no commit identity.*Ada L\. <ada@work\.example>/s);
  });
});
