// The brief behind every poster, picture and reel. The founder: "a nice poster, but what is the need of it?" A poster or an ad
// exists to sell or market something (a product, a top feature, an offer), so the creating tools take a brief:
//   goal        what it is for: sell a service, push an offer, announce something, or make the brand known
//   promoting   the thing it sells: an id from the graph where possible (product:..., feature:...), else its name
//   audience    who it is for
//   message     the one thing it says (the headline, word for word)
//   cta         what the viewer should do (word for word)
//   placement   where it goes: Instagram post, story, reel, flyer
// When something the piece needs is missing, the tool does not guess: it returns "needs brief" with the missing fields and at
// most three short questions, each with quick-reply options drawn from the business's own record, so the agent can ask the
// owner (Discord buttons, web chips) and come back. A per-company skill may fill the brief instead.
import type { GraphHandle } from "../graph/client.js";
import type { FormatKey } from "./compose/formats.js";
import type { Occasion } from "./compose/compose.js";

export const GOALS = ["sell", "offer", "announce", "awareness"] as const;
export type Goal = (typeof GOALS)[number];
export const PLACEMENTS = ["insta_post", "insta_story", "reel", "flyer"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export interface BriefInput {
  goal?: string; promoting?: string; audience?: string; message?: string; cta?: string; placement?: string; offer?: string;
}

export interface Brief {
  goal: Goal;
  promoting: { id?: string; name: string; summary?: string };
  audience: string;
  message: string;
  cta: string;
  placement: Placement;
  offer?: string;
}

export type BriefField = "goal" | "promoting" | "audience" | "message" | "cta" | "placement";

export interface QuickQuestion { field: BriefField; question: string; options: string[] }

export interface NeedsBrief { missing: BriefField[]; questions: QuickQuestion[]; known: Partial<Record<BriefField, string>> }

export type BriefResult = { ok: true; brief: Brief; defaulted: BriefField[] } | { ok: false; needs: NeedsBrief };

// What each kind of thing must have before it is made, and what may be defaulted (said so) instead of asked.
export const NEEDS: Record<"poster" | "image" | "reel", { required: BriefField[]; defaults: Partial<Record<BriefField, string>> }> = {
  poster: { required: ["promoting", "message", "cta", "goal", "audience", "placement"], defaults: { placement: "insta_post", goal: "sell" } },
  image: { required: ["promoting", "goal", "placement"], defaults: { placement: "insta_post", goal: "awareness" } },
  reel: { required: ["promoting", "message", "cta", "goal", "audience"], defaults: { goal: "sell", placement: "reel" } },
};

const ASK_ORDER: BriefField[] = ["promoting", "message", "cta", "audience", "goal", "placement"];
export const MAX_QUESTIONS = 3;

const clean = (s: string | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const GOAL_WORDS: Record<string, Goal> = { sell: "sell", sale: "sell", product: "sell", service: "sell", offer: "offer", discount: "offer", deal: "offer", announce: "announce", announcement: "announce", launch: "announce", news: "announce", event: "announce", awareness: "awareness", brand: "awareness" };
const PLACE_WORDS: Array<[RegExp, Placement]> = [[/story|stories/i, "insta_story"], [/reel/i, "reel"], [/flyer|print|a4|poster to print/i, "flyer"], [/post|insta|instagram|feed|square|portrait/i, "insta_post"]];

export const placementFormat = (p: Placement, square = false): FormatKey => (p === "insta_story" || p === "reel" ? "insta_story" : p === "flyer" ? "flyer" : square ? "insta_square" : "insta_portrait");
export const goalOccasion = (g: Goal): Occasion => (g === "offer" ? "offer" : g === "announce" ? "announcement" : "general");

interface Row { id: string; name: string | null; summary: string | null }

// The business's own things that could be promoted (products, services, features), its audiences and its contact routes.
async function options(g: GraphHandle): Promise<{ things: Row[]; audiences: string[]; ctas: string[] }> {
  const things = await g.roQuery<Row>("MATCH (p) WHERE p:Product OR p:Feature RETURN p.id AS id, p.name AS name, p.summary AS summary ORDER BY p.id LIMIT 12").catch(() => []);
  const aud = await g.roQuery<{ name: string | null }>("MATCH (a:Audience) RETURN a.name AS name ORDER BY a.id LIMIT 6").catch(() => []);
  const pages = await g.roQuery<{ url: string | null }>("MATCH (p:Page) WHERE p.url IS NOT NULL RETURN p.url AS url ORDER BY p.id LIMIT 1").catch(() => []);
  const host = pages[0]?.url ? (() => { try { return new URL(pages[0]!.url!).hostname.replace(/^www\./, ""); } catch { return null; } })() : null;
  const chans = await g.roQuery<{ handle: string | null }>("MATCH (c:Channel) WHERE c.handle IS NOT NULL AND c.rival IS NULL RETURN c.handle AS handle ORDER BY c.id LIMIT 2").catch(() => []);
  const ctas = [...(host ? [`Visit ${host}`] : []), "Send us a message", ...(chans[0]?.handle ? [`Follow @${chans[0].handle.replace(/^@/, "")}`] : []), "Book a call"];
  return { things: things.filter((t) => t.name), audiences: aud.map((a) => a.name).filter((n): n is string => !!n), ctas: ctas.slice(0, 4) };
}

// The brief, checked against the graph: the promoted thing resolved to its node when it can be, the rest exact.
export async function resolveBrief(g: GraphHandle, kind: keyof typeof NEEDS, input: BriefInput | undefined): Promise<BriefResult> {
  const b = input ?? {};
  const need = NEEDS[kind];
  const opt = await options(g);
  const known: Partial<Record<BriefField, string>> = {};
  const promotingRaw = clean(b.promoting, 120);
  let promoting: Brief["promoting"] | undefined;
  if (promotingRaw) {
    const byId = opt.things.find((t) => t.id === promotingRaw);
    const byName = opt.things.find((t) => (t.name ?? "").toLowerCase() === promotingRaw.toLowerCase());
    const hit = byId ?? byName;
    promoting = hit ? { id: hit.id, name: hit.name!, ...(hit.summary ? { summary: hit.summary } : {}) } : { name: promotingRaw };
    known.promoting = promoting.name;
  }
  const goalRaw = clean(b.goal, 40).toLowerCase();
  const goal = (GOALS as readonly string[]).includes(goalRaw) ? (goalRaw as Goal) : Object.entries(GOAL_WORDS).find(([w]) => goalRaw.includes(w))?.[1];
  const placeRaw = clean(b.placement, 40);
  const placement = (PLACEMENTS as readonly string[]).includes(placeRaw) ? (placeRaw as Placement) : PLACE_WORDS.find(([re]) => re.test(placeRaw))?.[1];
  const message = clean(b.message, 140), cta = clean(b.cta, 80), audience = clean(b.audience, 120);
  if (goal) known.goal = goal;
  if (placement) known.placement = placement;
  if (message) known.message = message;
  if (cta) known.cta = cta;
  if (audience) known.audience = audience;
  const have: Record<BriefField, boolean> = { goal: !!goal, promoting: !!promoting, audience: !!audience, message: !!message, cta: !!cta, placement: !!placement };
  const defaulted: BriefField[] = [];
  const missing = need.required.filter((f) => !have[f]);
  // defaults for what may be defaulted; ask about the rest, most important first, at most three
  const toAsk = ASK_ORDER.filter((f) => missing.includes(f) && need.defaults[f] === undefined);
  const audienceDefault = opt.audiences[0];
  // the record's own audience stands in for an audience the owner did not name (said so); with none on record, ask
  if (toAsk.includes("audience") && audienceDefault) toAsk.splice(toAsk.indexOf("audience"), 1);
  if (toAsk.length) {
    const questions: QuickQuestion[] = toAsk.slice(0, MAX_QUESTIONS).map((f) => {
      switch (f) {
        case "promoting": return { field: f, question: "What should it sell or promote?", options: opt.things.slice(0, 4).map((t) => t.name!) };
        case "message": return { field: f, question: `What is the one thing it should say${promoting ? ` about ${promoting.name}` : ""}? (Your words go on it exactly.)`, options: [] };
        case "cta": return { field: f, question: "What should people do next?", options: opt.ctas };
        case "audience": return { field: f, question: "Who is it for?", options: opt.audiences.slice(0, 4) };
        case "goal": return { field: f, question: "What is it for?", options: ["Sell a service", "Share an offer", "Announce something", "Make the brand known"] };
        default: return { field: f, question: "Where will it go?", options: ["Instagram post", "Instagram story", "Flyer"] };
      }
    });
    return { ok: false, needs: { missing: toAsk, questions, known } };
  }
  for (const f of missing) defaulted.push(f);
  const brief: Brief = {
    goal: goal ?? (need.defaults.goal as Goal), promoting: promoting ?? { name: "the business" },
    audience: audience || audienceDefault || "your customers", message, cta,
    placement: placement ?? (need.defaults.placement as Placement), ...(clean(b.offer, 60) ? { offer: clean(b.offer, 60) } : {}),
  };
  return { ok: true, brief, defaulted };
}
