// The Code tab's editor: one CodeMirror view showing whichever file is
// active; each open file keeps its EditorState so switching tabs restores
// caret, scroll and undo history. Edits mark the file dirty and auto-save
// after 1.5 s idle; Cmd/Ctrl+S saves at once. Cmd/Ctrl+click and F12 ask the
// host to go to the definition under the caret.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, ViewPlugin } from "@codemirror/view";

import type { Lang, Location } from "../../types";
import { codeTheme } from "./theme";

export const AUTOSAVE_MS = 1500;

export function languageFor(lang: Lang | null): Extension {
  switch (lang) {
    case "java":
      return java();
    case "javascript":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "python":
      return python();
    default:
      return [];
  }
}

export interface AutoSaveDeps {
  save: (path: string) => Promise<void>;
  onDirty: (path: string, dirty: boolean) => void;
  // A save that failed: the file stays dirty.
  onError?: (path: string, err: unknown) => void;
}

/// The dirty-and-save clock per file: an edit starts (or restarts) a timer;
/// when it fires, or on an explicit save, the host writes the file.
export class AutoSave {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private dirty = new Set<string>();

  constructor(private deps: AutoSaveDeps) {}

  edited(path: string): void {
    if (!this.dirty.has(path)) {
      this.dirty.add(path);
      this.deps.onDirty(path, true);
    }
    clearTimeout(this.timers.get(path));
    this.timers.set(path, setTimeout(() => void this.saveNow(path), AUTOSAVE_MS));
  }

  async saveNow(path: string): Promise<void> {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    if (!this.dirty.has(path)) return;
    try {
      await this.deps.save(path);
    } catch (err) {
      this.deps.onError?.(path, err);
      return;
    }
    this.dirty.delete(path);
    this.deps.onDirty(path, false);
  }

  isDirty(path: string): boolean {
    return this.dirty.has(path);
  }

  /// Drop a pending save (the tab closed, or the file was reloaded).
  forget(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.dirty.delete(path);
  }
}

export interface CodeEditorDeps {
  // An edit happened in `path`.
  onEdit: (path: string) => void;
  onSaveShortcut: (path: string) => void;
  gotoDefinition: (loc: Location) => void;
  onCaretMoved: (loc: Location) => void;
}

export class CodeEditor {
  readonly view: EditorView;
  private states = new Map<string, EditorState>();
  private activePath: string | null = null;
  private readOnly = new Compartment();

  constructor(host: HTMLElement, private deps: CodeEditorDeps) {
    this.view = new EditorView({ parent: host, state: this.blankState() });
  }

  private extensions(lang: Lang | null): Extension {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      bracketMatching(),
      indentOnInput(),
      codeTheme,
      languageFor(lang),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            if (this.activePath) this.deps.onSaveShortcut(this.activePath);
            return true;
          },
        },
        {
          key: "F12",
          run: () => {
            const c = this.caret();
            if (c) this.deps.gotoDefinition(c);
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.domEventHandlers({
        mousedown: (e, view) => {
          if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null || !this.activePath) return false;
          const line = view.state.doc.lineAt(pos);
          this.deps.gotoDefinition({ path: this.activePath, line: line.number - 1, col: pos - line.from });
          return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (!this.activePath) return;
        if (u.docChanged) this.deps.onEdit(this.activePath);
        else if (u.selectionSet) this.deps.onCaretMoved(this.locationOf(u.state.selection.main.head));
      }),
      this.readOnly.of(EditorState.readOnly.of(false)),
      modifierLink,
    ];
  }

  private blankState(): EditorState {
    return EditorState.create({ doc: "", extensions: [codeTheme, EditorState.readOnly.of(true)] });
  }

  /// Show `path`, restoring its state if it was open before.
  open(path: string, text: string, lang: Lang | null): void {
    if (this.activePath && this.activePath !== path) this.states.set(this.activePath, this.view.state);
    const state = this.states.get(path) ?? EditorState.create({ doc: text, extensions: this.extensions(lang) });
    this.activePath = path;
    this.view.setState(state);
  }

  active(): string | null {
    return this.activePath;
  }

  text(path: string): string | null {
    if (path === this.activePath) return this.view.state.doc.toString();
    return this.states.get(path)?.doc.toString() ?? null;
  }

  /// Replace the whole text (a reload from disk), keeping the caret where it can stay.
  replaceText(path: string, text: string): void {
    if (path !== this.activePath) {
      const old = this.states.get(path);
      if (old) this.states.set(path, old.update({ changes: { from: 0, to: old.doc.length, insert: text } }).state);
      return;
    }
    const head = Math.min(this.view.state.selection.main.head, text.length);
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, selection: { anchor: head } });
  }

  setReadOnly(path: string, on: boolean): void {
    if (path !== this.activePath) return;
    this.view.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(on)) });
  }

  /// Put the caret at `loc` (clamped to the document) and scroll it into view.
  reveal(loc: Location, endCol?: number): void {
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(Math.max(loc.line + 1, 1), doc.lines));
    const anchor = Math.min(line.from + loc.col, line.to);
    const head = endCol == null ? anchor : Math.min(line.from + endCol, line.to);
    this.view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
    this.view.focus();
  }

  caret(): Location | null {
    if (!this.activePath) return null;
    return this.locationOf(this.view.state.selection.main.head);
  }

  focus(): void {
    this.view.focus();
  }

  close(path: string): void {
    this.states.delete(path);
    if (this.activePath === path) {
      this.activePath = null;
      this.view.setState(this.blankState());
    }
  }

  private locationOf(pos: number): Location {
    const line = this.view.state.doc.lineAt(pos);
    return { path: this.activePath ?? "", line: line.number - 1, col: pos - line.from };
  }
}

// Underline the word under the pointer while Cmd/Ctrl is held, as IDEs do
// to show that a click will jump.
const linkMark = Decoration.mark({ class: "cm-def-link" });
const modifierLink = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(private view: EditorView) {
      view.dom.addEventListener("mousemove", (e) => this.track(e));
      view.dom.addEventListener("keyup", () => this.set(Decoration.none));
      view.dom.addEventListener("mouseleave", () => this.set(Decoration.none));
    }
    private track(e: MouseEvent): void {
      if (!(e.metaKey || e.ctrlKey)) {
        if (this.decorations.size) this.set(Decoration.none);
        return;
      }
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      const word = pos == null ? null : this.view.state.wordAt(pos);
      this.set(word ? Decoration.set([linkMark.range(word.from, word.to)]) : Decoration.none);
    }
    private set(d: DecorationSet): void {
      if (d === this.decorations) return;
      this.decorations = d;
      this.view.dispatch({});
    }
  },
  { decorations: (p) => p.decorations },
);
