// A native confirm dialog cannot scroll, so a long list of names pushes its
// buttons off the screen. Name the first few, then say how many more.
export const DIALOG_LIST_MAX = 10;

export function dialogList(names: string[], max = DIALOG_LIST_MAX): string {
  if (names.length <= max) return names.join("\n");
  return [...names.slice(0, max), `…and ${names.length - max} more`].join("\n");
}
