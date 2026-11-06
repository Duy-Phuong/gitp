// The Jira ticket a pull request is for, read from its title or branch, and
// the page to open it on (Settings → Git → Jira site).

const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
// Words that look like a key and are not one.
const NOT_KEYS = /^(UTF|SHA|ISO|RFC|HTTP|TLS|SSL|MD|CVE|ES|AES|RSA|BASE|X)-/;

/** The first ticket key such as UBIID-1234 in any of `texts` (the first text wins), or null. */
export function jiraKeyIn(...texts: string[]): string | null {
  for (const t of texts) {
    for (const m of t.matchAll(KEY)) if (!NOT_KEYS.test(m[1])) return m[1];
  }
  return null;
}

/** The ticket's page on `site` (an origin, or any link on it); null when either is blank. */
export function jiraTicketUrl(site: string, key: string | null): string | null {
  const base = jiraSite(site);
  if (!base || !key) return null;
  return `${base}/browse/${key}`;
}

/** The site's origin from what was typed or pasted: an origin, or any link on it such as a ticket's page. */
export function jiraSite(text: string): string {
  const t = text.trim();
  if (!t) return "";
  try {
    return new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).origin;
  } catch {
    return t;
  }
}
