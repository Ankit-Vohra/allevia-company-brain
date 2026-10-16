// What each kind of draft is called to an owner, and what saying OK does, in plain words (docs/owner-words.md). Shared by
// the Approvals page, the chat and Home, so a draft reads the same wherever it shows up. A fix says whether it is for the
// website or the app (shared/fix-words.ts), so an app crash is never "a fix for your website".
import type { ActionKind } from "../../../shared/contracts.js";
import { FIX_BUILDER, FIX_UNCHANGED, fixLabelCap, fixSubject } from "../../../shared/fix-words.js";

export interface KindWords { label: string; effect: (target?: string) => string; done: string }

type Card = { kind: ActionKind; title?: string; payload?: { target?: string }; preview?: { draftOnly?: boolean } };

const BASE: Record<Exclude<ActionKind, "github_issue">, KindWords> = {
  content_draft: { label: "A post draft", effect: () => "If you say OK, the draft is saved for you. Nothing is posted.", done: "Draft saved. Nothing was posted." },
  pause_ad: { label: "A change to an ad", effect: () => "If you say OK, the change is made to the ad. You can undo it from your ad account any time.", done: "The change was made." },
  discord_post: { label: "A message to your team chat", effect: (t) => `If you say OK, this is posted${t ? ` to ${t}` : ""}.`, done: "Posted." },
  calendar_event: { label: "A meeting on your calendar", effect: () => "If you say OK, the meeting is added to your calendar, and the guest is invited if one is named.", done: "Meeting added." },
  connection_action: { label: "A change in one of your tools", effect: (t) => `If you say OK, this is done${t ? ` in ${t}` : " in your connected tool"}. Nothing happens before.`, done: "Done." },
  email_send: { label: "An email from your address", effect: () => "If you say OK, this email is sent from your address. Nothing is sent before.", done: "Email sent." },
};

export function kindWords(a: Card): KindWords {
  // an email the team only drafts: it lands in the owner's inbox as a draft and nothing is sent
  if (a.kind === "email_send" && a.preview?.draftOnly) {
    return { label: "An email draft for your inbox", effect: () => "If you say OK, this is saved as a draft in your inbox. Nothing is sent.", done: "Draft saved in your inbox. Nothing was sent." };
  }
  if (a.kind !== "github_issue") return BASE[a.kind];
  const s = fixSubject(a.title, a.payload?.target);
  return {
    label: fixLabelCap(s),
    effect: () => `If you say OK, this goes to ${FIX_BUILDER[s]} as a to-do. ${FIX_UNCHANGED[s]}`,
    done: `Sent to ${FIX_BUILDER[s]}.`,
  };
}
