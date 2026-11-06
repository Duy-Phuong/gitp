// The Jira ticket a pull request is for, read from its title or branch, and
// the page to open it on (Settings → Git → Jira site).

const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/** The first ticket key such as UBIID-1234 in any of `texts`, or null. */
export function jiraKeyIn(...texts: string[]): string | null {
  for (const t of texts) {
    const m = KEY.exec(t);
    if (m) return m[1];
  }
  return null;
}

/** The ticket's page on `site` (an origin or a /browse/ URL); null when either is blank. */
export function jiraTicketUrl(site: string, key: string | null): string | null {
  const base = site.trim().replace(/\/+$/, "").replace(/\/browse$/, "");
  if (!base || !key) return null;
  return `${base}/browse/${key}`;
}
