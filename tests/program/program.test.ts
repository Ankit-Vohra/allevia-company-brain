// Onboarding v2's program stages and the Allevia 90 scorecard, on a throwaway graph with a synthetic jobs marketplace
// ("Kestrel Jobs") that already has data: daily new accounts (the last one a partial day), a 28-day Instagram reach,
// and nothing from Search Console. Enrolling it must lock the two real baselines, leave the third unknown, start the
// program today with a Day-0 checkpoint, invent no approvals, and change nothing on a second run.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { businessId as bizIdOf } from "../../src/graph/tenants.js";
import { upsertNode, writeBatch, type ObservationInput } from "../../src/graph/upsert.js";
import { onboard, type OnboardResult } from "../../src/onboard/onboard.js";
import { localDate, regionOf, regionOfDomain, resolveRegion } from "../../src/onboard/region.js";
import { targetFor, templateFor } from "../../src/onboard/templates.js";
import { readSource } from "../../src/program/measure.js";
import { getProgram } from "../../src/program/scorecard.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-15T06:00:00Z"); // 11:30 in India
const DAY = 86_400_000;

describe("region and templates", () => {
  it("country defaults: owner's words, then the website, then the domain; explicit values win", () => {
    expect(regionOf("UK")).toMatchObject({ country: "United Kingdom", currency: "GBP", locale: "en-GB", timeZone: "Europe/London" });
    expect(regionOf("Dubai")?.currency).toBe("AED");
    expect(regionOf("Narnia")).toBeUndefined();
    expect(regionOfDomain("www.kestrel.com.au")?.countryCode).toBe("AU");
    expect(regionOfDomain("kestrel.example")).toBeUndefined();
    expect(resolveRegion({ country: "usa", timeZone: "America/Los_Angeles" })).toMatchObject({ country: "United States", currency: "USD", timeZone: "America/Los_Angeles", from: "owner" });
    expect(resolveRegion({}, { country: "United Kingdom" })).toMatchObject({ currency: "GBP", from: "website" });
    expect(resolveRegion({ domain: "studio.ae" })).toMatchObject({ country: "United Arab Emirates", from: "domain" });
    expect(resolveRegion({ timeZone: "Mars/Olympus" })).toEqual({ from: "unknown" });
    expect(localDate(NOW, "Asia/Kolkata")).toBe("2026-10-15");
    expect(localDate(Date.parse("2026-10-15T20:00:00Z"), "Asia/Kolkata")).toBe("2026-10-16");
  });

  it("industry -> template; targets from the baseline, or the template's floor with no baseline", () => {
    expect(templateFor("jobs").key).toBe("jobs_platform");
    expect(templateFor("architecture and interior design studio").key).toBe("architecture_studio");
    expect(templateFor("plumber").key).toBe("local_business"); // no template for the trade yet; a bakery now has one (food_and_drink)
    expect(templateFor("architecture studio").goals.map((g) => g.name)).toEqual(["Qualified enquiries per month", "Instagram reach", "Search clicks"]);
    expect(targetFor({ lift: 0.5, minTarget: 20 }, 79)).toEqual({ target: 119, basis: "baseline" });
    expect(targetFor({ lift: 0.5, minTarget: 20 }, 0)).toEqual({ target: 20, basis: "template" });
    expect(targetFor({ lift: 0.5, minTarget: 20 }, null)).toEqual({ target: 20, basis: "template" });
  });
});

describe("enrol an existing business, then the scorecard (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let slug: string;
  let biz: string;
  let metaGraph: string;
  const events: OnboardEvent[] = [];
  let first: OnboardResult;
  // 2026-10-05 .. 2026-10-15; the 15th was read at 11:30 that morning, so it is a partial day
  const daily = [6, 9, 12, 10, 13, 15, 15, 5, 12, 10, 9, 2];
  const days = daily.map((_, i) => new Date(Date.parse("2026-10-04T00:00:00Z") + i * DAY).toISOString().slice(0, 10));
  const week = daily.slice(-8, -1).reduce((a, b) => a + b, 0); // 8 Oct .. 14 Oct

  const input = () => ({ name: "Kestrel Jobs", slug, website: false as const, industry: "jobs", country: "India", domain: "kestrel.example" });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    slug = g.name.replace(/^allevia_/, "");
    biz = bizIdOf(slug);
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    await upsertNode(g, { type: "Business", id: biz, name: "Kestrel Jobs" }, NOW - 30 * DAY);
    const obs: ObservationInput[] = days.map((d, i) => ({
      subject: biz, metric: "new_accounts", value: daily[i]!, unit: "count", windowStart: d, windowEnd: d, asOf: "2026-10-15", src: "document:snapshot-new-users",
    }));
    obs.push({ subject: "channel:instagram", metric: "account_reach", value: 2100, unit: "accounts", windowStart: "2026-09-16", windowEnd: "2026-10-14", asOf: "2026-10-15", src: "document:snapshot-reach" });
    // simulated and stale numbers never count
    obs.push({ subject: "channel:instagram", metric: "account_reach", value: 99999, windowStart: "2026-09-16", windowEnd: "2026-10-13", asOf: "2026-10-15", src: "document:snapshot-reach", simulated: true });
    obs.push({ subject: "channel:google-search", metric: "gsc_clicks", value: 400, windowStart: "2026-07-01", windowEnd: "2026-07-28", asOf: "2026-07-29", src: "document:snapshot-reach" });
    const s = await writeBatch(g, {
      nodes: [
        { type: "Channel", id: "channel:instagram", name: "Instagram" },
        { type: "Channel", id: "channel:google-search", name: "Google Search" },
        { type: "Document", id: "document:snapshot-new-users", name: "new users snapshot", props: { kind: "snapshot" }, asOf: "2026-10-15" },
        { type: "Document", id: "document:snapshot-reach", name: "reach snapshot", props: { kind: "snapshot" }, asOf: "2026-10-15" },
      ],
      observations: obs,
    }, NOW - DAY);
    expect(s.errors).toEqual([]);
    first = await onboard(input(), (e) => events.push(e), { tenantOpts: { metaGraph }, now: () => NOW, dataDir: `/tmp/${slug}-unused`, model: "haiku" });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    await closeAll();
  });

  const q = <T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);

  it("streams profile, goals, baseline, capabilities and done, with no crawl and no errors", () => {
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.flatMap((e) => (e.type === "stage" ? [e.stage] : []))).toEqual(["profile", "goals", "baseline", "capabilities", "done"]);
    expect(events.some((e) => e.type === "nodes")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", tenant: slug });
    expect(first.ok).toBe(true);
  });

  it("profile: country defaults and the template on the Business and the registry entry", async () => {
    const [b] = await q("MATCH (b:Business {id:$id}) RETURN b.country AS country, b.currency AS currency, b.locale AS locale, b.timeZone AS tz, b.templateKey AS tk, b.privacyRegime AS pr", { id: biz });
    expect(b).toEqual({ country: "India", currency: "INR", locale: "en-IN", tz: "Asia/Kolkata", tk: "jobs_platform", pr: "in_dpdp" });
    const [t] = await (await openGraphByName(metaGraph)).roQuery<{ c: string; tz: string }>("MATCH (t:Tenant {slug:$s}) RETURN t.currency AS c, t.timeZone AS tz", { s: slug });
    expect(t).toEqual({ c: "INR", tz: "Asia/Kolkata" });
  });

  it("goals: three from the template, pursued, tracked, owned, part of the program, sourced from the template", async () => {
    const goals = await q<{ id: string; name: string; owner: string; metric: string; prog: string; tpl: string }>(
      `MATCH (b:Business {id:$b})-[:PURSUES]->(gl:Goal)-[:TRACKS]->(m:Metric), (a:Agent)-[:OWNS]->(gl), (gl)-[:PART_OF]->(p:Program), (gl)-[:SOURCED_FROM]->(d:Document {kind:'template'})
       RETURN gl.id AS id, gl.name AS name, a.rosterId AS owner, m.key AS metric, p.id AS prog, d.id AS tpl ORDER BY gl.priority, gl.id`, { b: biz });
    expect(goals.map((x) => [x.name, x.owner, x.metric])).toEqual([
      ["Weekly signups", "growth-marketer", "new_accounts"], ["Instagram reach", "content-strategist", "account_reach"], ["Search clicks", "data-analyst", "gsc_clicks"],
    ]);
    expect(new Set(goals.map((x) => x.prog)).size).toBe(1);
    const [p] = await q<{ kind: string; start: string; end: string; status: string }>(
      "MATCH (:Business {id:$b})-[e:ENROLLED_IN]->(p:Program) WHERE e.until IS NULL RETURN p.kind AS kind, p.startDate AS start, p.endDate AS end, p.status AS status", { b: biz });
    expect(p).toEqual({ kind: "allevia90", start: "2026-10-15", end: "2027-01-13", status: "active" });
  });

  it("baseline: real numbers only (the partial day, simulated and stale readings left out); unknown stays unknown", async () => {
    const goals = await q<{ name: string; baseline: number | null; conf: string; target: number; basis: string; at: string | null; due: string }>(
      "MATCH (gl:Goal) RETURN gl.name AS name, gl.baseline AS baseline, gl.baselineConf AS conf, gl.target AS target, gl.targetBasis AS basis, gl.baselineAt AS at, gl.dueAt AS due ORDER BY gl.priority, gl.id");
    expect(goals).toEqual([
      { name: "Weekly signups", baseline: week, conf: "measured", target: Math.ceil(week * 1.5), basis: "baseline", at: "2026-10-14", due: "2027-01-13" },
      { name: "Instagram reach", baseline: 2100, conf: "measured", target: 3150, basis: "baseline", at: "2026-10-14", due: "2027-01-13" },
      { name: "Search clicks", baseline: null, conf: "unknown", target: 50, basis: "template", at: null, due: "2027-01-13" },
    ]);
    const base = await q<{ id: string; v: number; ws: string; we: string; src: string; doc: string; cp: string }>(
      `MATCH (o:Observation {baseline:true})-[:MEASURES]->(gl:Goal {id:'goal:weekly-signups'}), (o)-[:SOURCED_FROM]->(d:Document), (o)-[:MEASURES]->(c:Checkpoint)
       RETURN o.id AS id, o.value AS v, o.windowStart AS ws, o.windowEnd AS we, o.src AS src, d.id AS doc, c.id AS cp`);
    expect(base).toEqual([{ id: "obs:new_accounts:goal:weekly-signups:baseline", v: week, ws: "2026-10-08", we: "2026-10-14", src: "document:snapshot-new-users", doc: "document:snapshot-new-users", cp: expect.stringMatching(/^checkpoint:.*day-0$/) }]);
    expect(await q("MATCH (o:Observation {baseline:true})-[:MEASURES]->(:Goal {id:'goal:search-clicks'}) RETURN o")).toEqual([]);
  });

  it("Day-0 checkpoint measured by the program's own numbers; no approval history is made up", async () => {
    const [cp] = await q<{ day: number; date: string }>("MATCH (c:Checkpoint)-[:PART_OF]->(:Program) RETURN c.day AS day, c.date AS date");
    expect(cp).toEqual({ day: 0, date: "2026-10-15" });
    const m = await q<{ metric: string; v: number }>("MATCH (o:Observation)-[:MEASURES]->(:Checkpoint) WHERE o.metric STARTS WITH 'allevia.' RETURN o.metric AS metric, o.value AS v ORDER BY metric, o.id");
    expect(m).toEqual([{ metric: "allevia.deliverables_approved", v: 0 }, { metric: "allevia.learned_rules", v: 0 }]);
    expect((await q<{ c: number }>("MATCH (a:Approval) RETURN count(a) AS c"))[0]!.c).toBe(0);
    expect(first.capabilities?.length).toBe(9);
  });

  it("enrolling again changes nothing: same program, baselines locked", async () => {
    const again: OnboardEvent[] = [];
    const second = await onboard(input(), (e) => again.push(e), { tenantOpts: { metaGraph }, now: () => NOW + 3_600_000, dataDir: `/tmp/${slug}-unused`, model: "haiku" });
    expect(again.filter((e) => e.type === "error")).toEqual([]);
    expect(second.stats).toMatchObject({ nodesCreated: 0, edgesCreated: 0, versions: 0, edgesClosed: 0 });
    expect(second.goals).toEqual([]);
    expect(second.counts).toEqual(first.counts);
  }, 30_000);

  it("measures goals over complete periods only", async () => {
    const r = await readSource(g, { metric: "new_accounts", subject: "business", agg: "daily_sum" }, { businessId: biz, period: "week", today: "2026-10-15" });
    expect(r).toMatchObject({ value: week, windowStart: "2026-10-08", windowEnd: "2026-10-14", conf: null });
    expect(r!.obsIds).toHaveLength(7);
    // a missing day means no reading, never a guess
    expect(await readSource(g, { metric: "new_accounts", subject: "business", agg: "daily_sum" }, { businessId: biz, period: "week", today: "2026-10-15", until: "2026-10-09" })).toBeNull();
    expect(await readSource(g, { metric: "gsc_clicks", subject: "channel:google-search", agg: "window" }, { businessId: biz, period: "month", today: "2026-10-15" })).toBeNull();
  });

  it("the scorecard on Day 0", async () => {
    const p = (await getProgram(g, { now: NOW + 3_600_000 }))!;
    expect(p).toMatchObject({ day: 0, daysLeft: 90, status: "active", startDate: "2026-10-15", endDate: "2027-01-13", timeZone: "Asia/Kolkata", templateKey: "jobs_platform" });
    expect(p.checkpoints.map((c) => [c.day, c.status])).toEqual([[0, "done"], [30, "upcoming"], [60, "upcoming"], [90, "upcoming"]]);
    expect(p.firstPass).toEqual({ rate: null, decided30d: 0, firstPass30d: 0, series: [{ date: "2026-10-15", rate: null, decided: 0, firstPass: 0 }] });
    expect(p.learnedRules).toMatchObject({ active: 0, learnedSinceStart: 0 });
    expect(p.deliverables).toEqual({ approved: 0, approvedSinceStart: 0, editedSinceStart: 0, rejectedSinceStart: 0, pending: 0 });
    expect(p.goals.map((x) => [x.name, x.baseline, x.current, x.target, x.status, x.owner?.name])).toEqual([
      ["Weekly signups", week, week, Math.ceil(week * 1.5), "on_track", "Growth Hacker"],
      ["Instagram reach", 2100, 2100, 3150, "on_track", "Miss Influencer"],
      ["Search clicks", null, null, 50, "no_data", "Data Detective"],
    ]);
    expect(Object.values(p.capabilities.byMode).reduce((a, b) => a + b, 0)).toBe(9);
  });

  it("later: approvals decided since the start make the first-pass curve; day 30 writes its checkpoint and new readings", async () => {
    const start = NOW;
    for (const [i, fp] of [[1, false], [2, true], [3, true]] as const) {
      await upsertNode(g, { type: "Approval", id: `approval:k-${i}`, name: `content_draft: post ${i}`,
        props: { status: fp ? "executed" : "executed", decision: "approve", firstPass: fp, decidedAt: start + i * DAY + 3_600_000, kind: "content_draft" } }, start + i * DAY);
    }
    // a new complete week of signups arrives
    const later = Array.from({ length: 7 }, (_, i) => new Date(Date.parse("2026-11-08T00:00:00Z") + i * DAY).toISOString().slice(0, 10));
    await writeBatch(g, { observations: later.map((d) => ({ subject: biz, metric: "new_accounts", value: 20, unit: "count", windowStart: d, windowEnd: d, asOf: "2026-11-15", src: "document:snapshot-new-users" })) }, start + 31 * DAY);
    const p = (await getProgram(g, { now: start + 31 * DAY }))!;
    expect(p.day).toBe(31);
    expect(p.checkpoints.map((c) => [c.day, c.status])).toEqual([[0, "done"], [30, "done"], [60, "upcoming"], [90, "upcoming"]]);
    expect(p.firstPass.series[0]).toEqual({ date: "2026-10-15", rate: null, decided: 0, firstPass: 0 });
    expect(p.firstPass.series[1]).toEqual({ date: "2026-10-16", rate: 0, decided: 1, firstPass: 0 });
    expect(p.firstPass.series[3]).toEqual({ date: "2026-10-18", rate: 0.667, decided: 3, firstPass: 2 });
    expect(p.deliverables).toMatchObject({ approvedSinceStart: 3, editedSinceStart: 1 });
    const signups = p.goals.find((x) => x.name === "Weekly signups")!;
    expect(signups).toMatchObject({ baseline: week, current: 140, currentAt: "2026-11-14" });
    const d30 = await q<{ m: string }>("MATCH (o:Observation)-[:MEASURES]->(c:Checkpoint {day:30}) RETURN o.metric AS m ORDER BY m, o.id");
    expect(d30.map((x) => x.m)).toEqual(expect.arrayContaining(["allevia.first_pass_rate", "new_accounts"]));
    // read only (public mode) writes nothing
    const before = (await q<{ c: number }>("MATCH (n:Entity) RETURN count(n) AS c"))[0]!.c;
    await getProgram(g, { now: start + 61 * DAY, write: false });
    expect((await q<{ c: number }>("MATCH (n:Entity) RETURN count(n) AS c"))[0]!.c).toBe(before);
  }, 30_000);
});
