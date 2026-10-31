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
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-matchingBracket": { outline: "1px solid var(--accent)", backgroundColor: "transparent" },
  ".cm-def-link": { textDecoration: "underline", color: "var(--accent)", cursor: "pointer" },
  "&.cm-focused": { outline: "none" },
});

export const codeTheme = [chrome, syntaxHighlighting(colours, { fallback: true })];
