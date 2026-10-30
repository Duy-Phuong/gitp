// Positions in the repo tab bar: where a dragged tab lands, and which tab
// Ctrl+Tab goes to.

// The index a tab dragged from `from` and dropped on the tab at `target` —
// before it, or with `after` behind it — ends up at, counted in the list with
// the dragged tab taken out (what the backend's move_repo expects).
export function droppedTabIndex(from: number, target: number, after: boolean): number {
  const insert = after ? target + 1 : target;
  return insert > from ? insert - 1 : insert;
}

// The tab `step` places from `active` (-1 = the one before), wrapping around
// the ends.
export function cycledTabIndex(count: number, active: number, step: number): number {
  return (((active + step) % count) + count) % count;
}
