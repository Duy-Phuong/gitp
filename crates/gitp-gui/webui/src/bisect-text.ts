// The bisect banner's wording, kept apart from the DOM so it can be tested:
// how far along the session is, which commit is under test, or the culprit.

import type { BisectStatus } from "./types";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function bisectBannerText(st: BisectStatus): { title: string; sub: string } {
  if (st.first_bad) {
    return { title: `First bad commit: ${st.first_bad.slice(0, 7)}`, sub: st.first_bad_summary ?? "" };
  }
  let title = "Bisecting";
  if (!st.bad) title += " — mark a bad commit";
  else if (!st.good.length) title += " — mark a good commit";
  else if (st.remaining_estimate) {
    const [revs, steps] = st.remaining_estimate;
    title += ` — ~${plural(revs, "revision")} left (~${plural(steps, "step")})`;
  }
  return { title, sub: `Testing ${st.current.slice(0, 7)} ${st.current_summary}` };
}
