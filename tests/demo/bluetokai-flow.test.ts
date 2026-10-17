// The coffee demo end to end, offline, on the test FalkorDB (6391): the operator's `onboard` runs the real onboarding on a
// hand-made fixture site (read by the real crawler from its HTML, no browser), with the model's answers canned and the public data
// answered from Apify-shaped fixtures; then `seed-sample --profile coffee` adds the sample layer and runs enrol, insights and the
// stand-up with fake drafters. Checked: the real public layer is there and not marked sample; every sample thing is; the hero
// chain is a path of edges; the red herring is ruled out by the numbers; the cards wait; nobody real is made to say anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { getTenant } from "../../src/graph/tenants.js";
import { onboard } from "../../src/onboard/onboard.js";
import { runOperatorOnboard, type OperatorRun } from "../../src/onboard/operator.js";
import { parseOnboardArgs } from "../../src/cli/onboard.js";
import { adLibrary, competitorWatch, instagramPublic } from "../../src/agent/tools/publicdata.js";
import { fakeEmbed } from "../../src/demo/embed.js";
import { setupSample, type SetupResult } from "../../src/demo/sample/setup.js";
import { SAMPLE_IDS, FUNNEL_STEPS } from "../../src/demo/sample/coffee.js";
import { registerSampleTenant, sampleConnections } from "../../src/demo/sample/connections.js";
import { BUSY_IST } from "../../src/demo/sample/coffee-inbox.js";
import type { Drafters, TextJob } from "../../src/proactive/draft.js";
import { proposeTimes } from "../../src/sales/times.js";
import { decide } from "../../src/server/approvals.js";
import { addDays } from "../../src/insights/text.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { COFFEE_BRAND, COFFEE_EXTRACTIONS, COFFEE_FACTS, COFFEE_PROFILE, coffeeApify, startCoffeeSite, type FixtureSite } from "../fixtures/bluetokai/fixture.js";

const NOW = Date.parse("2026-10-17T06:00:00.000Z"); // Saturday 11:30 in India: the release was Monday 12 Oct, the last full day Friday 16 Oct
const embedBatch = async (texts: string[]) => texts.map(fakeEmbed);

let site: FixtureSite;
let g: GraphHandle;
let cleanup: () => Promise<void>;
let slug: string;
let metaGraph: string;
let dataDir: string;
let run: OperatorRun;
let setup: SetupResult;
const out: string[] = [];
const texts: TextJob[] = [];

const q = <T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);
async function series(subject: string, metric: string): Promise<Map<string, number>> {
  const rows = await q<{ day: string; v: number }>(
    "MATCH (o:Observation)-[m:MEASURES]->(s:Entity {id:$s}) WHERE o.metric = $m AND m.until IS NULL RETURN o.windowEnd AS day, o.value AS v ORDER BY day, o.id",
    { s: subject, m: metric });
  return new Map(rows.map((r) => [r.day, r.v]));
}
const sum = (m: Map<string, number>, from: string, to: string) => [...m].filter(([d]) => d >= from && d <= to).reduce((a, [, v]) => a + v, 0);

beforeAll(async () => {
  site = await startCoffeeSite();
  ({ g, cleanup } = await testGraph());
  slug = g.name.replace(/^allevia_/, "");
  metaGraph = `allevia_test_meta_${slug.slice(5)}`;
  dataDir = mkdtempSync(join(tmpdir(), "allevia-coffee-"));
  registerSampleTenant(slug);
  const args = parseOnboardArgs([`${site.origin}/`, "--slug", slug, "--name", "Fixture Roasters", "--country", "India", "--industry", "specialty coffee roaster",
    "--vertical", "online shop", "--instagram", "fixtureroasters", "--rival", "Rival Roasters|rivalroasters|rivalroasters.example"]);
  run = await runOperatorOnboard(args, slug, {
    onboardFn: onboard,
    deps: {
      runner: new FakeLlm({ extractions: COFFEE_EXTRACTIONS, profile: COFFEE_PROFILE, facts: COFFEE_FACTS, brand: COFFEE_BRAND }), model: "haiku", dataDir,
      embed: embedBatch, tenantOpts: { metaGraph }, now: () => NOW, publicData: coffeeApify(site.origin),
      crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 3, launch: () => Promise.reject(new Error("no browser in tests")) },
    },
    openGraph: async () => g, tools: { instagramPublic, adLibrary, competitorWatch }, out: (l) => out.push(l), now: () => NOW,
  });
  const drafters: Drafters = {
    async text(job) {
      texts.push(job);
      const times = job.facts.find((f) => f.startsWith("Three free times")) ?? "";
      return { ok: true, text: `A ${job.kind} for the owner to read first. ${times}`.trim(), hashtags: [], warnings: [] };
    },
    times: (job) => proposeTimes(sampleConnections(slug, () => NOW), job.now, { tz: "Asia/Kolkata" }),
  };
  setup = await setupSample(g, { tenant: slug, profile: "coffee", now: NOW, tenantOpts: { metaGraph }, drafters, runner: null, skills: () => undefined, embed: fakeEmbed });
}, 300_000);

afterAll(async () => {
  await cleanup();
  await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
  await closeAll();
  await site.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("onboard <url>: the real pipeline on the fixture site and the Apify fixtures", () => {
  it("prints its progress, reads the site's pages and finishes", () => {
    expect(run.result.ok).toBe(true);
    expect(run.result.errors.filter((e) => !/privacy|map|brand files/.test(e))).toEqual([]);
    expect(run.result.pages).toBeGreaterThanOrEqual(6);
    expect(out.some((l) => /\[crawl\] Reading 127\.0\.0\.1/.test(l))).toBe(true);
    expect(out.some((l) => /\[goals\]/.test(l))).toBe(true);
    expect(out.some((l) => /^Public reads \(up to \$0\.\d+\):$/.test(l))).toBe(true);
    expect(run.extras).toMatchObject({ ok: 3, failed: [] });
    expect(run.result.templateKey).toBe("online_shop");
  });

  it("the real public layer: priced products from the site, the Google listing and its reviews, public Instagram and ads, a rival", async () => {
    const products = await q<{ name: string; price: number | null; sim: boolean | null }>(
      "MATCH (p:Product)-[s:SOURCED_FROM]->(:Document {kind:'webpage'}) WHERE s.until IS NULL RETURN DISTINCT p.name AS name, p.price AS price, p.simulated AS sim, p.id AS id ORDER BY id");
    expect(products.filter((p) => p.price !== null).map((p) => p.name)).toEqual(expect.arrayContaining(["Estate Blend Medium Roast", "Dark Roast Espresso", "Cold Brew Bags"]));
    expect(products.every((p) => p.sim !== true)).toBe(true);
    const reviews = await q<{ stars: number; sim: boolean | null }>("MATCH (d:Document {kind:'review'}) RETURN d.stars AS stars, d.simulated AS sim, d.id AS id ORDER BY id");
    expect(reviews).toHaveLength(3);
    expect(reviews.every((r) => r.sim !== true)).toBe(true);
    const [ig] = await q<{ v: number; sim: boolean | null }>("MATCH (o:Observation)-[:MEASURES]->(:Channel {id:'channel:instagram'}) WHERE o.metric = 'followers' RETURN o.value AS v, o.simulated AS sim");
    expect(ig).toEqual({ v: 182000, sim: null });
    const rival = await q<{ ads: number }>("MATCH (c:Competitor {name:'Rival Roasters'})-[:OWNS]->(a:Content {format:'ad'}) RETURN count(a) AS ads");
    expect(rival[0]!.ads).toBeGreaterThanOrEqual(2);
  });
});

describe("seed-sample --profile coffee: the sample layer, linked into the public graph", () => {
  it("names the business and says public data plus sample numbers", async () => {
    const t = await getTenant(slug, { metaGraph });
    expect(t).toMatchObject({ name: "Fixture Roasters", industry: "specialty coffee roaster (public data plus sample numbers)" });
  });

  it("hangs the orders on the products the crawl found, plus the sample new roast", async () => {
    const crawled = setup.seed.products.filter((p) => p.crawled);
    expect(crawled.length).toBeGreaterThanOrEqual(4);
    const rows = await q<{ id: string; n: number }>(
      "MATCH (o:Observation)-[:MEASURES]->(p:Product) WHERE o.metric = 'units_sold' RETURN p.id AS id, count(o) AS n ORDER BY id");
    const by = new Map(rows.map((r) => [r.id, r.n]));
    for (const p of crawled) expect(by.get(p.id), p.name).toBe(8);
    expect(by.get(SAMPLE_IDS.newRoast)).toBeGreaterThanOrEqual(3);
  });

  it("the hero chain is a path of edges: release -> UPI error -> UPI payments <- order placed -> online store", async () => {
    const chain = await q<{ how: string; breaks: string }>(
      `MATCH (r:Event {id:$release})-[a:AFFECTS]->(i:Event {id:$issue})-[b:AFFECTS]->(u:Feature {id:$upi})<-[:DEPENDS_ON]-(o:Feature {id:$placed})-[:DEPENDS_ON]->(c:Channel {id:$store})
       WHERE a.until IS NULL AND b.until IS NULL RETURN a.how AS how, b.how AS breaks`,
      { release: SAMPLE_IDS.release, issue: SAMPLE_IDS.upiIssue, upi: SAMPLE_IDS.upi, placed: FUNNEL_STEPS[3]!.id, store: SAMPLE_IDS.onlineStore });
    expect(chain).toEqual([{ how: "introduced", breaks: "breaks" }]);
    // the release changed the payment page, the ad sends people to it, a customer wrote about it, the store sits on the real website
    expect(await q("MATCH (:Event {id:$r})-[:AFFECTS]->(:Page {id:$p}) RETURN 1", { r: SAMPLE_IDS.release, p: SAMPLE_IDS.paymentPage })).toHaveLength(1);
    expect(await q("MATCH (:Campaign {id:$c})-[:DEPENDS_ON]->(:Page {id:$p}) RETURN 1", { c: SAMPLE_IDS.heroCampaign, p: SAMPLE_IDS.paymentPage })).toHaveLength(1);
    expect(await q("MATCH (:Document {id:$d})-[:MENTIONS]->(:Event {id:$i}) RETURN 1", { d: SAMPLE_IDS.complaint, i: SAMPLE_IDS.upiIssue })).toHaveLength(1);
    expect(await q("MATCH (:Channel {id:$s})-[:DEPENDS_ON]->(w:Channel {id:'channel:website'}) RETURN w.simulated AS sim", { s: SAMPLE_IDS.onlineStore })).toEqual([{ sim: null }]);
    // and where every number came from: a sample export the sample Shopify connection produced, which the business owns
    expect(await q("MATCH (b:Business)-[:OWNS]->(:System {id:'system:shopify'})-[:PRODUCED]->(:Document {id:$d}) RETURN b.id", { d: SAMPLE_IDS.shopifyExport })).toHaveLength(1);
  });

  it("online orders fall about 18% from the release, while card orders, visits and the other channels hold", async () => {
    const t = setup.seed.timeline;
    expect([t.releaseDay, t.lastDay, t.reachDipDay]).toEqual(["2026-10-12", "2026-10-16", "2026-10-03"]);
    const span = (m: Map<string, number>, shift: number) => sum(m, addDays(t.releaseDay, shift), addDays(t.lastDay, shift));
    const drop = (m: Map<string, number>) => 1 - span(m, 0) / span(m, -7);
    const online = await series(SAMPLE_IDS.onlineStore, "orders");
    expect(online.size).toBe(56);
    expect(drop(online)).toBeGreaterThan(0.15);
    expect(drop(online)).toBeLessThan(0.22);
    expect(drop(await series(SAMPLE_IDS.onlineStore, "orders_paid_upi"))).toBeGreaterThan(0.25);
    expect(Math.abs(drop(await series(SAMPLE_IDS.onlineStore, "orders_paid_card")))).toBeLessThan(0.12);
    expect(Math.abs(drop(await series("channel:website", "ga4_sessions")))).toBeLessThan(0.06);
    for (const ch of [SAMPLE_IDS.subscriptions, SAMPLE_IDS.quickCommerce]) expect(Math.abs(drop(await series(ch, "orders"))), ch).toBeLessThan(0.08);
    // the checkout's last step is where they are lost
    const attempted = await series(SAMPLE_IDS.onlineStore, "checkout_funnel_payment_attempted");
    const placed = await series(SAMPLE_IDS.onlineStore, "checkout_funnel_order_placed");
    expect(1 - placed.get(t.lastDay)! / attempted.get(t.lastDay)!).toBeGreaterThan(0.2);
    expect(1 - placed.get(addDays(t.releaseDay, -3))! / attempted.get(addDays(t.releaseDay, -3))!).toBeLessThan(0.16);
    expect(setup.seed.hero.dropPct).toBeGreaterThan(15);
  });

  it("the Meta campaign for the new roast kept spending while its purchases fell", async () => {
    const t = setup.seed.timeline;
    const spend = await series(SAMPLE_IDS.heroCampaign, "spend"), conv = await series(SAMPLE_IDS.heroCampaign, "conversions");
    const after = (m: Map<string, number>) => sum(m, t.releaseDay, t.lastDay), before = (m: Map<string, number>) => sum(m, addDays(t.releaseDay, -7), addDays(t.lastDay, -7));
    expect(after(spend) / before(spend)).toBeGreaterThan(0.9);
    expect(1 - after(conv) / before(conv)).toBeGreaterThan(0.25);
  });

  it("rules out the red herring: Instagram reach dipped nine days before the release, and orders held that week", async () => {
    const t = setup.seed.timeline;
    const reach = await series("channel:instagram", "reach");
    expect(1 - sum(reach, t.reachDipDay, addDays(t.reachDipDay, 6)) / sum(reach, addDays(t.reachDipDay, -7), addDays(t.reachDipDay, -1))).toBeGreaterThan(0.15);
    const online = await series(SAMPLE_IDS.onlineStore, "orders");
    const dipWeek = sum(online, t.reachDipDay, addDays(t.reachDipDay, 6)), weekBefore = sum(online, addDays(t.reachDipDay, -7), addDays(t.reachDipDay, -1));
    expect(Math.abs(1 - dipWeek / weekBefore)).toBeLessThan(0.05);
    expect(addDays(t.reachDipDay, 6) < t.releaseDay).toBe(true);
  });
});

describe("sample is always marked; nobody real says anything", () => {
  it("every node the seed wrote is marked sample, and so is every number from a sample source", async () => {
    const unmarked = await q<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) WHERE coalesce(n.simulated, false) = false RETURN n.id AS id", { ids: setup.seed.sample });
    expect(unmarked).toEqual([]);
    expect(setup.seed.sample.length).toBeGreaterThan(40);
    const obs = await q<{ id: string }>(
      "MATCH (o:Observation) WHERE (o.src STARTS WITH 'document:sample-') AND coalesce(o.simulated, false) = false RETURN o.id AS id LIMIT 5");
    expect(obs).toEqual([]);
    const fromSample = await q<{ id: string }>(
      // (the Email channel the inbox writer makes is the business's channel, not sample data)
      `MATCH (n:Entity) WHERE NOT n:Version AND NOT n:Observation AND NOT n:Channel AND (n.src STARTS WITH 'document:sample-' OR n.src STARTS WITH 'gmail:sample-')
       AND coalesce(n.simulated, false) = false RETURN n.id AS id ORDER BY id LIMIT 20`);
    expect(fromSample).toEqual([]);
    // the real layer stays real
    const real = await q<{ id: string; sim: boolean | null }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, n.simulated AS sim ORDER BY id",
      { ids: ["channel:google-maps", "channel:instagram", "channel:website", setup.seed.businessId] });
    expect(real.map((r) => r.sim)).toEqual([null, null, null, null]);
  });

  it("staff are roles, customers are made up at .example addresses, and no person from the website says, decides or sends anything", async () => {
    const roles = await q<{ name: string }>("MATCH (p:Person) WHERE p.sampleRole = true RETURN p.name AS name, p.id AS id ORDER BY id");
    expect(roles.length).toBe(4);
    for (const r of roles) expect(r.name).toMatch(/\(sample role\)$/);
    const senders = await q<{ id: string; email: string | null; sim: boolean | null; role: string | null }>(
      "MATCH (:Message)-[:SENT_BY]->(p:Person) RETURN DISTINCT p.id AS id, p.email AS email, p.simulated AS sim, p.role AS role ORDER BY id");
    for (const s of senders) expect(s.email?.endsWith(".example") || s.role === "owner", s.id).toBe(true);
    // the people the crawl found on the about page: they exist, and nothing is put in their mouths
    const website = await q<{ id: string }>(
      "MATCH (p:Person)-[:SOURCED_FROM]->(:Document {kind:'webpage'}) RETURN DISTINCT p.id AS id ORDER BY id");
    expect(website.length).toBeGreaterThanOrEqual(1);
    const said = await q<{ id: string; rel: string }>(
      `UNWIND $ids AS pid MATCH (p:Person {id:pid})-[r]->(x:Entity) WHERE type(r) IN ['STATED', 'DECIDED', 'AUTHORED', 'ASKED']
       RETURN p.id AS id, type(r) AS rel, x.id AS xid ORDER BY id, xid`, { ids: website.map((w) => w.id) });
    expect(said).toEqual([]);
    expect(await q("UNWIND $ids AS pid MATCH (:Message)-[:SENT_BY]->(p:Person {id:pid}) RETURN p.id", { ids: website.map((w) => w.id) })).toEqual([]);
  });
});

describe("enrol, insights and the stand-up: the cards waiting for the owner", () => {
  it("the fix, the email with three free times, a reply to a real review and a post are all waiting", async () => {
    const byKind = (k: string) => setup.waiting.filter((w) => w.kind === k);
    const fix = byKind("github_issue").find((w) => /UPI payment timed out/.test(w.title));
    expect(fix, JSON.stringify(setup.waiting)).toBeDefined();
    expect(fix!.sample).toBe(true);
    const email = byKind("email_send").find((w) => /Wholesale beans/.test(w.title));
    expect(email, JSON.stringify(setup.waiting)).toBeDefined();
    const [card] = await q<{ payload: string }>("MATCH (a:Approval {id:$id}) RETURN a.payload AS payload", { id: email!.id });
    const payload = JSON.parse(card!.payload) as { to: string[]; body: string };
    expect(payload.to).toEqual(["ritika@kettleandcrumb.example"]);
    expect(payload.body.match(/GMT\+5:30/g)?.length).toBe(3);
    const reply = byKind("content_draft").find((w) => /Google review/.test(w.title));
    expect(reply, JSON.stringify(setup.waiting)).toBeDefined();
    expect(reply!.sample).toBe(false); // the review is real public data
    const [ev] = await q<{ kind: string }>(
      "MATCH (r:Recommendation)-[:PROPOSES]->(:Approval {id:$id}) MATCH (r)-[:EVIDENCED_BY]->(d:Document) RETURN d.kind AS kind", { id: reply!.id });
    expect(ev).toEqual({ kind: "review" });
    expect(setup.waiting.some((w) => w.kind === "content_draft" && /post/i.test(w.title) && !/review/i.test(w.title))).toBe(true);
    // the campaign's card is marked sample, like every card that stands on sample numbers
    const pause = byKind("pause_ad").find((w) => /new roast/i.test(w.title));
    expect(pause?.sample).toBe(true);
  });

  it("the growth plan has its goals, and sample numbers never set where a goal starts (goals wait for real numbers)", async () => {
    const goals = await q<{ name: string; conf: string | null; baseline: number | null }>(
      "MATCH (gl:Goal) RETURN gl.name AS name, gl.baselineConf AS conf, gl.baseline AS baseline, gl.id AS id ORDER BY id");
    expect(goals.map((x) => x.name)).toEqual(expect.arrayContaining(["Orders per month"]));
    expect(goals.find((x) => x.name === "Orders per month")).toMatchObject({ conf: "unknown", baseline: null });
    expect(setup.goals.locked).toBe(0);
  });
});

describe("the sample connections answer from the same week", () => {
  it("the inbox holds the wholesale enquiry, the gifting enquiry and the UPI complaint", async () => {
    const port = sampleConnections(slug, () => NOW);
    const mail = await port.run<{ apis: { searchInbox(t: string, q: { query: string; max: number }): Promise<Array<{ subject: string; from: string }>> }; accessToken: string }, Array<{ subject: string; from: string }>>(
      "gmail", "search", (s) => s.apis.searchInbox(s.accessToken, { query: "", max: 10 }));
    expect(mail.map((m) => m.subject)).toEqual(expect.arrayContaining(["Wholesale beans for our café in Bengaluru", "Diwali gift boxes for 120 people", "UPI payment failed but money was debited"]));
    for (const m of mail) expect(m.from).toMatch(/\.example>$/);
    expect((await port.list()).map((v) => [v.id, v.state, v.message.startsWith("Sample data")])).toEqual([
      ["gmail", "connected", true], ["google-calendar", "connected", true], ["shopify", "connected", true],
    ]);
  });

  it("Shopify's order count matches the graph, and the calendar's free times avoid its busy blocks", async () => {
    const t = setup.seed.timeline;
    const port = sampleConnections(slug, () => NOW);
    const r = await port.run<{ execute(tool: string, a: Record<string, unknown>): Promise<unknown> }, { count: number; sample: boolean }>(
      "shopify", "count", (s) => s.execute("SHOPIFY_GET_ORDERS_COUNT", { created_at_min: `${t.releaseDay}T00:00:00+05:30`, created_at_max: `${t.lastDay}T23:59:59+05:30` }) as Promise<{ count: number; sample: boolean }>);
    const online = await series(SAMPLE_IDS.onlineStore, "orders"), subs = await series(SAMPLE_IDS.subscriptions, "orders");
    expect(r).toMatchObject({ count: sum(online, t.releaseDay, t.lastDay) + sum(subs, t.releaseDay, t.lastDay), sample: true });
    const times = await proposeTimes(port, NOW, { tz: "Asia/Kolkata" });
    expect(times).toHaveLength(3);
    for (const x of times) {
      const day = new Date(`${x.start.slice(0, 10)}T00:00:00Z`).getUTCDay();
      const hm = x.start.slice(11, 16);
      for (const [a, b] of BUSY_IST[day] ?? []) expect(hm >= a && hm < b, `${x.start} inside ${a}-${b}`).toBe(false);
    }
  });

  it("approving the sample email is a dry run: nothing goes out, not even into the sample outbox", async () => {
    const email = setup.waiting.find((w) => w.kind === "email_send" && /Wholesale beans/.test(w.title))!;
    const r = await decide(g, slug, email.id, { decision: "approve" }, { now: NOW + 3_600_000, actions: { live: false } });
    expect(JSON.stringify(r)).toMatch(/Dry run: would send/);
    expect(sampleConnections(slug, () => NOW).apis.sent).toEqual([]);
  });
});
