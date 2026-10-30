// The top bar's profile button: the active profile's initials, and a menu to
// switch profile or manage them. See profiles.ts for how a profile keeps its
// own settings and tabs.
//
// A switch reloads the window: the settings are read at startup all over the
// app, so starting again on the other profile's keys is what reliably applies
// every one of them and reopens that profile's tabs.

import {
  applyLocalIdentity,
  closeRepo,
  confirmDialog,
  fetchGlobalIdentity,
  restoreLocalIdentity,
  setGlobalIdentity,
} from "./api";
import { clear, el, $ } from "./dom";
import { state, ui } from "./app-state";
import { opFailed, readFailed, reportDone } from "./report";
import { operationInFlight } from "./shell";
import {
  activeProfile,
  deleteProfile,
  ensureStore,
  fillSigningFormats,
  forgetIdentityWrite,
  loadStore,
  profileIdentity,
  profileInitials,
  profileSwitchPrompt,
  putProfile,
  recordIdentityWrite,
  staleIdentityWrites,
  switchProfile,
  type Profile,
  type ProfileStore,
} from "./profiles";
import { openProfilesDialog } from "./views/profiles-dialog";

function currentStore(): ProfileStore | null {
  return loadStore(localStorage);
}

export async function setupProfileMenu(): Promise<void> {
  const store = currentStore();
  if (!store || store.profiles.some((p) => p.signingFormat === undefined)) {
    // First run: the Default profile commits as whoever git does today. A
    // store saved before profiles had a signing format takes git's current one.
    const identity = await fetchGlobalIdentity().catch(() => null);
    if (!store) ensureStore(localStorage, identity ?? { name: "", email: "", signing_key: "", signing_format: "" });
    else if (identity) fillSigningFormats(localStorage, identity.signing_format);
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
      if (p.id !== store.active) switchToProfile(p).catch((err) => opFailed(`Couldn't switch to “${p.name}”`, err));
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
  const from = currentStore()?.active;
  if (!from) return;
  // Who git commits as now, for the prompt to name when the target has no
  // identity to replace it with.
  const current = await fetchGlobalIdentity().catch(() => null);
  const prompt = profileSwitchPrompt(target, state.repos.length, operationInFlight(), current);
  if ("refuse" in prompt) {
    readFailed("Can't switch profile now", prompt.refuse);
    return;
  }
  if (!(await confirmDialog(prompt.confirm, "Switch Profile"))) return;
  // Started while the question was open.
  if (operationInFlight()) {
    readFailed("Can't switch profile now", "A git operation is still running.");
    return;
  }
  // Repos the profile being left wrote its identity into get their own back
  // before the target takes over; one that can't stops the switch, which is
  // said. A switch that stops from here on puts the current profile's identity
  // back into the open repo (applyProfileIdentityHere).
  if (!(await restoreIdentities(target))) {
    applyProfileIdentityHere();
    return;
  }

  // The settings are swapped first: a swap that fails (storage full) has
  // changed nothing, and the window carries on as it was. Only then is a
  // global identity written — undone by swapping back should that fail — so
  // ~/.gitconfig never holds a profile the app isn't on. A local identity is
  // written as each repo becomes active (applyProfileIdentityHere), after the
  // reload.
  try {
    switchProfile(localStorage, target.id);
  } catch (err) {
    opFailed(`Couldn't switch to “${target.name}”: saving the settings failed`, err);
    applyProfileIdentityHere();
    return;
  }
  const identity = profileIdentity(target);
  if (identity && target.scope === "global") {
    try {
      await setGlobalIdentity(identity);
    } catch (err) {
      switchProfile(localStorage, from);
      opFailed(`Couldn't switch to “${target.name}”: writing ~/.gitconfig failed`, err);
      applyProfileIdentityHere();
      return;
    }
  }
  // Close this profile's tabs in the backend, which outlives the reload, so
  // they don't reappear among the next profile's. Through the API rather than
  // closeRepoTab: that would save the shrinking tab list — now into the new
  // profile's keys. Nothing else here writes settings before the reload.
  for (const repo of [...state.repos]) {
    await closeRepo(repo.path).catch(() => undefined);
    ui.terminal?.closeRepo(repo.path);
  }
  location.reload();
}

// Give the repos a local-scope profile wrote its identity into their own back,
// all but those `active` keeps writing to (see staleIdentityWrites); `only`
// limits it to one repo. False when one couldn't be: that is reported, and
// the note kept so it is tried again.
async function restoreIdentities(active: Profile, only?: string): Promise<boolean> {
  let ok = true;
  for (const [path, w] of staleIdentityWrites(localStorage, active)) {
    if (only !== undefined && path !== only) continue;
    try {
      await restoreLocalIdentity(path, w.wrote, w.previous);
      forgetIdentityWrite(localStorage, path);
    } catch (err) {
      ok = false;
      opFailed(`Couldn't give ${path} back its own commit identity`, err);
    }
  }
  return ok;
}

// Make the open repo commit as the active profile, when that profile applies
// its identity per repo — or give it back its own, when another profile wrote
// there and this one doesn't. Called whenever the active repo changes.
export function applyProfileIdentityHere(): void {
  const store = currentStore();
  const path = state.repoPath;
  if (!store || !path) return;
  const p = activeProfile(store);
  void restoreIdentities(p, path).then(() => {
    const identity = profileIdentity(p);
    // The backend writes the active repo, which must still be this one.
    if (!identity || p.scope !== "local" || state.repoPath !== path) return;
    applyLocalIdentity(identity).then(
      (previous) => {
        if (!previous) return;
        recordIdentityWrite(localStorage, path, p.id, identity, previous);
        reportDone(`Commits in this repo now use ${identity.name} <${identity.email}> (profile “${p.name}”).`);
      },
      (err) => opFailed(`Couldn't set this repo's identity for profile “${p.name}”`, err),
    );
  });
}

async function saveProfile(profile: Profile): Promise<void> {
  putProfile(localStorage, profile);
  renderProfileButton();
  // An edit to the active profile takes effect now, not at the next switch —
  // including repos it no longer writes to once it stops writing per repo.
  if (profile.id !== currentStore()?.active) return;
  await restoreIdentities(profile);
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
    `Delete the profile “${profile.name}”? Its saved settings and open tabs are deleted with it. ` +
      "Git config is not changed: repos it set an identity in got their own back when you switched away from it.",
    "Delete Profile",
  );
  if (!ok) return;
  deleteProfile(localStorage, profile.id);
  reportDone(`Deleted the profile “${profile.name}”.`);
}
