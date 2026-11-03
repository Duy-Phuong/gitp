// CodeMirror dressed in gitp's theme variables, so the editor matches the
// diffs: the same --syn-* colours highlight.js uses there, the same mono font.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const colours = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.bool, t.null], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float, t.propertyName, t.attributeName], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.className, t.definition(t.propertyName)], color: "var(--syn-title)" },
  { tag: [t.typeName, t.standard(t.variableName), t.namespace, t.annotation, t.meta], color: "var(--syn-type)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syn-tag, var(--syn-type))" },
  { tag: t.invalid, color: "var(--danger, #e5484d)" },
]);

const chrome = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "12.5px" },
  ".cm-scroller": { fontFamily: "var(--code-font)", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--text)", padding: "6px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--text-dim)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-elev)" },
  ".cm-activeLine": { backgroundColor: "var(--accent-soft)" },
  // As specific as CodeMirror's own focused rule, whose light lavender would
  // otherwise win and wash out the syntax colours in every theme.
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-matchingBracket": { outline: "1px solid var(--accent)", backgroundColor: "transparent" },
  // The find/replace panel and its matches.
  ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { fontFamily: "inherit", fontSize: "12px", padding: "4px 8px" },
  ".cm-textfield": { backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "4px", font: "inherit" },
  ".cm-button": { backgroundColor: "var(--bg)", backgroundImage: "none", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "4px", font: "inherit" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent)", color: "var(--bg)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)" },
  ".cm-def-link": { textDecoration: "underline", color: "var(--accent)", cursor: "pointer" },
  "&.cm-focused": { outline: "none" },
});

export const codeTheme = [chrome, syntaxHighlighting(colours, { fallback: true })];
