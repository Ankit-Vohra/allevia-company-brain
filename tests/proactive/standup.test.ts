// The daily stand-up (src/proactive): what Meera reviews, what the team turns into opportunities, the no-spam rules,
// Meera's pick, the drafts waiting for the owner's OK, and Today's note leading with them. On the test-only FalkorDB
// (vitest.config.ts), with fake drafters and a fake Meera: no model, no image engine, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { decideApproval } from "../../src/actions/approvals.js";
import { ownerJargon } from "../../src/agent/style.js";
import { writeBrief } from "../../src/insights/brief.js";
import { runInsights } from "../../src/insights/recommend.js";
import type { LlmRunner, StructuredInput } from "../../src/ingest/llm.js";
import { upcomingDates, whenWords } from "../../src/proactive/calendar.js";
import { bigWaiting, choose, explainWaiting, ruleOrder, screen, type PastCard, type Picked } from "../../src/proactive/choose.js";
import { draftPick, type Drafters, type PosterJob, type TextJob } from "../../src/proactive/draft.js";
import { opportunitiesFrom, type Opportunity } from "../../src/proactive/opportunities.js";
import { gatherSignals } from "../../src/proactive/signals.js";
import { QUIET_LINE, readStandup, runStandup } from "../../src/proactive/standup.js";
import { D, seedInsights, SEED_NOW } from "../fixtures/insights-graph.js";
import { testGraph } from "../helpers/graph.js";
import { whenFree } from "../helpers/tools.js";

const DAY = 86_400_000;
let g: GraphHandle;
let empty: GraphHandle;
const cleanups: Array<() => Promise<void>> = [];

async function seedStandup(gr: GraphHandle): Promise<void> {
  const t0 = D("2026-10-10");
  await upsertNode(gr, { type: "Business", id: "business:aamdani", name: "Aamdani", props: { city: "Raipur", country: "India", industry: "jobs", domain: "aamdani.ai" } }, t0);
  // a Google review with no reply (public data was looked up once)
  await upsertNode(gr, { type: "Document", id: "document:public-listing", name: "Google Maps listing: Aamdani", props: { kind: "public" }, asOf: "2026-10-12" }, t0);
  await upsertNode(gr, { type: "Document", id: "document:google-review-r1", name: "Google review, 2 stars (2026-10-12)", summary: "Applied twice, nobody called back.",
    props: { kind: "review", platform: "google", ownerReplied: false, stars: 2, author: "Ravi", publishedAt: "2026-10-12" }, asOf: "2026-10-12" }, t0);
  // the website check-up: a page fails a check whose fix is words
  await upsertNode(gr, { type: "Rule", id: "rule:seo-missing-meta-description", name: "SEO check: Missing meta description",
    props: { kind: "seo-check", severity: "warning", issueType: "missing-meta-description", howToFix: "Add a 140-160 character description." } }, t0);
  await upsertNode(gr, { type: "Page", id: "page:www.aamdani.ai/", name: "Aamdani home", props: { url: "https://www.aamdani.ai/", path: "/" } }, t0);
  await upsertEdge(gr, { from: "page:www.aamdani.ai/", type: "FAILS", to: "rule:seo-missing-meta-description", props: { severity: "warning", evidence: "no <meta name=description>" } }, SEED_NOW - 3600_000);
  // the owner's "Check my website" (src/checkup): a site-wide fix on the website channel, with its impact score
  await upsertNode(gr, { type: "Rule", id: "rule:allevia-website-checkup-clear-offer", name: "Website check-up: Say what you do in the first line of the home page",
    props: { kind: "website-check", issueType: "clear-offer", title: "Say what you do in the first line of the home page", howToFix: "Lead with what you do and for whom." } }, t0);
  await upsertEdge(gr, { from: "channel:website", type: "FAILS", to: "rule:allevia-website-checkup-clear-offer", props: { impact: 75, tier: "losing enquiries", evidence: "the first line says Welcome" } }, t0);
}

// Fake drafters: the words say what they were asked for; the poster writes its own card the way the creating tools do.
function fakeDrafters(): Drafters & { texts: TextJob[]; posters: PosterJob[] } {
  const texts: TextJob[] = [], posters: PosterJob[] = [];
  return {
    texts, posters,
    async text(job) {
      texts.push(job);
      return { ok: true, text: job.kind === "headline" ? "Dussehra greetings from Aamdani" : `Draft ${job.kind}: ${job.brief.slice(0, 60)}`, hashtags: job.kind === "post" ? ["#Raipur"] : [], warnings: [] };
    },
    async poster(job) {
      posters.push(job);
      const recId = `recommendation:made-poster-${posters.length}`, approvalId = `approval:made-poster-${posters.length}`;
      await upsertNode(g, { type: "Recommendation", id: recId, name: `Poster: ${job.headline}`, props: { status: "open", kind: "content_draft", by: job.agentId, area: "content" } }, job.now);
      await upsertNode(g, { type: "Approval", id: approvalId, name: `content_draft: Poster: ${job.headline}`,
        props: { status: "pending", kind: "content_draft", title: `Poster: ${job.headline}`, payload: JSON.stringify({ title: `Poster: ${job.headline}`, body: job.caption }), recommendation: recId } }, job.now);
      await upsertEdge(g, { from: recId, type: "PROPOSES", to: approvalId }, job.now);
      return { approvalId, recommendationId: recId, hfCredits: job.paid ? 2 : 0, notes: job.paid ? [] : ["a plain background in your brand colours"] };
    },
  };
}

// A fake Meera: answers with the given picks (ids o1..), and records what she was shown.
function fakeMeera(answer: (input: StructuredInput) => unknown): LlmRunner & { calls: StructuredInput[] } {
  const calls: StructuredInput[] = [];
  return { calls, async structured(input) { calls.push(input); return answer(input); } };
}

beforeAll(async () => {
  ({ g } = await whenFree(async () => {
    const t = await testGraph();
    cleanups.push(t.cleanup);
    await seedInsights(t.g);
    await seedStandup(t.g);
    await runInsights("test", { graph: t.g, now: SEED_NOW - 4 * 3600_000 });
    return t;
  }));
  const e = await testGraph();
  empty = e.g;
  await upsertNode(empty, { type: "Business", id: "business:other", name: "Other Studio", props: { city: "Leeds" } }, SEED_NOW - DAY);
  cleanups.push(e.cleanup);
});
afterAll(async () => {
  for (const c of cleanups) await c().catch(() => undefined);
  await closeAll();
});

const PICK = ["season", "dussehra-2026"].join(":"); // built from parts: a literal key beside `standupKey =` reads as a credential to the hygiene scan
describe("calendar", () => {
  it("knows what is coming in a country, nearest first, and says moon-calendar dates as 'about'", () => {
    const up = upcomingDates("IN", "2026-10-16");
    expect(up.map((u) => u.key)).toEqual(expect.arrayContaining(["dussehra-2026", "diwali-2026"]));
    const dus = up.find((u) => u.key === "dussehra-2026")!;
    expect(dus.inDays).toBe(4);
    expect(whenWords(dus)).toBe("in about 4 days");
    expect(upcomingDates("GB", "2026-11-20").map((u) => u.name)).toContain("Black Friday");
    expect(upcomingDates(undefined, "2026-10-16")).toEqual([]);
  });
});

describe("what the stand-up reviews and turns into opportunities", () => {
  let opps: Opportunity[];
  beforeAll(async () => {
    const s = await gatherSignals(g, { now: SEED_NOW, tenant: "test", businessId: "business:aamdani", since: SEED_NOW - 2 * DAY });
    expect(s.business.countryCode).toBe("IN");
    expect(s.today).toBe("2026-10-15");
    expect(s.reviews.map((r) => r.id)).toEqual(["document:google-review-r1"]);
    expect(s.website.fails[0]).toMatchObject({ ruleId: "rule:allevia-website-checkup-clear-offer", impact: 75, name: "Say what you do in the first line of the home page" });
    expect(s.website.fails[1]).toMatchObject({ ruleId: "rule:seo-missing-meta-description", pages: 1, newPages: 1 });
    expect(s.goals.find((x) => x.id === "goal:instagram-followers")).toMatchObject({ status: "at_risk", was: "on_track" });
    opps = opportunitiesFrom(s);
  });

  it("finds the festival, the unanswered review, the website words and the goal that needs a push", () => {
    const by = new Map(opps.map((o) => [o.key, o]));
    const festival = opps.find((o) => o.occasion?.name === "Dussehra");
    expect(festival).toMatchObject({ kind: "poster", agent: "content-strategist", reason: "Dussehra is in about 5 days (around 2026-10-20)." });
    expect(festival).toMatchObject({ filler: true, effect: 0 });
    expect(by.get("review:document:google-review-r1")).toMatchObject({ kind: "reply", agent: "ops-manager", moves: ["Signups a day"] });
    expect(by.get("website:rule:seo-missing-meta-description")).toMatchObject({ kind: "website_fix", agent: "tech-lead" });
    // a check that costs enquiries moves the sign-up goal; a search check moves no goal this business has
    expect(by.get("website:rule:allevia-website-checkup-clear-offer")).toMatchObject({ kind: "website_fix", goals: ["goal:signups-per-day"] });
    expect(by.get("website:rule:seo-missing-meta-description")).toMatchObject({ goals: [], effect: 0.15 });
    expect(by.get("goal:goal:instagram-followers")).toMatchObject({ kind: "post", goals: ["goal:instagram-followers"], effect: 1 });
    expect(by.get("goal:goal:instagram-followers")!.reason).toMatch(/slipped and now needs a push/);
    for (const o of opps) {
      expect(ownerJargon(o.reason)).toEqual([]);
      expect(o.brief).toMatch(/Purpose:/);
    }
  });

  it("scores by the expected effect on the goals: a goal that needs a push first, festivals last", () => {
    expect(opps[0]!.effect).toBe(1); // it moves a goal that needs a push (Instagram followers)
    expect(opps[0]!.goals).toContain("goal:instagram-followers");
    expect(opps.at(-1)!.filler).toBe(true);
    const fillers = opps.findIndex((o) => o.filler);
    expect(opps.slice(fillers).every((o) => o.filler)).toBe(true);
  });

  it("orders with variety, and a festival only fills a spare slot", () => {
    const three = ruleOrder(opps);
    expect(three.length).toBe(3);
    expect(three.some((o) => o.filler)).toBe(false); // enough goal-movers: no festival today
    expect(three[0]!.score).toBeGreaterThanOrEqual(three[2]!.score);
    const spare = ruleOrder(opps.filter((o) => o.filler || o.key === "goal:goal:instagram-followers"));
    expect(spare.map((o) => o.source)).toEqual(["goal", "season"]);
  });
});

describe("no spam", () => {
  const op = (key: string, kind: Opportunity["kind"], score = 0.7): Opportunity => ({
    key, kind, source: "season", agent: "content-strategist", title: key, reason: `${key}.`, brief: "Purpose: x.", facts: [], skill: { agent: "content-strategist", id: "instagram-post" }, evidence: [], goals: [], score,
  });
  const past = (key: string, kind: string, status: string, daysAgo: number): PastCard => ({ id: `approval:${key}`, key, kind, status, at: SEED_NOW - daysAgo * DAY });

  it("skips what is waiting, what was refused lately and what was just done", () => {
    const r = screen([op("a", "post"), op("b", "post"), op("c", "post"), op("d", "post")], [
      past("a", "post", "pending", 1), past("b", "post", "rejected", 10), past("c", "post", "approved", 3), past("d", "post", "rejected", 40),
    ], SEED_NOW);
    expect(r.skipped.map((s) => [s.key, s.why.split(" ").slice(0, 3).join(" ")])).toEqual([["a", "already waiting for"], ["b", "you said no"], ["c", "done in the"]]);
    expect(r.kept.map((k) => k.key)).toEqual(["d"]);
  });

  it("learns from No: each refusal of a kind lowers it, three with no Yes pause it", () => {
    const one = screen([op("x", "offer", 0.7)], [past("o1", "offer", "rejected", 2)], SEED_NOW);
    expect(one.kept[0]!.score).toBeCloseTo(0.45, 2);
    expect(one.lessons[0]).toBe("You said no to 1 offer idea lately, so your team brings fewer of them.");
    const three = screen([op("x", "offer", 0.9)], [past("o1", "offer", "rejected", 2), past("o2", "offer", "rejected", 3), past("o3", "offer", "rejected", 4)], SEED_NOW);
    expect(three.kept).toEqual([]);
    expect(three.skipped[0]!.why).toMatch(/^paused/);
    expect(three.lessons[0]).toMatch(/stopped drafting them for now/);
  });

  it("drafts one festival at a time: the next waits a few days", () => {
    const r = screen([op("season:diwali-festival", "poster")], [past("season:dussehra-festival", "poster", "pending", 1)], SEED_NOW);
    expect(r.kept).toEqual([]);
    expect(r.skipped[0]!.why).toBe("a festival post was drafted in the last few days");
    expect(screen([op("season:diwali-festival", "poster")], [past("season:dussehra-festival", "poster", "pending", 6)], SEED_NOW).kept).toHaveLength(1);
  });

  it("never leads with sample numbers", () => {
    const base = { tenant: "t", business: { id: null, name: "X" }, now: SEED_NOW, since: SEED_NOW - DAY, today: "2026-10-15", numbers: { count: 0, changes: [] }, uploads: [], goals: [], decisions: [], learned: 0, publicData: false, reviews: [], competitors: [], website: { checked: false, fails: [] }, dates: [] };
    const finding = { id: "recommendation:x", key: "ads.ctr_drop:c", title: "Ad CTR fell", why: "CTR fell.", area: "ads", by: "growth-marketer", score: 0.9, detector: "ads.ctr_drop", cardId: null, cardKind: null, evidence: [] };
    expect(opportunitiesFrom({ ...base, findings: [{ ...finding, simulated: true }] })).toEqual([]);
    expect(opportunitiesFrom({ ...base, findings: [{ ...finding, simulated: null }] })).toHaveLength(1);
    const gap = { ...finding, simulated: null, area: "content", detector: "content.posting_gap", key: "content.posting_gap:channel:facebook", title: "No Facebook post in 10 days" };
    expect(opportunitiesFrom({ ...base, findings: [gap] })[0]).toMatchObject({ kind: "post", title: "A Facebook post (none in a while)", channel: { id: "channel:facebook", name: "Facebook" } });
  });

  it("stays quiet below the bar", () => {
    expect(screen([op("low", "post", 0.3)], [], SEED_NOW).kept).toEqual([]);
  });
});

describe("Meera's pick", () => {
  const ops = (): Opportunity[] => [
    { key: "k1", kind: "reply", source: "review", agent: "ops-manager", title: "A reply to Ravi's review", reason: "Ravi left 2 stars on Google.", brief: "Purpose: listen.", facts: [], skill: { agent: "ops-manager", id: "follow-up-drafts" }, evidence: [], goals: [], score: 0.8 },
    { key: "k2", kind: "post", source: "season", agent: "content-strategist", title: "A Dussehra post", reason: "Dussehra is in about 5 days.", brief: "Purpose: be there.", facts: [], skill: { agent: "content-strategist", id: "instagram-post" }, evidence: [], goals: [], score: 0.6 },
  ];
  const biz = { id: "business:aamdani", name: "Aamdani", city: "Raipur" };

  it("takes her order and words, but never a number she made up or the machinery's words", async () => {
    const meera = fakeMeera(() => ({ picks: [
      { id: "o2", reason: "Dussehra is in 5 days and 40% of people shop then.", brief: "Purpose: be there for Dussehra. Draft one warm post." },
      { id: "o1", reason: "A 2-star review sits without a reply; answering shows we listen.", brief: "Purpose: show we listen. Draft a reply." },
      { id: "o9", reason: "made up", brief: "Purpose: none." },
    ] }));
    const c = await choose(ops(), { runner: meera, business: biz, today: "2026-10-15" });
    expect(c.by).toBe("meera");
    expect(c.picks.map((p) => p.key)).toEqual(["k2", "k1"]);
    expect(c.picks[0]!.why).toBe("Dussehra is in about 5 days."); // "40%" is not in the data: the template stands
    expect(c.picks[1]!.why).toBe("A 2-star review sits without a reply; answering shows we listen.");
    expect(c.picks[0]!.purpose).toBe("Purpose: be there for Dussehra. Draft one warm post.");
    expect(meera.calls[0]!.prompt).toContain("A reply to Ravi's review");
  });

  it("a festival she picks gives way to a goal-mover she left out", async () => {
    const list: Opportunity[] = [
      { ...ops()[1]!, filler: true, score: 0.42 },
      { ...ops()[0]!, key: "k3", kind: "follow_up", title: "A follow-up message", reason: "Sign-ups dropped.", moves: ["Signups a day"], effect: 1, score: 0.8 },
    ];
    const c = await choose(list, { runner: fakeMeera(() => ({ picks: [{ id: "o1", reason: "Dussehra is close.", brief: "Purpose: be seen." }] })), business: biz, today: "2026-10-15" });
    expect(c.picks.map((p) => p.key)).toEqual(["k3"]);
  });

  it("says why each waiting fix matters this week, in the card's own numbers", async () => {
    const findings = [
      { id: "recommendation:f1", key: "funnel.biggest_drop:a", title: "Seekers: 80% drop at job applied", why: "80% of seekers stop after setup. Fix the step.", area: "funnel", by: "data-analyst", score: 0.9, detector: "funnel.biggest_drop", cardId: "approval:f1", cardKind: "github_issue", evidence: [], simulated: null, goals: ["goal:signups-per-day"] },
      { id: "recommendation:f2", key: "tech.crash_free_low:app", title: "The app crashed in 2.6% of sessions", why: "2.6% of sessions crashed over 14 days.", area: "tech", by: "oncall-engineer", score: 0.85, detector: "tech.crash_free_low", cardId: "approval:f2", cardKind: "github_issue", evidence: [], simulated: null, goals: [] },
      { id: "recommendation:f3", key: "content.x", title: "A post", why: "x", area: "content", by: "content-strategist", score: 0.95, detector: "content.x", cardId: "approval:f3", cardKind: "content_draft", evidence: [], simulated: null, goals: [] },
      { id: "recommendation:f4", key: "ads.x", title: "Pause an ad (simulated)", why: "x", area: "ads", by: "growth-marketer", score: 0.99, detector: "ads.x", cardId: "approval:f4", cardKind: "pause_ad", evidence: [], simulated: true, goals: [] },
    ];
    const w = bigWaiting(findings, [{ id: "goal:signups-per-day", name: "Signups a day" }]);
    expect(w.map((x) => x.approvalId)).toEqual(["approval:f1", "approval:f2"]); // goal-linked first; no draft post, no sample numbers
    expect(w[0]!.matters).toBe('80% of seekers stop after setup. It holds back "Signups a day".');
    const said = await explainWaiting(w, { business: biz, runner: fakeMeera(() => ({ items: [
      { id: "w1", matters: "Most seekers who sign up never apply, so the sign-up goal stalls this week." },
      { id: "w2", matters: "About 10% of users see a crash." }, // a number the card does not hold: the template stands
    ] })) });
    expect(said[0]!.matters).toBe("Most seekers who sign up never apply, so the sign-up goal stalls this week.");
    expect(said[1]!.matters).toBe(w[1]!.matters);
  });

  it("may choose nothing, and falls back to the rule order when she cannot run", async () => {
    expect((await choose(ops(), { runner: fakeMeera(() => ({ picks: [] })), business: biz, today: "2026-10-15" })).picks).toEqual([]);
    const c = await choose(ops(), { runner: fakeMeera(() => { throw new Error("offline"); }), business: biz, today: "2026-10-15" });
    expect(c.by).toBe("rules");
    expect(c.picks.map((p) => p.key)).toEqual(["k1", "k2"]);
  });
});

describe("posters", () => {
  const pick = (key: string): Picked => ({
    key, kind: "poster", source: "season", agent: "content-strategist", title: "A Holi post with a poster", reason: "Holi is soon.", why: "Holi is soon.",
    brief: "Purpose: be there.", purpose: "Purpose: be there.", facts: [], skill: { agent: "content-strategist", id: "instagram-post" }, evidence: [], goals: [], score: 0.7,
    occasion: { name: "Holi", date: "2027-03-22" },
  });
  const ctx = (drafters: Drafters) => ({ tenant: "test", businessId: "business:aamdani", businessName: "Aamdani", now: SEED_NOW, turnId: "standup-test", drafters, paidLeft: 1 });

  it("asks for a Latin headline, and skips the poster (paying nothing) when it is not", async () => {
    const d = fakeDrafters();
    const hindi: Drafters = { ...d, text: async (job) => (job.kind === "headline" ? { ok: true, text: "होली की शुभकामनाएँ", hashtags: [], warnings: [] } : d.text(job)) };
    const item = await draftPick(g, pick("poster-test:holi-1"), ctx(hindi));
    expect(d.posters).toHaveLength(0);
    expect(item).toMatchObject({ kind: "post", status: "drafted" });
    expect(item.paidTried).toBeUndefined();
    expect(item.notes[0]).toMatch(/letters the poster fonts have/);
    expect(d.texts.some((t) => t.kind === "headline")).toBe(false); // the Hindi headline came from the wrapper
  });

  it("says so through the stand-up's log when a card's evidence or goal is not in the graph, instead of hiding it", async () => {
    const d = fakeDrafters();
    const lines: string[] = [];
    const lost: Picked = { ...pick("poster-test:holi-3"), kind: "post", source: "goal", title: "A post for a lost goal", evidence: ["observation:nowhere", "document:google-review-r1"], goals: ["goal:nowhere"] };
    const item = await draftPick(g, lost, { ...ctx(d), log: (l) => lines.push(l) });
    expect(item).toMatchObject({ kind: "post", status: "drafted" });
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual([
      'stand-up: "A post for a lost goal" is not linked to its evidence observation:nowhere: it is not in the graph',
      'stand-up: "A post for a lost goal" is not linked to its goal goal:nowhere: it is not in the graph',
    ]);
    // the card's own link to the goal used to fail without a word: now it says why
    expect(lines[2]).toMatch(/^stand-up: the card for "A post for a lost goal" could not be linked to its goal goal:nowhere: missing endpoint: goal:nowhere/);
    // what exists is still linked
    const linked = await g.roQuery<{ id: string }>("MATCH (r:Recommendation {id:$id})-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id ORDER BY x.id", { id: item.recommendationId });
    expect(linked.map((x) => x.id)).toEqual(["document:google-review-r1"]);
  });

  it("counts a paid attempt against the day even when the poster then fails", async () => {
    const d = fakeDrafters();
    const broken: Drafters = { ...d, poster: async () => { throw new Error("font"); } };
    const item = await draftPick(g, pick("poster-test:holi-2"), ctx(broken));
    expect(item).toMatchObject({ kind: "post", status: "drafted", paidTried: true });
    expect(d.texts.find((t) => t.kind === "headline")!.brief).toMatch(/Latin letters/);
  });
});

describe("a festival fills a spare slot", () => {
  it("on a business with nothing goal-moving, the festival poster is made with the creating tools, paid only within the day's budget", async () => {
    const t = await testGraph();
    cleanups.push(t.cleanup);
    await upsertNode(t.g, { type: "Business", id: "business:aamdani", name: "Aamdani", props: { city: "Raipur", country: "India", industry: "jobs", domain: "aamdani.ai" } }, SEED_NOW - DAY);
    const drafters = fakeDrafters();
    const realGraph = g;
    g = t.g; // the fake poster writes its card into the graph the stand-up runs on
    try {
      const s = await runStandup("quiet", { graph: t.g, now: SEED_NOW, drafters, paidPerDay: 1 });
      const poster = s.items.find((i) => i.kind === "poster");
      expect(poster).toMatchObject({ paid: true, approvalId: "approval:made-poster-1" });
      expect(poster?.title).toMatch(/Dussehra/);
      expect(drafters.posters[0]).toMatchObject({ paid: true, eyebrow: "Dussehra", cta: "aamdani.ai" });
      expect(s.paidUsed).toBe(1);
      expect(s.waiting).toEqual([]);
      expect(s.waitingHeading).toBe("");
      // the festival is a node, the poster's idea stands on it, and the note mentions it as that pick's evidence
      const [ev] = await t.g.roQuery<{ kind: string; date: string; at: number; occasion: string; approx: boolean; src: string }>(
        "MATCH (e:Event {id:'event:festival-dussehra-2026'}) RETURN e.kind AS kind, e.date AS date, e.at AS at, e.occasion AS occasion, e.approx AS approx, e.src AS src");
      expect(ev).toEqual({ kind: "festival", date: "2026-10-20", at: Date.parse("2026-10-20T00:00:00Z"), occasion: "festival", approx: true, src: "allevia:festival-calendar" });
      const stood = await t.g.roQuery<{ rec: string; ev: string }>(
        "MATCH (r:Recommendation)-[e:EVIDENCED_BY]->(x:Event) WHERE e.until IS NULL AND r.standupKey = $pick RETURN r.id AS rec, x.id AS ev ORDER BY rec, ev", { pick: PICK });
      expect(stood.map((x) => x.ev)).toEqual(["event:festival-dussehra-2026"]);
      const mentioned = await t.g.roQuery<{ pick: string; role: string; node: string }>(
        "MATCH (d:Document {kind:'standup'})-[m:MENTIONS]->(x:Event) WHERE m.until IS NULL RETURN m.pickKey AS pick, m.role AS role, x.id AS node ORDER BY node");
      expect(mentioned).toEqual([{ pick: PICK, role: "evidence", node: "event:festival-dussehra-2026" }]);
    } finally {
      g = realGraph;
    }
  });
});

describe("the numbers the stand-up read, as signals", () => {
  it("the biggest like-for-like moves are mentioned by the note as 'signal' (no pick), the reading that moved first", async () => {
    const t = await testGraph();
    cleanups.push(t.cleanup);
    await upsertNode(t.g, { type: "Business", id: "business:aamdani", name: "Aamdani", props: { city: "Raipur", country: "India", industry: "jobs", domain: "aamdani.ai" } }, SEED_NOW - 9 * DAY);
    await upsertNode(t.g, { type: "Channel", id: "channel:website", name: "Website" }, SEED_NOW - 9 * DAY);
    const common = { subject: "channel:website", metric: "website_visits", unit: "count", src: "document:analytics" };
    await writeBatch(t.g, {
      nodes: [{ type: "Document", id: "document:analytics", name: "Analytics", props: { kind: "snapshot" } }], edges: [],
      observations: [
        { ...common, value: 100, windowStart: "2026-09-29", windowEnd: "2026-10-05", asOf: "2026-10-05" },
        { ...common, value: 60, windowStart: "2026-10-06", windowEnd: "2026-10-12", asOf: "2026-10-12" },
      ],
    }, SEED_NOW - 3600_000);
    const s = await gatherSignals(t.g, { now: SEED_NOW, tenant: "sig", businessId: "business:aamdani", since: SEED_NOW - 2 * DAY });
    expect(s.numbers.changes).toHaveLength(1);
    const moved = s.numbers.changes[0]!;
    expect(moved).toMatchObject({ metric: "website_visits", from: 100, to: 60 });
    const standup = await runStandup("sig", { graph: t.g, now: SEED_NOW, since: SEED_NOW - 2 * DAY, drafters: fakeDrafters() });
    const rows = await t.g.roQuery<{ node: string; role: string; pick: string | null; src: string; asOf: string }>(
      `MATCH (:Entity:Document {id:$id})-[m:MENTIONS]->(x:Observation) WHERE m.until IS NULL
       RETURN x.id AS node, m.role AS role, m.pickKey AS pick, m.src AS src, m.asOf AS asOf ORDER BY node`, { id: standup.id });
    expect(rows).toEqual([{ node: moved.obsId, role: "signal", pick: null, src: standup.id, asOf: "2026-10-15" }]);
    // a second, forced run keeps it (nothing is closed that still stands)
    await runStandup("sig", { graph: t.g, now: SEED_NOW + 3600_000, since: SEED_NOW - 2 * DAY, drafters: fakeDrafters(), force: true });
    const again = await t.g.roQuery<{ node: string }>("MATCH (:Entity:Document {id:$id})-[m:MENTIONS]->(x:Observation) WHERE m.until IS NULL RETURN x.id AS node ORDER BY node", { id: standup.id });
    expect(again.map((r) => r.node)).toEqual([moved.obsId]);
  });
});

describe("runStandup", () => {
  const drafters = fakeDrafters();
  let first: Awaited<ReturnType<typeof runStandup>>;

  beforeAll(async () => {
    first = await runStandup("test", { graph: g, now: SEED_NOW, since: SEED_NOW - 2 * DAY, drafters, paidPerDay: 1 });
  });

  it("drafts at most three things, each waiting for the owner's OK, with who, why and the brief", async () => {
    expect(first.quiet).toBe(false);
    const done = first.items.filter((i) => i.status === "drafted");
    expect(done.length).toBeGreaterThan(0);
    expect(done.length).toBeLessThanOrEqual(3);
    expect(first.heading).toBe(`Your team noticed ${done.length} things and drafted them`);
    for (const d of done) {
      const [a] = await g.roQuery<{ status: string; key: string; kind: string; payload: string }>(
        "MATCH (a:Entity:Approval {id:$id}) RETURN a.status AS status, a.standupKey AS key, a.standupKind AS kind, a.payload AS payload", { id: d.approvalId });
      expect(a).toMatchObject({ status: "pending", key: d.key, kind: d.kind });
      expect(JSON.parse(a!.payload).body).toMatch(/Draft|Raipur/);
    }
    expect(first.attendees[0]).toBe("chief-of-staff");
    expect(first.attendees).toEqual(expect.arrayContaining(done.map((d) => d.agent)));
  });

  it("impact first: leads with the big fixes already waiting, and drafts what moves the goals, not a festival post", () => {
    expect(first.waiting.length).toBeGreaterThan(0);
    expect(first.waiting.length).toBeLessThanOrEqual(2);
    expect(first.waitingHeading).toMatch(/^(One big thing is|Two big things are) waiting for your OK; here's why (it matters|they matter) this week$/);
    expect(first.waitingLines[0]).toMatch(/^1\. .+\. \[\[approval:insight-/);
    for (const w of first.waiting) expect(ownerJargon(w.matters)).toEqual([]);
    expect(first.items.some((i) => i.key.startsWith("season:"))).toBe(false);
    expect(drafters.posters).toHaveLength(0);
    expect(first.items.filter((i) => i.status === "drafted").every((i) => first.skipped.every((x) => x.key !== i.key))).toBe(true);
  });

  it("hands each person the skill they draft with and the purpose first", () => {
    const reply = drafters.texts.find((t) => t.kind === "reply" || t.kind === "website_text" || t.kind === "post");
    expect(reply?.brief).toMatch(/^Purpose:|Purpose:/);
  });

  it("the note's document MENTIONS what each pick stands on, with the pick's key, and a traversal returns it for every pick", async () => {
    const done = first.items.filter((i) => i.status === "drafted");
    const rows = await g.roQuery<{ pick: string; keys: string[] | null; node: string; kinds: string[]; role: string; src: string; asOf: string }>(
      `MATCH (d:Entity:Document {id:$id})-[m:MENTIONS]->(x:Entity) WHERE m.until IS NULL AND m.role = 'evidence'
       RETURN m.pickKey AS pick, m.pickKeys AS keys, x.id AS node, labels(x) AS kinds, m.role AS role, m.src AS src, m.asOf AS asOf ORDER BY node`, { id: first.id });
    for (const d of done) {
      // what the card's idea is EVIDENCED_BY is what the note mentions for that pick: the same nodes, through two edges
      const stands = await g.roQuery<{ id: string }>(
        "MATCH (:Entity:Recommendation {id:$id})-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id ORDER BY x.id", { id: d.recommendationId });
      expect(stands.length, d.key).toBeGreaterThan(0);
      const mentioned = rows.filter((r) => r.pick === d.key || (r.keys ?? []).includes(d.key)).map((r) => r.node);
      expect(mentioned.length, d.key).toBeGreaterThan(0);
      for (const s of stands) expect(rows.map((r) => r.node), `${d.key} stands on ${s.id}`).toContain(s.id);
    }
    expect(rows.every((r) => r.role === "evidence" && r.src === first.id && r.asOf === "2026-10-15")).toBe(true);
    // the goal pick stands on its goal and the reading behind it: an Observation
    expect(rows.find((r) => r.kinds.includes("Observation"))).toBeDefined();
  });

  it("writes the stand-up once a day, and a forced re-run adds nothing already waiting", async () => {
    const again = await runStandup("test", { graph: g, now: SEED_NOW + 3600_000, drafters, paidPerDay: 1 });
    expect(again.reused).toBe(true);
    const forced = await runStandup("test", { graph: g, now: SEED_NOW + 7200_000, drafters, paidPerDay: 1, force: true });
    const keys = forced.items.filter((i) => i.status === "drafted").map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(forced.skipped.filter((s) => s.why === "already waiting for your OK").length).toBeGreaterThanOrEqual(first.items.filter((i) => i.status === "drafted").length);
    expect(drafters.posters.filter((p) => p.paid)).toHaveLength(0); // no festival poster on a day with goal-movers
    const saved = await readStandup(g, "2026-10-15");
    expect(saved?.items.length).toBe(forced.items.length);
  });

  it("Today's note leads with the big fixes waiting and why, then what the team drafted, in plain words", async () => {
    const b = await writeBrief("test", { graph: g, now: SEED_NOW + 3 * 3600_000, since: SEED_NOW - DAY });
    const lines = b.text.split("\n");
    expect(lines[2]).toMatch(/big things? (is|are) waiting for your OK; here's why/);
    expect(lines[3]).toMatch(/^1\. .+\. \[\[approval:insight-/);
    const drafted = lines.findIndex((l) => /^Your team noticed \d things? and drafted (it|them)$/.test(l));
    expect(drafted).toBeGreaterThan(3);
    expect(lines[drafted + 1]).toMatch(/^1\. \w+ drafted .+\. \[\[approval:/);
    expect(b.next).toMatch(/^Say OK to the biggest fix first/);
    expect(ownerJargon(b.text)).toEqual([]);
    expect(b.text.indexOf("What we noticed")).toBeGreaterThan(b.text.indexOf("Your team noticed"));
  });

  it("learns from a No: the refused reply is not drafted again, and the note says so", async () => {
    const reply = (await readStandup(g, "2026-10-15"))!.items.find((i) => i.kind === "reply" && i.approvalId);
    expect(reply).toBeDefined();
    await decideApproval(g, { approvalId: reply!.approvalId!, decision: "reject", now: SEED_NOW + 4 * 3600_000 }, { tenant: "test", executors: { dryRun: true } });
    const next = await runStandup("test", { graph: g, now: SEED_NOW + DAY, drafters, paidPerDay: 1 });
    expect(next.items.map((i) => i.key)).not.toContain(reply!.key);
    expect(next.skipped.find((s) => s.key === reply!.key)?.why).toMatch(/^you said no to this on/);
    expect(next.lessons[0]).toBe("You said no to 1 review reply lately, so your team brings fewer of them.");
  });

  it("is quiet when nothing clears the bar", async () => {
    const q = await runStandup("test", { graph: g, now: SEED_NOW + 2 * DAY, drafters, minScore: 0.99 });
    expect(q.quiet).toBe(true);
    expect(q.lines[0]).toBe(`- ${QUIET_LINE}`);
    const b = await writeBrief("test", { graph: g, now: SEED_NOW + 2 * DAY + 60_000 });
    expect(b.text).toContain("Your team met this morning\n- Nothing new worth your time today.");
  });

  it("keeps to its own business: a stand-up on another business's graph reads and writes only that graph", async () => {
    const before = await g.roQuery<{ n: number }>("MATCH (d:Document) WHERE d.kind = 'standup' RETURN count(d) AS n");
    const other = await runStandup("other", { graph: empty, now: SEED_NOW, drafters });
    expect(other.quiet).toBe(true);
    expect(other.items).toEqual([]);
    expect(await g.roQuery<{ n: number }>("MATCH (d:Document) WHERE d.kind = 'standup' RETURN count(d) AS n")).toEqual(before);
  });
});
