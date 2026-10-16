// What a card waiting for the owner's OK carries beyond its title and text, read from the draft's own stored payload: who an
// email goes to, when a meeting is and with whom, which pictures or clips a post comes with (and which one is our pick). The
// Home screen shows it inline so the owner can decide without opening anything; Discord's cards say the same (the web app
// and Discord read the same payload, src/discord/approval-extras.ts). Pure: no graph, no network.
import type { ActionKind } from "../../shared/contracts.js";
import { PLATFORMS, accountWords } from "../publish/platforms.js";
import { readBlock } from "../publish/types.js";
import { whenWords } from "../publish/when.js";
import type { ApprovalPreview } from "./types.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const list = (v: unknown, max = 8): string[] => {
  const xs = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
  return xs.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max);
};

function parse(raw: unknown): Record<string, unknown> {
  if (isObj(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** The first sentence of a reason, with no [[citation]] marks, as one line. */
export function oneLine(s: string | undefined, max = 200): string | undefined {
  const t = (s ?? "").replace(/\s*\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const first = /^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
}

const validDate = (v: unknown): string | undefined => {
  const s = text(v, 60);
  return s && Number.isFinite(Date.parse(s)) ? s : undefined;
};

/** Undefined when there is nothing to add to the title and the text. */
export function previewOf(raw: unknown, o: { kind: ActionKind; why?: string }): ApprovalPreview | undefined {
  const p = parse(raw);
  const out: ApprovalPreview = {};

  const studio = isObj(p.studio) ? p.studio : undefined;
  // a Studio card's reason is a machine note about checks and credits; the pictures and the caption say what it is
  const why = studio ? undefined : oneLine(o.why);
  if (why) out.why = why;

  if (o.kind === "email_send") {
    const to = list(p.to ?? p.recipient ?? p.recipients).join(", ");
    if (to) out.to = to;
    const cc = list(p.cc).join(", ");
    if (cc) out.cc = cc;
    const subject = text(p.subject, 200);
    if (subject) out.subject = subject;
    if (p.send === false) out.draftOnly = true;
  }

  if (o.kind === "calendar_event") {
    const start = validDate(p.start);
    if (start) {
      const end = validDate(p.end);
      const tz = text(p.timeZone, 60);
      out.when = { start, ...(end ? { end } : {}), ...(tz ? { timeZone: tz } : {}), guests: list(p.attendees ?? p.guests, 5) };
    }
  }

  if (o.kind === "publish_post") {
    const pub = readBlock(p.publish);
    if (pub) {
      const spec = PLATFORMS[pub.platform];
      out.post = {
        where: `${spec.name} (${accountWords(spec, pub.account)})`,
        ...(pub.at ? { when: { at: new Date(pub.at).toISOString(), ...(pub.tz ? { timeZone: pub.tz } : {}), words: whenWords(pub.at, pub.tz ?? "UTC") } } : {}),
        ...(spec.media === "never" && studio ? { textOnly: true } : {}),
      };
    }
  }

  if (studio && Array.isArray(studio.variants)) {
    const recommended = text(studio.recommended, 200);
    const options = studio.variants.filter(isObj).slice(0, 6).flatMap((v) => {
      const id = text(v.id, 200);
      const label = text(v.label, 20);
      if (!id || !label) return [];
      return [{ id, label, note: (text(v.note, 200) ?? "").replace(/^Building unchanged · /, "").replace(/^Changed: /, ""), pick: id === recommended, held: v.badge === "held" }];
    });
    if (options.length) {
      const creative = isObj(studio.creative) ? studio.creative : undefined;
      const kind = creative?.kind === "poster" || creative?.kind === "image" || creative?.kind === "clip" ? creative.kind : "photo";
      out.media = { kind, options };
    }
  }

  return Object.keys(out).length ? out : undefined;
}
