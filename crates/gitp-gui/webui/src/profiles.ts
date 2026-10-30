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

export const DEFAULT_PROFILE_ID = "default";

function isStoreKey(key: string): boolean {
  return key === STORE_KEY || key.startsWith(SNAPSHOT_PREFIX);
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

// "Ada Lovelace" → "AL", "work" → "WO": the top bar's profile badge.
export function profileInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
