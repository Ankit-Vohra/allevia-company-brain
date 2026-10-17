// The Library's words and choices (web/src/pages/Library.tsx): what each tile says, which filter shows what, what the sheet offers,
// and the chat's photo attach (web/src/components/chat/PhotoAttach.tsx). Pure, so the tests read what the page draws.
// The words follow docs/owner-words.md: no ids, models, steps or "variant"; credits are the team's credits.
import type { LibraryItem, LibraryKind, LibraryState } from "../../../shared/contracts.js";

export type LibraryFilter = "all" | "pictures" | "videos" | "mine" | "brand";

export const FILTERS: ReadonlyArray<{ id: LibraryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "pictures", label: "Pictures" },
  { id: "videos", label: "Videos" },
  { id: "mine", label: "Your photos" },
  { id: "brand", label: "Brand" },
];

export const KIND_WORDS: Record<LibraryKind, string> = {
  poster: "Poster", ad: "Ad", "product-shoot": "Product shoot", picture: "Picture", clip: "Clip", "your-photo": "Your photo", "your-video": "Your video",
};

export const STATE_WORDS: Record<LibraryState, string> = {
  waiting: "Waiting for your OK", approved: "Approved", posted: "Posted", declined: "Declined",
};

export const isFilter = (v: string | null | undefined): v is LibraryFilter => FILTERS.some((f) => f.id === v);

/** The items a filter shows, newest first. Brand is its own tab (the brand files), so it shows none of these. */
export function filterItems(items: LibraryItem[], filter: LibraryFilter): LibraryItem[] {
  const keep = (i: LibraryItem): boolean => {
    switch (filter) {
      case "all": return true;
      case "pictures": return i.media === "image" && !i.mine;
      case "videos": return i.media === "video";
      case "mine": return i.mine;
      case "brand": return false;
    }
  };
  return items.filter(keep).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** A title the owner can read: "Variant B: Make it festive (Higgsfield, AI-edited)" becomes "Make it festive". */
export function plainTitle(item: Pick<LibraryItem, "title" | "kind">): string {
  const t = item.title
    .replace(/^Variant [A-Z]{1,3}:\s*/i, "")
    .replace(/\s*\((?:[^()]*\b(?:Higgsfield|AI-made|AI-edited|local|adjusted locally)\b[^()]*)\)\s*$/i, "")
    .replace(/^(?:Photo|Video):\s*/i, "")
    .trim();
  if (!t || /^(?:Photo|Video) [0-9a-f]{6,}$/i.test(t)) return KIND_WORDS[item.kind];
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const creditWords = (n: number | null): string | null =>
  n === null || !(n > 0) ? null : `${Number.isInteger(n) ? n : n.toFixed(1)} credit${n === 1 ? "" : "s"}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "17 Oct", or "17 Oct 2025" when it is not this year. */
export function dayWords(at: number, now: number = Date.now()): string {
  if (!at) return "";
  const d = new Date(at);
  const same = d.getFullYear() === new Date(now).getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${same ? "" : ` ${d.getFullYear()}`}`;
}

export interface TileWords { title: string; kind: string; state: string | null; tone: LibraryState | null; date: string; credits: string | null; alt: string }

export function tileWords(item: LibraryItem, now: number = Date.now()): TileWords {
  const title = plainTitle(item);
  const kind = KIND_WORDS[item.kind];
  return {
    title, kind, state: item.state ? STATE_WORDS[item.state] : null, tone: item.state, date: dayWords(item.at, now), credits: creditWords(item.credits),
    alt: `${kind}: ${title}`,
  };
}

/** Where a chat opened from the Library goes: Miss Influencer makes the pictures, so a variation and a question go to her. */
export const LIBRARY_CHAT_WITH = "content-strategist";
const quoted = (item: LibraryItem): string => `"${plainTitle(item).slice(0, 80)}"`;
export const variationPrompt = (item: LibraryItem): string => `Make a variation of ${quoted(item)}`;
export const askPrompt = (item: LibraryItem): string => `About ${quoted(item)}: `;

/** The chat address with words already typed in the box (Chat reads ?q= and leaves it for the owner to send). */
export const chatPrefill = (prompt: string, who: string = LIBRARY_CHAT_WITH): string => `/chat/${encodeURIComponent(who)}?q=${encodeURIComponent(prompt)}`;

export interface SheetActions { download: { href: string; filename: string }; variation: string; ask: string; decide: boolean }

/** What the sheet offers for one item: Download, Make a variation, Ask about it; OK and Look only while it waits. */
export function sheetActions(item: LibraryItem): SheetActions {
  const ext = item.media === "video" ? "mp4" : "jpg";
  const slug = plainTitle(item).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "allevia";
  return {
    download: { href: item.url, filename: `${slug}.${ext}` },
    variation: chatPrefill(variationPrompt(item)), ask: chatPrefill(askPrompt(item)),
    decide: item.state === "waiting" && !!item.approvalId,
  };
}

export const EMPTY = { line: "Every post, ad and clip your team makes is kept here.", cta: "Make your first post in Chat" } as const;
export const emptyFor = (filter: LibraryFilter): string =>
  filter === "all" ? EMPTY.line : filter === "mine" ? "Photos you send in Chat are kept here." : filter === "videos" ? "No videos yet." : "No pictures yet.";

// ---------- the chat's photo attach ----------

/** What the owner's message says when they send a photo with no words (the server says the same: routes/chat-photo.ts). */
export const DEFAULT_PHOTO_NOTE = "Make a post from this photo";
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/** Why a picked file can't be sent, in the owner's words; null when it can. */
export function photoProblem(file: { type: string; size: number }): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return "Send a JPEG, PNG or WebP photo.";
  if (file.size > MAX_PHOTO_BYTES) return "That photo is too large: send one under 20 MB.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

/** The words sent with a photo: what the owner typed, or what a photo with no words is for. */
export const photoQuestion = (text: string): string => text.trim() || DEFAULT_PHOTO_NOTE;

/** The box's hint while a photo is attached. */
export const PHOTO_PLACEHOLDER = "Say what you want: a Diwali post, a premium ad…";
