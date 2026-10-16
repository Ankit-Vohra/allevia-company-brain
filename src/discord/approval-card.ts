// What the owner sees in the business's own #approvals channel (and under Today's note): the thing itself, not just a
// title. A card says what it is and who made it, why in one line, then the content: the full text of a post, the words of
// a message with who it goes to, the website words with what is on the page now, the picture or the clip attached, and the
// options when there are several. Then Approve, Change and No thanks; after a decision the same message shows the result.
// Pure: it takes the approval and what was looked up for it (src/discord/approval-extras.ts) and returns messages.
import { FIX_LABEL, fixSubject } from "../../shared/fix-words.js";
import { agentById } from "../../shared/roster.js";
import { fixDestinationWords, validRepo, type ActionTarget } from "../actions/target.js";
import type { ApprovalDto } from "../server/types.js";
import { buttonId, changeButtonId, type ButtonSpec, type OutFile } from "./bot.js";
import { DISCORD_MAX, splitMessage } from "./format.js";

// What each card is, in the owner's words (the web app's Approvals page says the same).
export const KIND_LABEL: Record<ApprovalDto["kind"], string> = {
  github_issue: "a fix for your website", content_draft: "a draft post", pause_ad: "pausing an ad", discord_post: "a message to your team chat",
  calendar_event: "a meeting on your calendar", email_send: "an email from your address", connection_action: "a change in one of your connected tools",
};

/** What a card is, in the owner's words. A fix says whether it is for the website or the app (shared/fix-words.ts). */
export const kindLabel = (a: Pick<ApprovalDto, "kind" | "title" | "payload">): string =>
  a.kind === "github_issue" ? FIX_LABEL[fixSubject(a.title, a.payload.target)] : (KIND_LABEL[a.kind] ?? a.kind);

export interface CardOption { label: string; note: string; pick: boolean; held?: boolean }

/** What was looked up for a card beyond the approval itself. All of it optional. */
export interface CardExtras {
  why?: string;                                // the one-line reason
  before?: { label: string; text: string };    // website fixes: what the page says now
  to?: string;                                 // emails and messages: who it goes to
  subject?: string;
  options?: CardOption[];                      // several versions to choose from (Studio, posters, clips)
  files?: OutFile[];                           // the pictures or clips themselves, already small enough to attach
  notAttached?: number;                        // files left out for size: said, with a link
  webUrl?: string;                             // where to see them
}

export interface CardOpts {
  target?: ActionTarget;
  buttons?: boolean;                           // false once decided
  standup?: boolean;                           // a draft from today's stand-up: "drafted by", and the line that nothing goes out
}

export interface CardMessages {
  first: { content: string; buttons: ButtonSpec[]; files?: OutFile[] };
  rest: string[];                              // the rest of a long text, in order, after the first message
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const quote = (s: string): string => s.split("\n").map((l) => `> ${l}`).join("\n");
const FIRST_MAX = DISCORD_MAX - 100; // room for a verdict line added after a decision

/** The first sentence of a reason, as one line. */
export const oneLineWhy = (s: string | undefined, max = 220): string | undefined => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const first = /^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
  return clip(first, max);
};

export function renderApproval(a: ApprovalDto, x: CardExtras = {}, o: CardOpts = {}): CardMessages {
  const who = agentById(a.by)?.name ?? a.by;
  const about = a.payload.target && !(a.kind === "github_issue" && validRepo(a.payload.target)) ? a.payload.target : undefined;
  const label = o.standup ? `drafted by ${who}` : `${kindLabel(a)}${a.simulated ? " (sample numbers)" : ""}`;
  const head = [
    `**${clip(a.title, 200)}** · ${label}`,
    ...(o.standup ? [] : [`Proposed by ${who} · ${a.createdAt.slice(0, 10)}`]),
    ...(x.why ? [`Why: ${x.why}`] : []),
    ...(x.to ? [`To: ${clip(x.to, 200)}`] : []),
    ...(x.subject ? [`Subject: ${clip(x.subject, 200)}`] : []),
    ...(x.before?.text.trim() ? [`${x.before.label}:`, quote(clip(x.before.text.trim(), 600)), "New:"] : []),
  ];
  const tail = [
    ...(x.options?.length ? [x.options.map((p) => `**${p.label}**${p.pick ? " (our pick)" : ""}${p.held ? " (held back, can't be approved)" : ""}${p.note ? `: ${clip(p.note, 140)}` : ""}`).join("\n"),
      "Approving uses our pick."] : []),
    ...(x.files?.length ? [`Attached: ${x.files.map((f) => f.name).join(", ")}`] : []),
    ...(x.notAttached ? [`${x.notAttached === 1 ? "One file is" : `${x.notAttached} files are`} too big to attach${x.webUrl ? `: ${x.webUrl}` : ""}`] : []),
    ...(!o.standup && about ? [`About: ${clip(about, 200)}`] : []),
    ...(!o.standup && a.kind === "github_issue" && o.buttons !== false ? [fixDestinationWords(o.target, fixSubject(a.title, a.payload.target))] : []),
    ...(o.standup ? ["Nothing goes out until you say OK."] : []),
  ];

  // the draft in full: whatever does not fit the first message follows in the next ones
  const body = a.payload.body.trim();
  const fixed = [...head, ...tail].join("\n").length + 2;
  const room = Math.max(300, FIRST_MAX - fixed);
  const quoted = body ? quote(body) : "";
  let firstBody = quoted;
  let rest: string[] = [];
  if (quoted.length > room) {
    const parts = splitMessage(quoted, room);
    firstBody = `${parts[0] ?? ""}\n> …(continues below)`;
    rest = splitMessage(parts.slice(1).join("\n"), FIRST_MAX);
  }
  const content = [...head, ...(firstBody ? [firstBody] : []), ...tail].join("\n");

  const ids = [buttonId("approve", a.id), changeButtonId(a.id), buttonId("reject", a.id)];
  const fits = ids.every((id) => id.length <= 100); // Discord's custom_id limit
  const buttons: ButtonSpec[] = o.buttons === false || !fits ? [] : [
    { customId: ids[0]!, label: "Approve", style: "success" },
    { customId: ids[1]!, label: "Change", style: "secondary" },
    { customId: ids[2]!, label: "No thanks", style: "danger" },
  ];
  const note = o.buttons !== false && !fits ? "\n_Decide this one in the web app._" : "";
  return { first: { content: clip(content + note, FIRST_MAX + 90), buttons, ...(x.files?.length ? { files: x.files } : {}) }, rest };
}

/** The verdict line for a decided card, with what came of it. */
export function verdictLine(a: Pick<ApprovalDto, "status" | "result">): string {
  const v = a.status === "rejected" ? "❌ No thanks" : `✅ Approved${a.status === "edited" ? " (changed first)" : ""}`;
  return `${v}${a.result ? ` · ${clip(a.result.replace(/\s+/g, " "), 240)}` : ""}`;
}
