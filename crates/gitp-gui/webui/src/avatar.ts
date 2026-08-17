// Author avatars via Gravatar. We hash the email with SHA-256 (Gravatar accepts
// SHA-256 hashes) using the built-in WebCrypto — no md5 dependency. Missing
// Gravatars fall back to a generated identicon (d=identicon), and a failed image
// load falls back to the plain lane-colored dot in the graph.
//
// Note: this sends the email hash to gravatar.com to fetch the image.

const cache = new Map<string, string>(); // email -> avatar URL

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Resolve avatar URLs for every given email (deduped, cached) so renderLog can
// look them up synchronously afterwards.
export async function ensureAvatars(emails: string[]): Promise<void> {
  const pending = [...new Set(emails)].filter((e) => e && !cache.has(e));
  await Promise.all(
    pending.map(async (email) => {
      const hash = await sha256Hex(email.trim().toLowerCase());
      cache.set(email, `https://www.gravatar.com/avatar/${hash}?d=identicon&s=48`);
    }),
  );
}

export function avatarUrl(email: string): string | undefined {
  return cache.get(email);
}
