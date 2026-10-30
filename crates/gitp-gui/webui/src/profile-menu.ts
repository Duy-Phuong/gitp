// The top bar's profile button: the active profile's initials, and a menu to
// switch profile or manage them. See profiles.ts for how a profile keeps its
// own settings and tabs.
//
// A switch reloads the window: the settings are read at startup all over the
// app, so starting again on the other profile's keys is what reliably applies
// every one of them and reopens that profile's tabs.

import { applyLocalIdentity, closeRepo, confirmDialog, fetchGlobalIdentity, setGlobalIdentity } from "./api";
import { clear, el, $ } from "./dom";
import { state, ui } from "./app-state";
import { opFailed, reportDone } from "./report";
import {
  activeProfile,
  deleteProfile,
  ensureStore,
  loadStore,
  profileIdentity,
  profileInitials,
  putProfile,
  switchProfile,
  type Profile,
  type ProfileStore,
} from "./profiles";
import { openProfilesDialog } from "./views/profiles-dialog";

function currentStore(): ProfileStore | null {
  return loadStore(localStorage);
}

export async function setupProfileMenu(): Promise<void> {
  if (!currentStore()) {
    // First run: the Default profile commits as whoever git does today.
    const identity = await fetchGlobalIdentity().catch(() => ({ name: "", email: "", signing_key: "" }));
    ensureStore(localStorage, identity);
  }
  const btn = $("#profile-btn");
  const menu = $("#profile-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) buildProfileMenu(menu, close);
    const nowHidden = menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(!nowHidden));
  });
  document.addEventListener("click", (e) => {
    if (!$("#profile-wrap").contains(e.target as Node)) close();
  });
  renderProfileButton();
}

function renderProfileButton(): void {
  const store = currentStore();
  if (!store) return;
  const p = activeProfile(store);
  const btn = $("#profile-btn");
  btn.textContent = profileInitials(p.name);
  btn.title = p.authorEmail ? `Profile: ${p.name} — ${p.authorName} <${p.authorEmail}>` : `Profile: ${p.name}`;
}

function buildProfileMenu(menu: HTMLElement, close: () => void): void {
  clear(menu);
  const store = currentStore();
  if (!store) return;
  menu.append(el("div", { class: "menu-label", text: "Profiles" }));
  for (const p of store.profiles) {
    const item = el("button", {
      class: `menu-item${p.id === store.active ? " active" : ""}`,
      text: p.name,
      title: p.authorEmail ? `${p.authorName} <${p.authorEmail}>` : "No identity set",
    });
    item.addEventListener("click", () => {
      close();
      if (p.id !== store.active) void switchToProfile(p);
    });
    menu.append(item);
  }
  menu.append(el("div", { class: "menu-sep" }));
  const manage = el("button", { class: "menu-item", text: "Manage Profiles…" });
  manage.addEventListener("click", () => {
    close();
    openProfilesDialog({ store: () => currentStore()!, save: saveProfile, remove: removeProfile });
  });
  menu.append(manage);
}

async function switchToProfile(target: Profile): Promise<void> {
  // A global identity is written first: if that fails, nothing has changed
  // yet. A local one is written as each repo becomes active
  // (applyProfileIdentityHere), after the reload.
  const identity = profileIdentity(target);
  if (identity && target.scope === "global") {
    try {
      await setGlobalIdentity(identity);
    } catch (err) {
      opFailed(`Couldn't switch to “${target.name}”: writing ~/.gitconfig failed`, err);
      return;
    }
  }
  // Close this profile's tabs in the backend, which outlives the reload, so
  // they don't reappear among the next profile's. Through the API rather than
  // closeRepoTab: that would save the shrinking tab list as this profile's.
  for (const repo of [...state.repos]) {
    await closeRepo(repo.path).catch(() => undefined);
    ui.terminal?.closeRepo(repo.path);
  }
  try {
    switchProfile(localStorage, target.id);
  } finally {
    // Swapped and reloaded in one go, so nothing can write the old profile's
    // state into the new one's keys in between. Should the swap itself have
    // failed (storage full), the reload brings this profile's tabs back.
    location.reload();
  }
}

// Make the open repo commit as the active profile, when that profile applies
// its identity per repo. Called whenever the active repo changes.
export function applyProfileIdentityHere(): void {
  const store = currentStore();
  if (!store || !state.repoPath) return;
  const p = activeProfile(store);
  const identity = profileIdentity(p);
  if (!identity || p.scope !== "local") return;
  applyLocalIdentity(identity).then(
    (changed) => {
      if (changed) reportDone(`Commits in this repo now use ${identity.name} <${identity.email}> (profile “${p.name}”).`);
    },
    (err) => opFailed(`Couldn't set this repo's identity for profile “${p.name}”`, err),
  );
}

async function saveProfile(profile: Profile): Promise<void> {
  putProfile(localStorage, profile);
  renderProfileButton();
  // An edit to the active profile takes effect now, not at the next switch.
  if (profile.id !== currentStore()?.active) return;
  const identity = profileIdentity(profile);
  if (!identity) return;
  if (profile.scope === "local") {
    applyProfileIdentityHere();
    return;
  }
  try {
    await setGlobalIdentity(identity);
    reportDone(`~/.gitconfig now uses ${identity.name} <${identity.email}>.`);
  } catch (err) {
    opFailed("Couldn't write the identity to ~/.gitconfig", err);
  }
}

async function removeProfile(profile: Profile): Promise<void> {
  const ok = await confirmDialog(
    `Delete the profile “${profile.name}”? Its saved settings and open tabs are deleted with it. Git config is not changed.`,
    "Delete Profile",
  );
  if (!ok) return;
  deleteProfile(localStorage, profile.id);
  reportDone(`Deleted the profile “${profile.name}”.`);
}
