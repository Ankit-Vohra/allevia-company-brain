// Each business's own skills, written from its own graph: <company>-brand-voice, <company>-domain, <company>-reel and
// <company>-ad. Modelled on Aamdani's hand-written reel pipeline (the founder's aamdani-brand-voice, aamdani-domain and
// aamdani-reel skills): the voice and the words that misfire, what is sold to whom and which facts may be stated, and the
// reel and ad methods with this business's hooks, audiences and proof. No model is called: every line comes from a node
// the business already has (brand rules, the profile, products, audiences, hook rules, what performed, rules learned
// from the owner's edits), so the skill can never say what the records do not.
//
// Stored like any business skill (Memory{kind:'skill', origin:'generated'} ABOUT the agents, src/agent/skills/business.ts),
// so they live only in that business's graph. Versioned: writing again with new facts adds a new Memory that SUPERSEDES
// the old one (status 'superseded'); unchanged text writes nothing; a skill the owner rewrote is never overwritten.
// Each one names its shipped base skill (reel-script, photo-to-ad-brief, brand-voice-check): the owner's rules and the
// rules learned from edits on the base reach it too, which is how the team keeps refining it.
import type { GraphHandle } from "../../graph/client.js";
import { readReference } from "../../graph/reference.js";
import { upsertNode, writeBatch } from "../../graph/upsert.js";
import { findBusiness } from "../../capabilities/ladder.js";
import { contentPerformance } from "../tools/content.js";
import { TouchedSet, type ToolContext } from "../tool.js";
import { ensureRoster } from "../memory.js";
import { skillWrite } from "./business.js";
import { MAX_BUSINESS_BODY, SKILL_ID } from "./format.js";

type Read = Pick<GraphHandle, "roQuery">;
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const one = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

export interface CompanyFacts {
  slug: string;              // the skill-id prefix: "aamdani", "avs-atelier"
  name: string;
  summary: string;
  tone: string[];            // brand rules about tone and voice
  dos: string[];
  donts: string[];
  visual: string[];
  sayInstead: string[];      // "Say 'home', not 'villa'." learned from the owner's edits
  audiences: string[];
  needs: string[];
  products: string[];
  features: string[];
  hooks: string[];           // hook formulas (the playbook)
  worked: string[];          // what performed here, best first
  weakest: string[];
  channels: string[];
  told?: { dos: number; donts: number; visual: number }; // how many rules at the head of each list are the owner's own (shown whole)
}

// A rule this long is a full sentence and carries no "name:" label in a skill.
const LABEL_FREE = 30;

// One post is often several Content nodes (its caption, a note about it, its file name), each carrying the same reading, so
// a ranking lists it three times. Of a run of posts of one format whose views are within 1% of each other, only the first
// (the best ranked) is kept: the skill would otherwise say four reels worked when it was one.
export function distinctPosts<T extends { views?: number | null; format?: string }>(items: T[]): T[] {
  const kept: T[] = [];
  for (const i of items) {
    const v = i.views ?? 0;
    if (!kept.some((k) => k.format === i.format && Math.abs((k.views ?? 0) - v) <= 0.01 * Math.max(k.views ?? 0, v))) kept.push(i);
  }
  return kept;
}

export const companySlug = (tenant: string): string => tenant.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";

export async function companyFacts(g: GraphHandle, tenant: string, now: number = Date.now()): Promise<CompanyFacts> {
  const biz = await findBusiness(g);
  const [b] = biz ? await g.roQuery<{ name: string | null; summary: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name, b.summary AS summary", { id: biz }) : [];
  const brand = await g.roQuery<{ kind: string | null; name: string | null; text: string | null; told: number }>(
    // What the owner told the team comes first (it is their latest word), then the rest by how well the graph connects them
    // (its own importance rank), then by id. A skill holds at most 8,000 characters, so when it has to leave rules out it
    // leaves out the least connected extracted ones, which are mostly repeats of each other.
    "MATCH (r:BrandRule) WHERE coalesce(r.status, 'active') = 'active' RETURN r.kind AS kind, r.name AS name, coalesce(r.text, r.summary) AS text, CASE WHEN r.origin = 'owner' THEN 0 ELSE 1 END AS told, coalesce(r.rank, 0) AS weight ORDER BY told, weight DESC, r.id LIMIT 120");
  const list = async (label: string, n: number) => (await g.roQuery<{ name: string | null; summary: string | null }>(
    `MATCH (x:${label}) RETURN x.name AS name, x.summary AS summary ORDER BY coalesce(x.createdAt, 0), x.id LIMIT ${n}`))
    .map((r) => one([r.name, r.summary].filter(Boolean).join(": "))).filter(Boolean);
  const [audiences, needs, products, features, channels] = await Promise.all([list("Audience", 8), list("Need", 8), list("Product", 8), list("Feature", 10), list("Channel", 8)]);
  // the business's own hook rules first, then the shared playbook's (src/graph/reference.ts); a stub has no text of its own
  const HOOKS = "MATCH (r:Rule) WHERE r.kind = 'hook' AND r.refStub IS NULL RETURN r.template AS tpl, r.text AS text ORDER BY coalesce(r.rank, 0) DESC, r.id LIMIT 8";
  const hookRows = [
    ...await g.roQuery<{ tpl: string | null; text: string | null }>(HOOKS),
    ...await readReference<{ tpl: string | null; text: string | null }>(HOOKS),
  ];
  const hooks = [...new Set(hookRows.map((r) => one(r.tpl ?? r.text)).filter(Boolean))].slice(0, 8);
  const learned = (await g.roQuery<{ text: string | null }>(
    "MATCH (r:Rule) WHERE r.kind = 'learned' AND coalesce(r.status, 'active') = 'active' RETURN coalesce(r.text, r.name) AS text ORDER BY coalesce(r.confidence, 0) DESC, r.id LIMIT 12"))
    .map((r) => one(r.text)).filter(Boolean);

  // what performed: the content tool's own ranking (outlier multiple), read-only
  let worked: string[] = [];
  let weakest: string[] = [];
  try {
    const ctx: ToolContext = { graph: g, tenant, turnId: "skills", agentId: "content-strategist", asker: "person:founder", touched: new TouchedSet(), now, readOnly: true };
    type Item = { name?: string; views?: number | null; multiple?: number | null; hook?: { name?: string } | null; format?: string };
    // The last year first. A post whose date was never recorded is dropped by that window, so when it leaves nothing, ask
    // again with no window at all (Aamdani: 70 posts, only 32 dated, and the dated ones keep their views under another name).
    const seen = async (args: { days?: number; limit: number }): Promise<Item[]> => {
      const r = await contentPerformance.run(args, ctx);
      // a reading of 0 is the placeholder a post gets before its first numbers arrive, not a result
      return ((r.data as { items?: Item[] })?.items ?? []).filter((i) => typeof i.views === "number" && i.views > 0);
    };
    const found = (await seen({ days: 365, limit: 25 }));
    const items = distinctPosts(found.length ? found : await seen({ limit: 25 }));
    const line = (i: Item) => one(`${i.name ?? "a post"}${i.format ? ` (${i.format})` : ""}: ${i.views} views${i.multiple ? `, ${i.multiple}x the usual` : ""}${i.hook?.name ? `; hook: ${i.hook.name}` : ""}`);
    worked = items.slice(0, 4).map(line);
    weakest = items.length > 4 ? items.slice(-2).map(line) : [];
  } catch { /* no content yet */ }

  // A rule is "name: text" for the sorting below (a rule's "Never use X" name is what makes it a don't). A rule's name is often
  // its own text cut short and ended with "…" (the rules the owner tells the team are named that way): then the text alone says
  // it. And a rule that is a whole sentence needs no label in a skill, where every character counts (8,000 for the lot).
  type Row = { kind: string | null; name: string | null; text: string | null; told: number };
  const full = (r: Row) => {
    const stem = (r.name ?? "").replace(/…$/, "").trim().toLowerCase();
    return one(r.text && stem && !r.text.toLowerCase().startsWith(stem) ? `${r.name}: ${r.text}` : r.text ?? r.name);
  };
  const shown = (r: Row) => (one(r.text).length >= LABEL_FREE ? one(r.text) : full(r));
  const kind = (k: string | null) => (k ?? "").toLowerCase();
  const isVisual = (r: Row) => /visual/.test(kind(r.kind));
  const seenFull = new Set<string>();
  const items = brand.map((r) => ({ r, key: full(r), line: shown(r) })).filter((x) => x.key && !seenFull.has(x.key) && !!seenFull.add(x.key));
  const isDont = (key: string) => /^(?:don'?t|never|no |avoid)/i.test(key) || /\b(?:never|no invented|don'?t)\b/i.test(key);
  const plain = items.filter((x) => !isVisual(x.r));
  const donts = plain.filter((x) => isDont(x.key));
  const dos = plain.filter((x) => !isDont(x.key) && !/^tone/i.test(x.key));
  const visual = items.filter((x) => isVisual(x.r));
  // the owner's own rules lead each list (the query puts them first): how many, so a skill can show them whole
  const lead = (xs: typeof items) => { let k = 0; while (k < xs.length && xs[k]!.r.told === 0) k++; return k; };
  return {
    slug: companySlug(tenant), name: one(b?.name) || tenant, summary: one(b?.summary),
    tone: brand.filter((r) => /tone/.test(kind(r.kind))).map(full),
    dos: dos.map((x) => x.line),
    donts: donts.map((x) => x.line),
    visual: visual.map((x) => x.line),
    told: { dos: lead(dos), donts: lead(donts), visual: lead(visual) },
    sayInstead: learned.filter((t) => /^say /i.test(t)),
    audiences, needs, products, features, hooks, worked, weakest, channels,
  };
}

// ---------- the four skills ----------

export interface GeneratedSkill { id: string; name: string; when: string; agents: string[]; base?: string; text: string }

// `whole` items at the head of the list (the owner's own rules) are cut at 300 characters, the longest a rule can be; the rest at `width`.
const bullets = (xs: string[], none: string, n = 8, width = 170, whole = 0): string =>
  (xs.length ? xs.slice(0, n).map((x, i) => `- ${clip(x, i < whole ? Math.max(width, 300) : width)}`).join("\n") : `- ${none}`);

// A skill holds at most 8,000 characters (MAX_BUSINESS_BODY), which a business with many rules can outgrow. So the rules are
// shown whole (up to the 300 characters one can have) while the skills fit, and when they do not: first the rules the
// graph extracted are cut at 170 characters (the owner's own stay whole), then the list of things to do loses its last
// entries one by one, because the "Never" guardrails (no invented statistics, no promised outcomes) are what a skill must
// not lose; only when even that is too much are the guardrails cut too. Rules come in the order the records give them.
interface Fit { width: number; dos: number; donts: number }
function* fits(): Generator<Fit> {
  yield { width: 300, dos: 25, donts: 40 };
  for (let dos = 25; dos >= 6; dos--) yield { width: 170, dos, donts: 40 };
  for (const donts of [30, 24, 18, 12]) yield { width: 120, dos: 4, donts };
}
const ROOM = 300;

export function companySkills(f: CompanyFacts): GeneratedSkill[] {
  let out: GeneratedSkill[] = [];
  for (const fit of fits()) {
    out = buildSkills(f, fit.width, fit.dos, fit.donts);
    if (out.every((s) => s.text.length <= MAX_BUSINESS_BODY - ROOM)) break;
  }
  return out;
}

/** The four skills at one fit (exported so a test can see what a fit costs). */
export function buildSkills(f: CompanyFacts, width: number, dos: number, donts: number): GeneratedSkill[] {
  const rules = (xs: string[], none: string, n = 8, whole = 0): string => bullets(xs, none, n, width, whole);
  const n = f.name;
  const who = f.summary ? clip(f.summary, 500) : `${n}: the profile is thin; ask the owner for one line on what they do.`;
  const voice: GeneratedSkill = {
    id: `${f.slug}-brand-voice`, name: `${n}'s brand voice`, when: `Writing or checking anything ${n} says in public: posts, reels, ads, replies`,
    agents: ["content-strategist", "copy-editor"], base: "brand-voice-check",
    text: `## Who is speaking
${who}

## Tone
${rules(f.tone, "Not recorded: write plainly and warmly, and ask the owner how they sound.")}

## Do
${rules(f.dos, "No do-rules recorded yet.", dos, f.told?.dos)}

## Never
${rules(f.donts, "No don't-rules recorded yet; never invent facts, numbers or promises.", donts, f.told?.donts)}

## Words the owner corrected (use the right one every time)
${rules(f.sayInstead, "None yet: they appear here as the owner edits drafts.")}

## How it looks (anything visual)
${rules(f.visual, "No visual rules recorded.", 12, f.told?.visual)}

## Check before it goes out
- Would a stranger who knows nothing about ${n} understand every line? Name the thing ("the app", "the studio"), never just "it".
- Every fact comes from the records; a gap is marked [you tell us: ...].
- The rules above beat any general habit, including the shipped voice check.`,
  };
  const domain: GeneratedSkill = {
    id: `${f.slug}-domain`, name: `What ${n} sells and to whom`, when: `Any work that states what ${n} offers, who it is for, or what it has achieved`,
    agents: ["content-strategist", "copy-editor", "fact-checker", "growth-marketer"],
    text: `## What it is
${who}

## What it sells
${bullets(f.products, "No products or services recorded: ask the owner before naming one.")}

## Features or parts worth showing
${bullets(f.features, "None recorded.", 10)}

## Who it is for
${bullets(f.audiences, "No audience recorded: ask the owner who buys.")}

## What they need
${bullets(f.needs, "No needs recorded.")}

## Proof points (only as the records say them)
- The profile above is the business's own description; claims in it (counts, awards, years) are the business's own claims: say "we have" or leave them out, never "the best".
- Results (sales, sign-ups, hires, views) come only from measured numbers with their dates. No invented statistics.

## Channels
${bullets(f.channels, "None recorded.")}`,
  };
  const reel: GeneratedSkill = {
    id: `${f.slug}-reel`, name: `${n} reels`, when: `A reel or short video for ${n}: open this before the general reel script skill`,
    agents: ["content-strategist"], base: "reel-script",
    text: `## The method (the general reel script skill has the full craft)
0. Purpose first: the reel opens with its one-line brief (what it is made to do, which product, service or offer below it promotes, for whom, the message, the action, where it runs). A good-looking reel that sells nothing in particular has failed (creative-brief skill).
1. One idea, one audience (from the list below), one product or feature, and the ONE thing this reel changes compared with the last one, so its numbers teach something.
2. Line 1 is the conflict and still makes sense to a stranger: who the person is, what they need, and the pain, in one spoken sentence from the first frame. No establishing shot, no walk-in, no silence.
3. Beat 1 is 3 to 5 seconds, a second shot comes before 5 seconds, the product or the result is on screen by about 12 seconds, and the last line answers the first so the end flows back into the opening.
4. Proper sentences, not telegrams; every line makes sense to someone who heard only the lines before it; a line about the product has the product on screen while it is said.
5. Real screens, the logo and every word on screen are put on afterwards, never drawn by a video model: the hook words on frame one, each line revealed a few words at a time at reading pace (it must work on mute), everything inside the 14% top, 35% bottom and 6% side safe zone, the end card with the logo and ONE action.
6. ${n}'s own photos and screens first (the design-standard skill); a generated clip only starts from a real frame and only moves the camera. Music and clips are priced and wait for the owner's OK.

## Who to speak to
${bullets(f.audiences, "Not recorded: ask the owner who the reel is for.")}

## What worked here (start from these hook families)
${bullets(f.worked, "No reel or post numbers recorded yet: say it is a first try and pick a hook below.")}

## What did not
${bullets(f.weakest, "Not enough posts recorded to say.")}

## Hook formulas this business keeps
${bullets(f.hooks, "None recorded: use the general reel script skill's hooks.")}

## Voice for spoken lines and on-screen words
${rules([...f.tone, ...f.dos.slice(0, 4)], "Plain, warm, specific.")}
${f.donts.length ? `\nNever:\n${rules(f.donts, "", 6)}` : ""}

## Done well
- [ ] It has a purpose: the one-line brief opens it and every beat serves it.
- [ ] The hook line is the conflict and a stranger understands it.
- [ ] Timed beats from 0s to the end, each sized to its words.
- [ ] Every fact is from the records; illustrative people are marked as examples.`,
  };
  const ad: GeneratedSkill = {
    id: `${f.slug}-ad`, name: `${n} ads`, when: `An ad, poster or paid post for ${n}: open this before the general ad and offer skills`,
    agents: ["growth-marketer", "content-strategist"], base: "photo-to-ad-brief",
    text: `## The method
0. Purpose first: the ad opens with its one-line brief (what it is made to do, which product, service or offer below it promotes, for whom, the message, the action, where it runs); infer it from the goals and products here, and ask the owner at most three quick questions only for what is unknown (creative-brief skill).
1. One audience, one product, one claim the records hold, one action. A benefit is fine; a promised outcome or timing is not.
2. The headline is the conflict or the benefit in at most 7 words, then the proof, then the action. The offer and its dates come from the owner; never invent a discount.
3. Make two versions that differ in one thing (the hook, or the picture), and say the number that will decide and when to look.
4. Every word, price and logo on the image is put on exactly; the picture never changes the product.
5. Design it to the design-standard skill: one message of at most 7 words, one supporting line, one action, no phrase said twice; ${n}'s own photos or real screens first, a generated scene only when none fits and only of ${n}'s own place and people; a layout that fits the job and differs from the last one.

## What to sell, to whom
Products:
${bullets(f.products, "Not recorded: ask the owner.", 6)}
Audiences:
${bullets(f.audiences, "Not recorded: ask the owner.", 6)}

## Proof this business can use
${bullets(f.worked.length ? f.worked : [], "No measured results recorded yet: use what the business does, not results.", 4)}

## Hooks that fit
${bullets(f.hooks, "Use the general hooks.", 5)}

## Voice and look
${rules([...f.tone, ...f.donts], "Plain and specific; no hard sell.", 8)}
${f.visual.length ? `\nLook:\n${rules(f.visual, "", 5)}` : ""}

## Done well
- [ ] It has a purpose: the one-line brief opens it; a nice-looking ad that sells nothing in particular fails.
- [ ] One claim, one action, the offer only as the owner gave it.
- [ ] A test of one difference, with the deciding number named.
- [ ] Nothing the brand's rules forbid (hard sell, superlatives, invented numbers).`,
  };
  return [voice, domain, reel, ad].filter((s) => SKILL_ID.test(s.id));
}

// ---------- writing them, with versions ----------

interface Existing { id: string; skillId: string; body: string | null; origin: string | null; version: number | null }

export async function writeCompanySkills(g: GraphHandle, o: { tenant: string; now?: number }): Promise<{ written: string[]; unchanged: string[]; kept: string[] }> {
  const now = o.now ?? Date.now();
  await ensureRoster(g, {}, now); // the skills are ABOUT the agents, so the roster has to be there first
  const facts = await companyFacts(g, o.tenant, now);
  const skills = companySkills(facts);
  const existing = await g.roQuery<Existing>(
    `MATCH (m:Memory) WHERE m.kind = 'skill' AND m.skillId IN $ids AND coalesce(m.status, 'active') = 'active'
     RETURN m.id AS id, m.skillId AS skillId, m.body AS body, m.origin AS origin, m.version AS version ORDER BY m.id`, { ids: skills.map((s) => s.id) });
  const out = { written: [] as string[], unchanged: [] as string[], kept: [] as string[] };
  const day = new Date(now).toISOString().slice(0, 10);
  for (const s of skills) {
    const cur = existing.find((e) => e.skillId === s.id);
    if (cur && cur.origin !== "generated") { out.kept.push(s.id); continue; }  // the owner's own version stays
    if (cur && cur.body === s.text) { out.unchanged.push(s.id); continue; }
    const version = (cur?.version ?? 0) + 1;
    const id = `memory:skill-${s.id}-v${version}`;
    const w = skillWrite({ agents: s.agents, id: s.id, name: s.name, when: s.when, text: s.text }, id, `allevia:company-skills`, undefined, now, day);
    w.nodes[0]!.props = { ...w.nodes[0]!.props, origin: "generated", version, ...(s.base ? { baseSkill: s.base } : {}) };
    w.edges = w.edges.filter((e) => e.type !== "SOURCED_FROM");
    if (cur) w.edges.push({ from: id, type: "SUPERSEDES", to: cur.id });
    const r = await writeBatch(g, w, now);
    if (r.errors.length) throw new Error(`${s.id}: ${r.errors[0]!.error}`);
    if (cur) await upsertNode(g, { type: "Memory", id: cur.id, name: `Skill: ${s.name}`, props: { status: "superseded", supersededAt: now } }, now);
    out.written.push(s.id);
  }
  return out;
}

/** The versions of one company skill, newest first (for the Team page and the gap check). */
export async function companySkillVersions(g: Read, skillId: string): Promise<Array<{ id: string; version: number; status: string }>> {
  const rows = await g.roQuery<{ id: string; version: number | null; status: string | null }>(
    "MATCH (m:Memory) WHERE m.kind = 'skill' AND m.skillId = $id RETURN m.id AS id, m.version AS version, m.status AS status ORDER BY coalesce(m.version, 0) DESC, m.id", { id: skillId });
  return rows.map((r) => ({ id: r.id, version: r.version ?? 1, status: r.status ?? "active" }));
}
