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

// Ctrl+Tab that keeps up with quick presses: the active tab only changes once
// a switch lands, so each press steps on from where the previous one was
// heading instead, and one switch runs at a time — presses made meanwhile
// just move the target, and the latest target is switched to next.
export function tabCycler(
  active: () => string,
  switchTo: (path: string) => Promise<void>,
): (paths: string[], step: 1 | -1) => void {
  let target: string | null = null;

  async function follow(): Promise<void> {
    try {
      while (target !== null && target !== active()) {
        const next = target;
        await switchTo(next);
        // A switch that failed has said so; don't retry it.
        if (active() !== next) break;
      }
    } finally {
      target = null;
    }
  }

  return (paths, step) => {
    if (paths.length < 2) return;
    const idle = target === null;
    const from = paths.indexOf(target ?? active());
    target = paths[cycledTabIndex(paths.length, Math.max(from, 0), step)];
    if (idle) void follow();
  };
}
