// "Draft with Claude" beside the Description of the Create Pull Request
// dialog: runs the pull request draft command against the chosen Into, shows
// "thinking…" and turns into Cancel meanwhile, and fills the Title and the
// Description. The title is replaced only while it is empty or still the
// pre-filled one (or Claude's last); the description asks first unless it is
// empty, the pre-filled one or Claude's last. A failure shows with Try again.

import { isCancelled } from "./api";
import { DRAFT_THINKING, needsConfirm } from "./claude-drafts";
import { el } from "./dom";
import type { FieldAction, FormAccess } from "./views/form-dialog";
import type { PrDraft } from "./types";

export interface PrDraftDeps {
  // What gitp pre-filled the dialog with.
  prefilled: PrDraft;
  // Where the Into, Title and Description fields are.
  fields: { base: number; title: number; body: number };
  draft: (base: string) => Promise<PrDraft>;
  cancel: () => void;
  confirm: (message: string) => Promise<boolean>;
}

export const DRAFT_LABEL = "Draft with Claude";

export function prDraftAction(deps: PrDraftDeps): { action: FieldAction; close: () => void } {
  let running = false;
  // Bumped by every start and by close, so a stale answer is dropped.
  let token = 0;
  let last: PrDraft | null = null;
  const { base, title, body } = deps.fields;

  const status = (f: FormAccess, children: (Node | string)[]) => {
    f.status.replaceChildren(...children);
    f.status.hidden = children.length === 0;
  };

  async function start(f: FormAccess): Promise<void> {
    const mine = ++token;
    running = true;
    f.button.textContent = "Cancel";
    status(f, [DRAFT_THINKING]);
    let draft: PrDraft;
    try {
      draft = await deps.draft(f.value(base));
    } catch (err) {
      if (mine !== token) return;
      running = false;
      f.button.textContent = DRAFT_LABEL;
      if (isCancelled(err)) {
        status(f, []);
        return;
      }
      const retry = el("button", { class: "btn ghost", type: "button", text: "Try again" });
      retry.addEventListener("click", () => void start(f));
      status(f, [el("span", { class: "form-field-error", text: String(err) }), retry]);
      return;
    }
    if (mine !== token) return;
    running = false;
    f.button.textContent = DRAFT_LABEL;
    status(f, []);
    const t = f.value(title).trim();
    if (!t || t === deps.prefilled.title.trim() || t === last?.title.trim()) f.set(title, draft.title);
    const keep = needsConfirm(f.value(body), [deps.prefilled.body, last?.body]);
    last = draft;
    if (keep && !(await deps.confirm("Replace the description with Claude's draft?"))) return;
    if (f.isOpen()) f.set(body, draft.body);
  }

  return {
    action: {
      label: DRAFT_LABEL,
      run: (f) => {
        if (running) deps.cancel();
        else void start(f);
      },
    },
    close: () => {
      if (!running) return;
      token++;
      running = false;
      deps.cancel();
    },
  };
}
