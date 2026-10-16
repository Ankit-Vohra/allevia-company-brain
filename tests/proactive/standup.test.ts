// The daily stand-up (src/proactive): what Meera reviews, what the team turns into opportunities, the no-spam rules,
// Meera's pick, the drafts waiting for the owner's OK, and Today's note leading with them. On the test-only FalkorDB
// (vitest.config.ts), with fake drafters and a fake Meera: no model, no image engine, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { decideApproval } from "../../src/actions/approvals.js";
import { ownerJargon } from "../../src/agent/style.js";
import { writeBrief } from "../../src/insights/brief.js";
import type { LlmRunner, StructuredInput } from "../../src/ingest/llm.js";
import { upcomingDates, whenWords } from "../../src/proactive/calendar.js";
import { choose, ruleOrder, screen, type PastCard, type Picked } from "../../src/proactive/choose.js";
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
    expect(s.website.fails[0]).toMatchObject({ ruleId: "rule:seo-missing-meta-description", pages: 1, newPages: 1 });
    expect(s.goals.find((x) => x.id === "goal:instagram-followers")).toMatchObject({ status: "at_risk", was: "on_track" });
    opps = opportunitiesFrom(s);
  });

  it("finds the festival, the unanswered review, the website words and the goal that needs a push", () => {
    const by = new Map(opps.map((o) => [o.key, o]));
    expect(by.get("season:dussehra-2026")).toMatchObject({ kind: "poster", agent: "content-strategist", reason: "Dussehra is in about 5 days (around 2026-10-20)." });
    expect(by.get("review:document:google-review-r1")).toMatchObject({ kind: "reply", agent: "ops-manager", score: 0.8 });
    expect(by.get("website:rule:seo-missing-meta-description")).toMatchObject({ kind: "website_fix", agent: "tech-lead" });
    expect(by.get("goal:goal:instagram-followers")).toMatchObject({ kind: "post", goals: ["goal:instagram-followers"] });
    expect(by.get("goal:goal:instagram-followers")!.reason).toMatch(/slipped and now needs a push/);
    for (const o of opps) {
      expect(ownerJargon(o.reason)).toEqual([]);
      expect(o.brief).toMatch(/Purpose:/);
    }
  });

  it("orders by score with variety: one festival, one poster, two of a kind at most", () => {
    const three = ruleOrder(opps);
    expect(three.length).toBe(3);
    expect(three.filter((o) => o.source === "season").length).toBeLessThanOrEqual(1);
    expect(three[0]!.score).toBeGreaterThanOrEqual(three[2]!.score);
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
    const r = screen([op("season:diwali-2026", "poster")], [past("season:dussehra-2026", "poster", "pending", 1)], SEED_NOW);
    expect(r.kept).toEqual([]);
    expect(r.skipped[0]!.why).toBe("a festival post was drafted in the last few days");
    expect(screen([op("season:diwali-2026", "poster")], [past("season:dussehra-2026", "poster", "pending", 6)], SEED_NOW).kept).toHaveLength(1);
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

  it("counts a paid attempt against the day even when the poster then fails", async () => {
    const d = fakeDrafters();
    const broken: Drafters = { ...d, poster: async () => { throw new Error("font"); } };
    const item = await draftPick(g, pick("poster-test:holi-2"), ctx(broken));
    expect(item).toMatchObject({ kind: "post", status: "drafted", paidTried: true });
    expect(d.texts.find((t) => t.kind === "headline")!.brief).toMatch(/Latin letters/);
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

  it("makes the festival poster with the creating tools, paid only within the day's budget", () => {
    const poster = first.items.find((i) => i.kind === "poster");
    expect(poster).toBeDefined();
    expect(drafters.posters).toHaveLength(1);
    expect(drafters.posters[0]).toMatchObject({ paid: true, eyebrow: "Dussehra", cta: "aamdani.ai" });
    expect(poster).toMatchObject({ paid: true, approvalId: "approval:made-poster-1" });
    expect(first.paidUsed).toBe(1);
  });

  it("hands each person the skill they draft with and the purpose first", () => {
    const reply = drafters.texts.find((t) => t.kind === "reply" || t.kind === "website_text" || t.kind === "post");
    expect(reply?.brief).toMatch(/^Purpose:|Purpose:/);
  });

  it("writes the stand-up once a day, and a forced re-run adds nothing already waiting", async () => {
    const again = await runStandup("test", { graph: g, now: SEED_NOW + 3600_000, drafters, paidPerDay: 1 });
    expect(again.reused).toBe(true);
    const forced = await runStandup("test", { graph: g, now: SEED_NOW + 7200_000, drafters, paidPerDay: 1, force: true });
    const keys = forced.items.filter((i) => i.status === "drafted").map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(forced.skipped.filter((s) => s.why === "already waiting for your OK").length).toBeGreaterThanOrEqual(first.items.filter((i) => i.status === "drafted").length);
    expect(drafters.posters.filter((p) => p.paid)).toHaveLength(1); // the day's one paid picture is spent
    const saved = await readStandup(g, "2026-10-15");
    expect(saved?.items.length).toBe(forced.items.length);
  });

  it("Today's note leads with what the team drafted, in plain words", async () => {
    const b = await writeBrief("test", { graph: g, now: SEED_NOW + 3 * 3600_000, since: SEED_NOW - DAY });
    const lines = b.text.split("\n");
    expect(lines[2]).toMatch(/^Your team noticed \d things? and drafted (it|them)$/);
    expect(lines[3]).toMatch(/^1\. \w+ drafted .+\. \[\[approval:/);
    expect(b.next).toMatch(/^Say OK or change what your team drafted/);
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
