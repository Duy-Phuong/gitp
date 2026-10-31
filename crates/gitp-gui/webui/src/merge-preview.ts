// The one-line verdict of a merge dry-run (see gitp-core's merge_preview),
// for the menu heading above Merge and the question before a rebase. Pure,
// so it is unit-tested.

import type { MergePreview } from "./types";

/// How many conflicting paths to spell out before "+N more".
const NAMED = 3;

/// "No conflicts expected", or which files would conflict. `null` is a check
/// that couldn't run (an old git, a vanished branch): said as such, since a
/// missing warning must not read as a clean bill.
export function previewSummary(preview: MergePreview | null): string {
  if (!preview) return "Couldn't check for conflicts";
  if (preview.clean) return "No conflicts expected";
  const n = preview.conflicts.length;
  const named = preview.conflicts.slice(0, NAMED).join(", ");
  const more = n > NAMED ? ` +${n - NAMED} more` : "";
  return `⚠ ${n} file${n === 1 ? "" : "s"} would conflict: ${named}${more}`;
}
