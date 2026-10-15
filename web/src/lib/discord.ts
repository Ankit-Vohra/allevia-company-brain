// What the owner is told about Discord, in plain words (docs/owner-words.md), as pure functions the cards render.
import type { DiscordHome, DiscordInfo } from "../../../shared/contracts";

export interface DiscordView { state: "invite" | "joined" | "expired" | "later"; inviteUrl?: string; openUrl?: string }

/** What the onboarding "done" event carried, as a view; nothing when this server has no Discord hub. */
export function viewOfInfo(d: DiscordInfo | undefined): DiscordView | null {
  if (!d) return null;
  if (d.inviteUrl) return { state: "invite", inviteUrl: d.inviteUrl };
  return d.later ? { state: "later" } : null;
}

/** What the Home page's endpoint said, as a view; nothing without a hub. */
export function viewOfHome(h: DiscordHome | undefined): DiscordView | null {
  if (!h?.enabled || !h.state) return null;
  return { state: h.state, ...(h.inviteUrl ? { inviteUrl: h.inviteUrl } : {}), ...(h.openUrl ? { openUrl: h.openUrl } : {}) };
}

export const DISCORD_WORDS = {
  inviteTitle: "Join your team on Discord",
  inviteLine: "Your team's own space is ready. This link is just for you and works once.",
  inviteButton: "Join on Discord",
  laterLine: "We'll send your Discord link shortly.",
  expiredTitle: "Your Discord link ran out",
  expiredButton: "Get a new link",
  joinedTitle: "Your team is on Discord",
  openButton: "Open Discord",
} as const;
