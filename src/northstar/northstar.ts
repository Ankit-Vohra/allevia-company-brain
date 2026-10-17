// The business's north star: the one outcome all the team's work is for, said once in the brain so every agent and every
// brief serves it. The founder, 2026-10-17: "Blue Tokai wants more people in their stores to have coffee, Aamdani wants more
// downloads of the app, AVS Atelier wants more interior and architecture projects. All this should be thought about while
// designing content or ads or anything."
//
// In the graph it is one active Memory{kind:'north_star'} ABOUT the Business:
//   outcome       "more app downloads and sign-ups"           (the owner reads this as "your main goal")
//   outcomeKind   downloads | visits | orders | enquiries | bookings | signups | sales
//   audiences     who it is for, most important first
//   offer         what we offer them, in a phrase
//   ctaKind/ctaText/ctaUrl          the preferred call to action ("Download the app", the Play Store link)
//   altCtaKind/altCtaText/altCtaUrl a second one that serves the same outcome (a café: visit, or order online)
//   channel       where the action happens ("Play Store and App Store", "our cafés", "WhatsApp")
//   source        onboarding (derived from the website, the growth-plan goals and the industry) | owner (said in chat) |
//                 backfill (the CLI, from the brain) ; with asOf (the date) and SOURCED_FROM the Document it came from
// A newer one SUPERSEDES the older, which is kept with status 'superseded' (the history stays). Derivation is code over what
// the graph already holds: no model, no spend.
import type { GraphHandle } from "../graph/client.js";
import { writeBatch, type EdgeInput, type NodeInput, type Prim } from "../graph/upsert.js";
import { entityId, sha256 } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { UnsafeQuery } from "../graph/errors.js";

// A read that cannot run is an empty answer, except a query the safety check refuses: that is a bug, so it surfaces.
const soft = (e: unknown): never[] => { if (e instanceof UnsafeQuery) throw e; return []; };

type Read = Pick<GraphHandle, "roQuery">;

export const OUTCOME_KINDS = ["downloads", "visits", "orders", "enquiries", "bookings", "signups", "sales"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];
export const CTA_KINDS = ["download", "visit", "order", "enquire", "book", "signup", "buy", "website", "follow", "message"] as const;
export type CtaKind = (typeof CTA_KINDS)[number];
export type NorthStarSource = "onboarding" | "owner" | "backfill";

export interface Cta { kind: CtaKind; text: string; url?: string }

export interface NorthStar {
  id: string;
  outcome: string;
  outcomeKind: OutcomeKind;
  audiences: string[];
  offer: string;
  cta: Cta;
  altCta?: Cta;
  channel: string;
  source: NorthStarSource;
  sourceRef?: string;       // the Document (a web page, the directive, the CLI run) it came from
  asOf: string;             // YYYY-MM-DD
}

export type NorthStarInput = Omit<NorthStar, "id" | "asOf"> & { asOf?: string };

// What each outcome asks people to do, and the words for it, when nothing better is on record.
export const OUTCOME_CTA: Record<OutcomeKind, Cta> = {
  downloads: { kind: "download", text: "Download the app" },
  visits: { kind: "visit", text: "Visit us today" },
  orders: { kind: "order", text: "Order online" },
  enquiries: { kind: "enquire", text: "Send us an enquiry" },
  bookings: { kind: "book", text: "Book your slot" },
  signups: { kind: "signup", text: "Sign up free" },
  sales: { kind: "buy", text: "Shop now" },
};

export const OUTCOME_WORDS: Record<OutcomeKind, string> = {
  downloads: "more app downloads", visits: "more people visiting", orders: "more orders", enquiries: "more enquiries",
  bookings: "more bookings", signups: "more sign-ups", sales: "more sales",
};

// The outcome a sentence names ("our main goal is more app installs" -> downloads), or undefined.
export function outcomeKindOf(text: string): OutcomeKind | undefined {
  const t = text.toLowerCase();
  if (/\b(?:download|install|app store|play store|get the app)/.test(t)) return "downloads";
  if (/\b(?:enquir|inquir|leads?\b|projects?\b|consultation|commission)/.test(t)) return "enquiries";
  if (/\b(?:visit|footfall|walk-?ins?|in (?:the |our )?(?:store|caf[eé]|shop|outlet)s?|people in)/.test(t)) return "visits";
  if (/\b(?:orders?|delivery|deliveries)\b/.test(t)) return "orders";
  if (/\b(?:book|appointment|reservation)/.test(t)) return "bookings";
  if (/\b(?:sign-?ups?|signups?|register|registrations?|users?|accounts?)\b/.test(t)) return "signups";
  if (/\b(?:sales?|sell|revenue|purchases?|buy)/.test(t)) return "sales";
  return undefined;
}

// What a call to action asks for ("Visit app.aamdani.ai" -> website, "Download the app" -> download), or undefined.
export function ctaKindOf(text: string): CtaKind | undefined {
  const t = text.toLowerCase().trim();
  if (/\b(?:download|install|get (?:it|the app) on|play store|app store|get the app)/.test(t)) return "download";
  if (/\b(?:whatsapp|enquir|inquir|consult|request a quote|get a quote|tell us about your (?:project|home))/.test(t)) return "enquire";
  if (/\b(?:sign ?up|register|join free|create (?:an |your )?account)/.test(t)) return "signup";
  if (/\b(?:order|delivery|deliver)/.test(t)) return "order";
  if (/\b(?:book|reserve|appointment)/.test(t)) return "book";
  if (/\b(?:shop|buy)\b/.test(t)) return "buy";
  if (/\bfollow\b/.test(t)) return "follow";
  if (/\b(?:message us|dm us|call us|send us a message)/.test(t)) return "message";
  // "visit <a web address>" is a website visit, not a visit in person
  if (/\bvisit\b/.test(t) && /[a-z0-9-]+\.[a-z]{2,}/.test(t)) return "website";
  if (/\b(?:visit|drop by|drop in|come (?:in|by|over)|find (?:us|your nearest)|walk in|see you at)/.test(t)) return "visit";
  if (/[a-z0-9-]+\.[a-z]{2,}/.test(t) || /\b(?:website|link in bio)\b/.test(t)) return "website";
  return undefined;
}

// A call to action that serves the north star: the preferred kind or the second one. A plain "message us" or a website is
// the wrong ask for an app whose goal is downloads.
export function ctaServes(ns: Pick<NorthStar, "cta" | "altCta" | "outcomeKind">, text: string): boolean {
  const k = ctaKindOf(text);
  if (!k) return true; // can't tell: leave the owner's or writer's words alone
  const ok = new Set<CtaKind>([ns.cta.kind, ...(ns.altCta ? [ns.altCta.kind] : [])]);
  // an enquiry can be a message or a booked consultation; a booking can be a message too
  if (ok.has("enquire")) { ok.add("message"); ok.add("book"); }
  if (ok.has("book")) ok.add("message");
  return ok.has(k);
}

export const northStarId = (businessId: string, at: string, outcome: string): string =>
  entityId("Memory", `north star ${businessId.replace(/^business:/, "")} ${at} ${sha256(outcome).slice(0, 6)}`);

// ---------- reading ----------

interface Row { p: Record<string, unknown>; src: string | null }

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const kindOr = <T extends string>(v: unknown, all: readonly T[], d: T): T => (typeof v === "string" && (all as readonly string[]).includes(v) ? v as T : d);

function fromProps(p: Record<string, unknown>, src: string | null): NorthStar | null {
  const outcome = str(p.outcome);
  if (!outcome) return null;
  const outcomeKind = kindOr(p.outcomeKind, OUTCOME_KINDS, outcomeKindOf(outcome) ?? "sales");
  const cta = (k: unknown, t: unknown, u: unknown): Cta | undefined => {
    const text = str(t);
    if (!text) return undefined;
    const url = str(u);
    return { kind: kindOr(k, CTA_KINDS, ctaKindOf(text) ?? OUTCOME_CTA[outcomeKind].kind), text, ...(url ? { url } : {}) };
  };
  const audiences = Array.isArray(p.audiences) ? p.audiences.filter((a): a is string => typeof a === "string" && !!a.trim()) : [];
  const alt = cta(p.altCtaKind, p.altCtaText, p.altCtaUrl);
  return {
    id: String(p.id), outcome, outcomeKind, audiences, offer: str(p.offer) ?? "", cta: cta(p.ctaKind, p.ctaText, p.ctaUrl) ?? OUTCOME_CTA[outcomeKind],
    ...(alt ? { altCta: alt } : {}), channel: str(p.channel) ?? "", source: kindOr(p.source, ["onboarding", "owner", "backfill"] as const, "onboarding"),
    ...(src ? { sourceRef: src } : {}), asOf: str(p.asOf) ?? "",
  };
}

/** The business's active north star, or null when none is recorded. */
export async function loadNorthStar(g: Read): Promise<NorthStar | null> {
  const rows = await g.roQuery<Row>(
    `MATCH (m:Memory) WHERE m.kind = 'north_star' AND coalesce(m.status, 'active') = 'active'
     OPTIONAL MATCH (m)-[s:SOURCED_FROM]->(d:Document) WHERE s.until IS NULL
     WITH m, head(collect(d.id)) AS src ORDER BY m.at DESC, m.id DESC
     RETURN properties(m) AS p, src LIMIT 1`);
  const r = rows[0];
  return r ? fromProps(r.p, r.src) : null;
}

export interface PlanGoal { id: string; name: string; priority: number | null }

/** The growth plan's goals (at most three), most important first. */
export async function loadPlanGoals(g: Read): Promise<PlanGoal[]> {
  return g.roQuery<PlanGoal>(
    `MATCH (:Business)-[e:PURSUES]->(x:Goal) WHERE e.until IS NULL AND coalesce(x.status, 'active') <> 'retired'
     RETURN DISTINCT x.id AS id, x.name AS name, x.priority AS priority ORDER BY coalesce(priority, 9), id LIMIT 3`).catch(soft);
}

// ---------- the block every agent reads ----------

export function ctaLine(c: Cta): string {
  return `${c.text}${c.url ? ` (${c.url})` : ""}`;
}

/** The short block at the top of every agent's work: the north star and the growth plan's goals. */
export function northStarBlock(ns: NorthStar | null, goals: readonly PlanGoal[] = []): string {
  const plan = goals.length ? `- Growth-plan goals: ${goals.map((x) => `${x.name} [[${x.id}]]`).join("; ")}` : "";
  if (!ns) {
    return [
      "The business's main goal: not recorded yet.",
      plan,
      "- Work toward the growth-plan goals above, if any. When a piece of work needs the goal (a post, an ad, a plan), ask the owner once what they most want more of (app downloads, visits, orders, enquiries, bookings, sign-ups) and say what you went with until they answer.",
    ].filter(Boolean).join("\n");
  }
  return [
    `The business's main goal (north star) [[${ns.id}]], ${ns.source === "owner" ? "set by the owner" : `from ${ns.source === "onboarding" ? "onboarding" : "the records"}`}${ns.asOf ? ` on ${ns.asOf}` : ""}:`,
    `- Outcome: ${ns.outcome}`,
    ns.audiences.length ? `- For: ${ns.audiences.join("; ")}` : "",
    ns.offer ? `- Offer: ${ns.offer}` : "",
    `- Call to action: ${ctaLine(ns.cta)}${ns.altCta ? `; or ${ctaLine(ns.altCta)}` : ""}${ns.channel ? ` (where: ${ns.channel})` : ""}`,
    plan,
    "- Everything you do serves this outcome: say in one line how your work moves it. When the owner asks for something else, do what they asked; their words win.",
  ].filter(Boolean).join("\n");
}

// ---------- writing ----------

/** The write for a new north star: the Memory, ABOUT the Business, SOURCED_FROM its Document, STATED by the owner when they said it;
 * an earlier active one is SUPERSEDED (kept, status 'superseded'). Returns nothing to write when it says the same as the active one. */
export async function northStarWrite(
  g: Read, input: NorthStarInput & { businessId: string; now: number; statedBy?: string },
): Promise<{ id: string; write: { nodes: NodeInput[]; edges: EdgeInput[] }; same: boolean; previous: NorthStar | null }> {
  const previous = await loadNorthStar(g);
  const asOf = input.asOf ?? isoDate(input.now);
  const same = !!previous && previous.outcome === input.outcome && previous.cta.text === input.cta.text && previous.offer === input.offer
    && previous.audiences.join("|") === input.audiences.join("|") && (previous.altCta?.text ?? "") === (input.altCta?.text ?? "");
  if (same) return { id: previous!.id, write: { nodes: [], edges: [] }, same: true, previous };
  const id = northStarId(input.businessId, `${asOf} ${input.now}`, input.outcome);
  const src = input.sourceRef;
  const props: Record<string, Prim> = {
    kind: "north_star", status: "active", at: input.now, outcome: input.outcome, outcomeKind: input.outcomeKind, audiences: input.audiences.slice(0, 4),
    offer: input.offer, ctaKind: input.cta.kind, ctaText: input.cta.text, ...(input.cta.url ? { ctaUrl: input.cta.url } : {}),
    ...(input.altCta ? { altCtaKind: input.altCta.kind, altCtaText: input.altCta.text, ...(input.altCta.url ? { altCtaUrl: input.altCta.url } : {}) } : {}),
    channel: input.channel, source: input.source, text: `Main goal: ${input.outcome}. Call to action: ${input.cta.text}.`,
  };
  const nodes: NodeInput[] = [{ type: "Memory", id, name: `Main goal: ${input.outcome}`.slice(0, 120), summary: northStarBlock({ ...input, id, asOf }).slice(0, 600), asOf, props, ...(src ? { src } : {}) }];
  const edges: EdgeInput[] = [
    { from: id, type: "ABOUT", to: input.businessId, ...(src ? { src } : {}) },
    ...(src ? [{ from: id, type: "SOURCED_FROM" as const, to: src, src }] : []),
    ...(input.statedBy ? [{ from: input.statedBy, type: "STATED" as const, to: id, ...(src ? { src } : {}) }] : []),
  ];
  if (previous) {
    nodes.push({ type: "Memory", id: previous.id, name: `Main goal: ${previous.outcome}`.slice(0, 120), props: { status: "superseded", supersededAt: input.now } });
    edges.push({ from: id, type: "SUPERSEDES", to: previous.id, ...(src ? { src } : {}) });
  }
  return { id, write: { nodes, edges }, same: false, previous };
}

export async function saveNorthStar(g: GraphHandle, input: NorthStarInput & { businessId: string; now: number; statedBy?: string }): Promise<{ id: string; same: boolean; errors: string[] }> {
  const r = await northStarWrite(g, input);
  if (r.same) return { id: r.id, same: true, errors: [] };
  const s = await writeBatch(g, r.write, input.now);
  return { id: r.id, same: false, errors: s.errors.map((e) => e.error) };
}

// ---------- deriving it from the brain ----------

interface Facts {
  name: string; templateKey: string | null; industry: string | null; vertical: string | null; domain: string | null; summary: string | null;
  audiences: string[]; products: string[]; goals: string[];
  channels: Array<{ id: string; name: string | null; url: string | null; handle: string | null; platform: string | null }>;
  pages: Array<{ id: string; url: string; title: string | null }>;
  docs: string[]; // web page Documents, home first
}

async function facts(g: Read, businessId: string): Promise<Facts> {
  const [b] = await g.roQuery<{ name: string | null; tk: string | null; ind: string | null; vert: string | null; dom: string | null; sum: string | null }>(
    "MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name, b.templateKey AS tk, b.industry AS ind, b.vertical AS vert, b.domain AS dom, b.summary AS sum", { id: businessId });
  const audiences = await g.roQuery<{ name: string | null }>(
    `MATCH (a:Audience) OPTIONAL MATCH (x)-[t:TARGETS]->(a) WHERE t.until IS NULL AND NOT x:Competitor
     WITH a, count(x) AS n RETURN a.name AS name ORDER BY n DESC, a.id LIMIT 4`).catch(soft);
  const products = await g.roQuery<{ name: string | null }>(
    // what the business sells: real products (not app features or funnel steps, never sample records); features only when no product exists
    `MATCH (p) WHERE (p:Product OR p:Feature) AND p.mergedInto IS NULL AND coalesce(p.simulated, false) = false
     OPTIONAL MATCH (rival:Competitor)-[ow:OWNS]->(p) WITH p, ow WHERE ow IS NULL
     OPTIONAL MATCH (p)<-[r]-() WITH p, count(r) AS n
     RETURN p.name AS name ORDER BY CASE WHEN p:Product THEN 0 ELSE 1 END, n DESC, p.id LIMIT 4`).catch(soft);
  const channels = await g.roQuery<Facts["channels"][number]>(
    "MATCH (c:Channel) WHERE c.rival IS NULL RETURN c.id AS id, c.name AS name, c.url AS url, c.handle AS handle, c.platform AS platform ORDER BY c.id LIMIT 40").catch(soft);
  const pages = await g.roQuery<{ id: string; url: string | null; title: string | null }>(
    "MATCH (p:Page) WHERE p.url IS NOT NULL RETURN p.id AS id, p.url AS url, p.name AS title ORDER BY size(p.url), p.id LIMIT 200").catch(soft);
  const docs = await g.roQuery<{ id: string }>(
    "MATCH (d:Document) WHERE d.kind = 'webpage' RETURN d.id AS id ORDER BY size(coalesce(d.url, d.id)), d.id LIMIT 1").catch(soft);
  const goals = await loadPlanGoals(g);
  return {
    name: b?.name ?? businessId, templateKey: b?.tk ?? null, industry: b?.ind ?? null, vertical: b?.vert ?? null, domain: b?.dom ?? null, summary: b?.sum ?? null,
    audiences: audiences.map((a) => a.name).filter((n): n is string => !!n), products: products.map((p) => p.name).filter((n): n is string => !!n),
    goals: goals.map((x) => x.name), channels, pages: pages.flatMap((p) => (p.url ? [{ id: p.id, url: p.url, title: p.title }] : [])), docs: docs.map((d) => d.id),
  };
}

const APP_STORE = /play\.google\.com|apps\.apple\.com|itunes\.apple\.com/i;
const has = (xs: Array<string | null | undefined>, re: RegExp): boolean => xs.some((x) => !!x && re.test(x));

/** The outcome kind the brain points to: the industry template first, then what the business has (an app, a booking page, cafés). */
export function outcomeFromFacts(f: Pick<Facts, "templateKey" | "industry" | "vertical" | "summary" | "goals" | "channels" | "pages">): OutcomeKind {
  const text = [f.industry, f.vertical, f.summary, ...f.goals].filter(Boolean).join(" ");
  const appLink = f.channels.some((c) => has([c.url, c.id, c.name, c.platform], /play store|app store|google play|apple/i) || has([c.url], APP_STORE)) || f.pages.some((p) => APP_STORE.test(p.url));
  switch (f.templateKey) {
    case "jobs_platform": return appLink || /\bapp\b/i.test(text) ? "downloads" : "signups";
    case "software_product": return appLink ? "downloads" : "signups";
    case "architecture_studio": return "enquiries";
    case "health_and_beauty": return "bookings";
    case "food_and_drink": return "visits";
    case "online_shop": return "orders";
    default: break;
  }
  return outcomeKindOf(text) ?? (appLink ? "downloads" : "enquiries");
}

function ctaFor(kind: OutcomeKind, f: Facts): { cta: Cta; altCta?: Cta; channel: string } {
  const urls = [...f.channels.map((c) => c.url), ...f.pages.map((p) => p.url)].filter((u): u is string => !!u);
  const pick = (re: RegExp) => urls.find((u) => re.test(u));
  const wa = f.channels.find((c) => has([c.id, c.name, c.platform, c.url], /whatsapp|wa\.me/i));
  switch (kind) {
    case "downloads": {
      const play = pick(/play\.google\.com/i), apple = pick(/apps\.apple\.com|itunes\.apple\.com/i);
      return { cta: { kind: "download", text: "Download the app", ...(play ?? apple ? { url: (play ?? apple)! } : {}) }, channel: play && apple ? "Play Store and App Store" : apple ? "App Store" : "Play Store" };
    }
    case "visits": {
      // a store-locator page, never a blog post or press article that happens to mention cafés
      const locator = f.pages.map((p) => p.url ?? "").find((u) => /store|locat|cafe|caf%C3%A9|outlet|find-us|visit/i.test(u) && !/\/(blog|blogs|press|news|article)s?\//i.test(u));
      const order = pick(/order|shop|delivery/i);
      return {
        cta: { kind: "visit", text: "Visit your nearest café", ...(locator ? { url: locator } : {}) },
        ...(order ? { altCta: { kind: "order" as const, text: "Order online", url: order } } : {}),
        channel: "our cafés",
      };
    }
    case "enquiries": {
      const form = pick(/contact|enquir|inquir|consult|quote/i);
      return wa
        ? { cta: { kind: "enquire", text: "Enquire on WhatsApp", ...(wa.url ? { url: wa.url } : {}) }, ...(form ? { altCta: { kind: "enquire" as const, text: "Send an enquiry", url: form } } : {}), channel: "WhatsApp" }
        : { cta: { kind: "enquire", text: "Send an enquiry", ...(form ? { url: form } : {}) }, channel: form ? "the enquiry form" : "a message" };
    }
    case "bookings": {
      const book = pick(/book|appoint|reserv/i);
      return { cta: { kind: "book", text: "Book your slot", ...(book ? { url: book } : {}) }, channel: book ? "the booking page" : "a message" };
    }
    case "orders": case "sales": {
      const shop = pick(/shop|order|store|product/i);
      return { cta: { kind: kind === "orders" ? "order" : "buy", text: kind === "orders" ? "Order online" : "Shop now", ...(shop ? { url: shop } : {}) }, channel: "the online shop" };
    }
    default: {
      const sign = pick(/sign-?up|register|join|start/i);
      return { cta: { kind: "signup", text: "Sign up free", ...(sign ? { url: sign } : {}) }, channel: f.domain ?? "the website" };
    }
  }
}

/** The north star the brain points to, derived by code from the industry template, the goals, the audiences, the products, and the
 * app-store, WhatsApp and booking links on record. `preset` overrides parts (the backfill's known outcomes). */
export async function deriveNorthStar(g: Read, o: { businessId: string; preset?: Partial<NorthStarInput>; source?: NorthStarSource }): Promise<NorthStarInput> {
  const f = await facts(g, o.businessId);
  const outcomeKind = o.preset?.outcomeKind ?? outcomeFromFacts(f);
  const c = ctaFor(outcomeKind, f);
  const offer = f.products.length ? f.products.slice(0, 2).join(" and ") : (f.summary ?? f.vertical ?? f.industry ?? "").slice(0, 140);
  const base: NorthStarInput = {
    outcome: OUTCOME_WORDS[outcomeKind], outcomeKind, audiences: f.audiences.slice(0, 3), offer, cta: c.cta, ...(c.altCta ? { altCta: c.altCta } : {}),
    channel: c.channel, source: o.source ?? "onboarding", ...(f.docs[0] ? { sourceRef: f.docs[0] } : {}),
  };
  const p = o.preset ?? {};
  // a preset's call to action keeps the link found on record when it gives none
  const cta = p.cta ? { ...p.cta, ...(p.cta.url ?? (base.cta.kind === p.cta.kind ? base.cta.url : undefined) ? { url: (p.cta.url ?? base.cta.url)! } : {}) } : base.cta;
  return {
    ...base, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && v !== "")), cta,
    ...(p.altCta ?? base.altCta ? { altCta: (p.altCta ?? base.altCta)! } : {}),
    audiences: p.audiences?.length ? p.audiences : base.audiences,
  } as NorthStarInput;
}

// ---------- the owner's own words ----------

// "our main goal is more app downloads" / "main goal: more café visits" / "what we want most is enquiries"
const MAIN_GOAL = /^(?:please\s+)?(?:(?:our|my|the)\s+)?(?:(?:main|primary|biggest|top|real|one|number one|#1|core)\s+)?(?:goal|aim|objective|focus|priority|north star)(?:\s+(?:right now|now|this year|for (?:now|the business)))?\s*(?:is|=|:|should be)\s+(?:to\s+(?:get\s+)?)?(?<goal>.{4,200})$/i;
const WANT_MOST = /^(?:what\s+)?we\s+(?:most\s+)?want\s+(?:most\s+)?(?:is\s+)?(?<goal>(?:more|to get more)\s+.{3,200})$/i;

/** The goal in a sentence that sets the main goal, or undefined. A "goal" with a number for one metric ("goal is 40 enquiries a week")
 * is still the main outcome; the growth plan's numbers are set elsewhere. */
export function mainGoalIn(text: string): { goal: string; kind?: OutcomeKind } | undefined {
  const t = text.trim().replace(/[.!]+$/, "");
  const m = MAIN_GOAL.exec(t)?.groups?.goal ?? WANT_MOST.exec(t)?.groups?.goal;
  if (!m) return undefined;
  const goal = m.trim().replace(/^(?:to\s+)?(?:get|have|drive|bring in|grow)\s+/i, "").replace(/\s+/g, " ");
  const kind = outcomeKindOf(goal);
  return { goal: /^more\b/i.test(goal) || !kind ? goal : `more ${goal}`, ...(kind ? { kind } : {}) };
}

/** The north star after the owner says what the main goal is: their words as the outcome, the call to action that fits it (kept when
 * it still fits), the audiences and offer kept. */
export function ownerNorthStar(previous: NorthStar | null, said: { goal: string; kind?: OutcomeKind }, sourceRef: string): NorthStarInput {
  const kind = said.kind ?? previous?.outcomeKind ?? "sales";
  const keep = previous && previous.outcomeKind === kind;
  return {
    outcome: said.goal, outcomeKind: kind, audiences: previous?.audiences ?? [], offer: previous?.offer ?? "",
    cta: keep ? previous!.cta : OUTCOME_CTA[kind], ...(keep && previous!.altCta ? { altCta: previous!.altCta } : {}),
    channel: keep ? previous!.channel : "", source: "owner", sourceRef,
  };
}
