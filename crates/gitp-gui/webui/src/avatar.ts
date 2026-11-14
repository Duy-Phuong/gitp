// Author avatars via Gravatar. We hash the email with SHA-256 (Gravatar accepts
// SHA-256 hashes) using the built-in WebCrypto — no md5 dependency. Missing
// Gravatars fall back to a generated identicon (d=identicon), and a failed image
// load falls back to the plain lane-colored dot in the graph. With Settings'
// Custom, an author gets one of gitp's own pictures instead; the picture the
// user chose in Settings goes on their own commits under either.
//
// Note: this sends the email hash to gravatar.com to fetch the image — unless
// Settings shows author initials or the custom pictures, when nothing is
// fetched at all.

import { loadAvatarStyle, loadMyAvatar } from "./prefs";
import { activeProfile, loadStore } from "./profiles";

// gitp's own pictures (src/assets/avatars), bundled by Vite, in name order:
// each by its file name ("avatar-07.jpg") and its URL.
export const AVATAR_PICTURES: { name: string; url: string }[] = Object.entries(
  import.meta.glob<string>("./assets/avatars/*.jpg", { eager: true, import: "default", query: "?url" }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, url]) => ({ name: path.slice(path.lastIndexOf("/") + 1), url }));

export const CUSTOM_AVATARS: string[] = AVATAR_PICTURES.map((p) => p.url);

// The URL of the picture the user chose in Settings, or undefined for none.
export function myAvatarUrl(): string | undefined {
  const name = loadMyAvatar();
  return name ? AVATAR_PICTURES.find((p) => p.name === name)?.url : undefined;
}

// Whether `email` is the user's own: the email the active profile commits as.
export function isMyEmail(email: string, mine: string | null | undefined): boolean {
  return Boolean(mine) && email.trim().toLowerCase() === mine!.trim().toLowerCase();
}

// The picture of `email`'s author: picked by a hash of the email (FNV-1a), so
// the pick looks random but an author keeps theirs across redraws and runs.
export function customAvatar(email: string, urls: string[] = CUSTOM_AVATARS): string | undefined {
  if (!urls.length) return undefined;
  let h = 0x811c9dc5;
  for (const c of email.trim().toLowerCase()) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return urls[h % urls.length];
}

const cache = new Map<string, string>(); // email -> avatar URL
// The style the cache holds URLs of: a switch in Settings starts it again.
let cachedStyle: string | null = null;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Resolve avatar URLs for every given email (deduped, cached) so renderLog can
// look them up synchronously afterwards.
export async function ensureAvatars(emails: string[]): Promise<void> {
  const style = loadAvatarStyle();
  if (style === "initials") return;
  // The user's chosen picture, on their own commits under either style.
  const store = loadStore(localStorage);
  const mine = store ? activeProfile(store).authorEmail : null;
  const myUrl = myAvatarUrl();
  const key = `${style}|${mine ?? ""}|${myUrl ?? ""}`;
  if (key !== cachedStyle) {
    cache.clear();
    cachedStyle = key;
  }
  let pending = [...new Set(emails)].filter((e) => e && !cache.has(e));
  if (myUrl) {
    for (const email of pending) if (isMyEmail(email, mine)) cache.set(email, myUrl);
    pending = pending.filter((e) => !cache.has(e));
  }
  if (style === "custom") {
    for (const email of pending) {
      const url = customAvatar(email);
      if (url) cache.set(email, url);
    }
    return;
  }
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

// Up to two initials for a graph node: the first letters of the first and last
// words of the author's name ("Ada King Lovelace" → "AL"), or "?" for none.
export function authorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toUpperCase();
}
