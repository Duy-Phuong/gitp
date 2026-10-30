// "Manage Profiles…": the profiles as a list with Edit / Delete, plus Add
// Profile. Each add or edit is a form (openFormDialog); this dialog only lists
// and redraws. Reuses the `.modal-overlay` / `.modal` shell.

import { el } from "../dom";
import { openFormDialog } from "./form-dialog";
import { deleteBlocker, profileInitials, type IdentityScope, type Profile, type ProfileStore } from "../profiles";

export interface ProfilesDialogActions {
  store: () => ProfileStore;
  // Save a new or edited profile (a new one has a fresh id).
  save: (profile: Profile) => Promise<void>;
  // Confirm, then delete; resolves once the list can be redrawn.
  remove: (profile: Profile) => Promise<void>;
}

const SCOPES: { value: IdentityScope; label: string }[] = [
  { value: "local", label: "This repo only (local config)" },
  { value: "global", label: "Global .gitconfig" },
];

export function openProfilesDialog(actions: ProfilesDialogActions): void {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal profiles-modal" });
  overlay.append(modal);
  const list = el("div", { class: "profiles-list" });

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    // The form opened on top handles its own Escape.
    if (e.key === "Escape" && document.querySelector(".rename-modal") === null) close();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  const render = () => {
    list.replaceChildren();
    const store = actions.store();
    for (const p of store.profiles) {
      const edit = el("button", { class: "btn ghost small", text: "Edit…" });
      edit.addEventListener("click", () => editProfile(p, (saved) => void actions.save(saved).then(render)));
      const blocker = deleteBlocker(store, p.id);
      const del = el("button", { class: "btn ghost small", text: "Delete", title: blocker ?? "Delete this profile" });
      del.disabled = blocker !== null;
      del.addEventListener("click", () => void actions.remove(p).then(render));
      const identity = p.authorName || p.authorEmail ? `${p.authorName} <${p.authorEmail}>` : "No identity set";
      const scope = SCOPES.find((s) => s.value === p.scope)?.label ?? "";
      list.append(
        el("div", { class: `profiles-row${p.id === store.active ? " active" : ""}` }, [
          el("span", { class: "profile-badge", text: profileInitials(p.name) }),
          el("div", { class: "profiles-text" }, [
            el("div", { class: "profiles-name", text: p.id === store.active ? `${p.name} (active)` : p.name }),
            el("div", { class: "profiles-sub", text: `${identity} · ${scope}${p.signingKey ? " · signs" : ""}` }),
          ]),
          edit,
          del,
        ]),
      );
    }
  };

  const add = el("button", { class: "btn ghost", text: "Add Profile…" });
  add.addEventListener("click", () =>
    editProfile(null, (saved) => void actions.save(saved).then(render)),
  );
  const done = el("button", { class: "btn", text: "Done" });
  done.addEventListener("click", close);

  modal.append(
    el("div", { class: "modal-title", text: "Profiles" }),
    el("div", {
      class: "modal-sub",
      text: "Each profile has its own author identity, settings and open tabs. A new profile starts with the default settings.",
    }),
    list,
    el("div", { class: "modal-actions" }, [add, el("span", { class: "spacer" }), done]),
  );
  render();
  document.body.append(overlay);
}

// The add / edit form. `profile` null adds a new one.
function editProfile(profile: Profile | null, onSave: (p: Profile) => void): void {
  openFormDialog(
    {
      title: profile ? `Edit Profile “${profile.name}”` : "Add Profile",
      sub: "Commits made in gitp use this name and email while the profile is active.",
      fields: [
        { label: "Profile name", value: profile?.name, placeholder: "Work", required: true },
        { label: "Author name", value: profile?.authorName, placeholder: "Ada Lovelace", required: true },
        { label: "Author email", value: profile?.authorEmail, placeholder: "ada@example.com", required: true },
        { label: "Signing key", value: profile?.signingKey, placeholder: "Optional: key id or ~/.ssh/key.pub" },
        { label: "Apply identity to", value: profile?.scope ?? "local", choices: SCOPES },
      ],
      submitLabel: profile ? "Save" : "Add",
    },
    ([name, authorName, authorEmail, signingKey, scope]) =>
      onSave({
        id: profile?.id ?? crypto.randomUUID(),
        name,
        authorName,
        authorEmail,
        signingKey,
        scope: scope === "global" ? "global" : "local",
      }),
  );
}
