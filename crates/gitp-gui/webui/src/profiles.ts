// Profiles: several identities, each with its own app settings and open tabs.
//
// Every preference gitp keeps is a localStorage key, written by whichever
// module owns it. Rather than teach each of those about profiles, the active
// profile's settings simply *are* the live keys, and switching profile swaps
// the whole set: every key but the profile store's own is moved into a
// snapshot for the profile being left, and the target's snapshot is moved
// back in. So a setting added later is per-profile without anyone listing it,
// and the first run migrates nothing — what is already there becomes the
// Default profile's.
//
// Pure functions over a Storage, so the swap is testable without a browser.

import type { Identity } from "./types";

// Where a profile's identity is written when it becomes active: the open
// repo's .git/config, or ~/.gitconfig.
export type IdentityScope = "local" | "global";

// No passwords or tokens: the signing key is git's `user.signingkey` — a key
// id or the path to a public key — which is no secret.
export interface Profile {
  id: string;
  name: string;
  authorName: string;
  authorEmail: string;
  signingKey: string;
  scope: IdentityScope;
}

export interface ProfileStore {
  active: string;
  profiles: Profile[];
}

// The subset of the Web Storage API the swap needs.
export type KeyValueStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

const STORE_KEY = "gitp-profiles";
// A profile's settings while another profile is active.
const SNAPSHOT_PREFIX = "gitp-profile-data:";
// The repos a local-scope profile wrote its identity into (IdentityWrite):
// about the repos rather than any one profile, so never swapped out.
const IDENTITY_WRITES_KEY = "gitp-identity-writes";

export const DEFAULT_PROFILE_ID = "default";

function isStoreKey(key: string): boolean {
  return key === STORE_KEY || key === IDENTITY_WRITES_KEY || key.startsWith(SNAPSHOT_PREFIX);
}

export function loadStore(storage: KeyValueStorage): ProfileStore | null {
  try {
    const raw = JSON.parse(storage.getItem(STORE_KEY) ?? "null") as ProfileStore | null;
    if (!raw || !Array.isArray(raw.profiles) || raw.profiles.length === 0) return null;
    const active = raw.profiles.some((p) => p.id === raw.active) ? raw.active : raw.profiles[0].id;
    return { active, profiles: raw.profiles };
  } catch {
    return null;
  }
}

function saveStore(storage: KeyValueStorage, store: ProfileStore): void {
  storage.setItem(STORE_KEY, JSON.stringify(store));
}

// The profile store, created on first run as a single "Default" profile that
// commits as `identity` (the user's global git identity) and owns every
// setting and tab already saved.
export function ensureStore(storage: KeyValueStorage, identity: Identity): ProfileStore {
  const existing = loadStore(storage);
  if (existing) return existing;
  const store: ProfileStore = {
    active: DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: "Default",
        authorName: identity.name,
        authorEmail: identity.email,
        signingKey: identity.signing_key,
        // It came from the global config, so that is where it goes back to.
        scope: "global",
      },
    ],
  };
  saveStore(storage, store);
  return store;
}

export function activeProfile(store: ProfileStore): Profile {
  return store.profiles.find((p) => p.id === store.active) ?? store.profiles[0];
}

// Make `toId` the active profile: park the live settings under the profile
// being left, and bring `toId`'s back. A profile never switched to before
// starts from the app defaults (no saved keys, no tabs).
export function switchProfile(storage: KeyValueStorage, toId: string): void {
  const store = loadStore(storage);
  if (!store || store.active === toId || !store.profiles.some((p) => p.id === toId)) return;

  // Collect before removing: removing while walking by index skips keys.
  const live: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && !isStoreKey(key)) live[key] = storage.getItem(key) ?? "";
  }
  // Written first, so a full quota fails the switch before anything is lost.
  storage.setItem(SNAPSHOT_PREFIX + store.active, JSON.stringify(live));
  for (const key of Object.keys(live)) storage.removeItem(key);

  for (const [key, value] of Object.entries(readSnapshot(storage, toId))) storage.setItem(key, value);
  storage.removeItem(SNAPSHOT_PREFIX + toId);

  saveStore(storage, { ...store, active: toId });
}

function readSnapshot(storage: KeyValueStorage, id: string): Record<string, string> {
  try {
    const raw = JSON.parse(storage.getItem(SNAPSHOT_PREFIX + id) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

// Add a profile, or replace the one with the same id.
export function putProfile(storage: KeyValueStorage, profile: Profile): void {
  const store = loadStore(storage);
  if (!store) return;
  const i = store.profiles.findIndex((p) => p.id === profile.id);
  const profiles = i === -1 ? [...store.profiles, profile] : store.profiles.map((p, j) => (j === i ? profile : p));
  saveStore(storage, { ...store, profiles });
}

// Why `id` can't be deleted, or null when it can. The active profile's
// settings are the live keys, so it has to be switched away from first —
// which also keeps the last profile from being deleted.
export function deleteBlocker(store: ProfileStore, id: string): string | null {
  if (store.profiles.length <= 1) return "The only profile can't be deleted.";
  if (store.active === id) return "Switch to another profile before deleting this one.";
  return null;
}

// Delete a profile with its saved settings and tabs.
export function deleteProfile(storage: KeyValueStorage, id: string): void {
  const store = loadStore(storage);
  if (!store || deleteBlocker(store, id)) return;
  storage.removeItem(SNAPSHOT_PREFIX + id);
  saveStore(storage, { ...store, profiles: store.profiles.filter((p) => p.id !== id) });
}

// The identity to apply, or null for a profile without both a name and an
// email — that one leaves git's config alone.
export function profileIdentity(profile: Profile): Identity | null {
  if (!profile.authorName || !profile.authorEmail) return null;
  return { name: profile.authorName, email: profile.authorEmail, signing_key: profile.signingKey };
}

// The confirmation a switch to `target` asks for, or why it can't happen now.
// The window starts again on the target's settings and tabs, so whatever lives
// only in this session goes with it. `identity` is who git commits as today
// (~/.gitconfig): a target without an identity of its own leaves it in place,
// which is said rather than left to be found in the next commit.
export function profileSwitchPrompt(
  target: Profile,
  openTabs: number,
  busy: boolean,
  identity: Identity | null,
): { refuse: string } | { confirm: string } {
  if (busy) return { refuse: `A git operation is still running. Switch to “${target.name}” once it has finished.` };
  const tabs = openTabs === 1 ? "1 open tab closes" : `${openTabs} open tabs close`;
  const lines = [
    `Switch to the profile “${target.name}”?`,
    `The window reloads: ${tabs} (they reopen when you switch back), terminal sessions end, and Undo history, ` +
      "the unsent commit message and any paused cherry-picks are lost.",
  ];
  if (!profileIdentity(target) && identity?.email) {
    lines.push(
      `“${target.name}” has no commit identity, so git keeps committing as ${identity.name} <${identity.email}>. ` +
        "Give it one under Manage Profiles….",
    );
  }
  return { confirm: lines.join("\n\n") };
}

// A local-scope profile's identity written into one repo's .git/config, and
// what that config held before. Local config beats global, so without this the
// repo would go on committing as that profile after a switch to another — and
// an identity the repo had of its own would be gone.
export interface IdentityWrite {
  profile: string;
  wrote: Identity;
  previous: Identity;
}

export function loadIdentityWrites(storage: KeyValueStorage): Record<string, IdentityWrite> {
  try {
    const raw = JSON.parse(storage.getItem(IDENTITY_WRITES_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, IdentityWrite>) : {};
  } catch {
    return {};
  }
}

// Note that `profile` wrote `wrote` into `path` over `previous`. A repo noted
// already keeps the `previous` it was first noted with: that is its own
// identity, a later one only a profile's.
export function recordIdentityWrite(
  storage: KeyValueStorage,
  path: string,
  profile: string,
  wrote: Identity,
  previous: Identity,
): void {
  const writes = loadIdentityWrites(storage);
  writes[path] = { profile, wrote, previous: writes[path]?.previous ?? previous };
  storage.setItem(IDENTITY_WRITES_KEY, JSON.stringify(writes));
}

export function forgetIdentityWrite(storage: KeyValueStorage, path: string): void {
  const writes = loadIdentityWrites(storage);
  delete writes[path];
  storage.setItem(IDENTITY_WRITES_KEY, JSON.stringify(writes));
}

// The repos to give their own identity back to while `active` is the profile:
// every one noted, but those `active` wrote itself while it still writes one.
export function staleIdentityWrites(storage: KeyValueStorage, active: Profile): [string, IdentityWrite][] {
  const keeps = active.scope === "local" && profileIdentity(active) !== null;
  return Object.entries(loadIdentityWrites(storage)).filter(([, w]) => !(keeps && w.profile === active.id));
}

// "Ada Lovelace" → "AL", "work" → "WO": the top bar's profile badge.
export function profileInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
