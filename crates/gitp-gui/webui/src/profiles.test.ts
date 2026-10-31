import { describe, it, expect } from "vitest";
import {
  activeProfile,
  deleteBlocker,
  deleteProfile,
  ensureStore,
  fillSigningFormats,
  forgetIdentityWrite,
  loadIdentityWrites,
  loadStore,
  profileIdentity,
  profileInitials,
  profileSwitchPrompt,
  putProfile,
  recordIdentityWrite,
  staleIdentityWrites,
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

const ADA = { name: "Ada Lovelace", email: "ada@example.com", signing_key: "", signing_format: "" };

const work: Profile = {
  id: "work",
  name: "Work",
  authorName: "Ada L.",
  authorEmail: "ada@work.example",
  signingKey: "ABC123",
  signingFormat: "ssh",
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

    expect(ensureStore(storage, { name: "Other", email: "o@x", signing_key: "", signing_format: "" }).profiles).toHaveLength(2);
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
    expect(profileIdentity(work)).toEqual({
      name: "Ada L.",
      email: "ada@work.example",
      signing_key: "ABC123",
      signing_format: "ssh",
    });
    expect(profileIdentity({ ...work, authorEmail: "" })).toBeNull();
  });

  it("sends an empty format, which unsets gpg.format, when the profile has none", () => {
    expect(profileIdentity({ ...work, signingFormat: undefined })?.signing_format).toBe("");
  });
});

describe("signing formats", () => {
  it("the first-run Default profile takes git's global format", () => {
    const store = ensureStore(memoryStorage(), { ...ADA, signing_format: "x509" });
    expect(activeProfile(store).signingFormat).toBe("x509");
  });

  it("fills profiles saved before formats existed: global ones from git, local ones empty", () => {
    const storage = memoryStorage();
    ensureStore(storage, ADA);
    const { signingFormat: _a, ...oldDefault } = activeProfile(loadStore(storage)!);
    const { signingFormat: _b, ...oldWork } = work;
    putProfile(storage, oldDefault);
    putProfile(storage, oldWork);
    putProfile(storage, { ...work, id: "new", signingFormat: "x509" });

    fillSigningFormats(storage, "ssh");

    expect(loadStore(storage)?.profiles.map((p) => [p.id, p.signingFormat])).toEqual([
      ["default", "ssh"],
      ["work", ""],
      ["new", "x509"],
    ]);
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
    expect(prompt).toEqual({ refuse: expect.stringMatching(/still running/) as string });
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
    const prompt = profileSwitchPrompt(noIdentity, 1, false, { name: "Ada L.", email: "ada@work.example", signing_key: "", signing_format: "" });
    if (!("confirm" in prompt)) throw new Error("expected a confirmation");
    expect(prompt.confirm).toMatch(/1 open tab closes/);
    expect(prompt.confirm).toMatch(/“Default” has no commit identity.*Ada L\. <ada@work\.example>/s);
  });
});

describe("identity writes", () => {
  const OWN = { name: "Repo Owner", email: "owner@example.org", signing_key: "", signing_format: "" };
  const WORK_ID = { name: "Ada L.", email: "ada@work.example", signing_key: "ABC123", signing_format: "ssh" };
  const home: Profile = { ...work, id: "home", name: "Home", authorEmail: "ada@home.example" };
  const blank: Profile = { ...work, id: "blank", name: "Blank", authorName: "", authorEmail: "" };

  function storeWith(...profiles: Profile[]) {
    const storage = memoryStorage();
    ensureStore(storage, ADA);
    for (const p of profiles) putProfile(storage, p);
    return storage;
  }

  it("outlive a profile switch: they are about the repos, not a profile's settings", () => {
    const storage = storeWith(work);
    switchProfile(storage, "work");
    recordIdentityWrite(storage, "/r/x", "work", WORK_ID, OWN);

    switchProfile(storage, "default");

    expect(loadIdentityWrites(storage)).toEqual({ "/r/x": { profile: "work", wrote: WORK_ID, previous: OWN } });
  });

  it("keep the repo's own identity as the one to give back", () => {
    const storage = storeWith(work);
    recordIdentityWrite(storage, "/r/x", "work", WORK_ID, OWN);
    // Applied again after an edit to the profile: what it replaced was its own.
    const edited = { ...WORK_ID, email: "ada@new.example" };
    recordIdentityWrite(storage, "/r/x", "work", edited, WORK_ID);

    expect(loadIdentityWrites(storage)["/r/x"]).toEqual({ profile: "work", wrote: edited, previous: OWN });
  });

  it("are all stale under a global-scope profile or one without an identity", () => {
    const storage = storeWith(work, blank);
    recordIdentityWrite(storage, "/r/x", "work", WORK_ID, OWN);
    recordIdentityWrite(storage, "/r/y", "work", WORK_ID, OWN);
    const defaultProfile = activeProfile(loadStore(storage)!);

    expect(staleIdentityWrites(storage, defaultProfile).map(([path]) => path)).toEqual(["/r/x", "/r/y"]);
    expect(staleIdentityWrites(storage, blank).map(([path]) => path)).toEqual(["/r/x", "/r/y"]);
  });

  it("are stale under another local profile, but not under the one that wrote them", () => {
    const storage = storeWith(work, home);
    recordIdentityWrite(storage, "/r/x", "work", WORK_ID, OWN);

    expect(staleIdentityWrites(storage, work)).toEqual([]);
    expect(staleIdentityWrites(storage, home).map(([path]) => path)).toEqual(["/r/x"]);
  });

  it("carry the signing format, so a restore gives back gpg.format too", () => {
    const storage = storeWith(work);
    recordIdentityWrite(storage, "/r/x", "work", profileIdentity(work)!, { ...OWN, signing_format: "x509" });

    const w = loadIdentityWrites(storage)["/r/x"];
    expect(w.wrote.signing_format).toBe("ssh");
    expect(w.previous.signing_format).toBe("x509");
  });

  it("are forgotten once given back", () => {
    const storage = storeWith(work);
    recordIdentityWrite(storage, "/r/x", "work", WORK_ID, OWN);
    forgetIdentityWrite(storage, "/r/x");
    expect(loadIdentityWrites(storage)).toEqual({});
  });
});
