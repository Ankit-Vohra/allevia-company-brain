import { describe, it, expect, afterAll } from "vitest";
import { simulateAds, mulberry32, type AdsProfile } from "../../src/ingest/sources/simads.js";
import { isAllowed, type EntityType } from "../../src/graph/schema.js";
import { entityId } from "../../src/util/ids.js";
import { closeAll } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch, type ObservationInput } from "../../src/graph/upsert.js";
import type { SourceResult } from "../../src/ingest/types.js";
import { testGraph } from "../helpers/graph.js";

const base = { tenantSlug: "aamdani", seed: 20261015, days: 28, endDate: "2026-10-14" };
const PROFILES: AdsProfile[] = ["jobs-platform", "architecture-studio"];
const SEEDS = [20261015, 1, 7, 42, 12345];

const NAMES: Record<AdsProfile, string[]> = {
  "jobs-platform": ["Seekers — Raipur reels boost", "Employers — lead form", "Google Search — jobs near me", "YouTube Shorts — brand"],
  "architecture-studio": ["Homeowners — Instagram portfolio", "Google Search — architect near me", "Interior refresh — carousel"],
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// observations of one metric for one campaign, in date order
function series(obs: ObservationInput[], campaignId: string, metric: string): Array<{ date: string; value: number }> {
  return obs.filter((o) => o.subject === campaignId && o.metric === metric).map((o) => ({ date: o.windowEnd!, value: o.value })).sort((a, b) => a.date.localeCompare(b.date));
}

// The two planted stories of a run: each campaign's overall CPA (spend / conversions) and its CTR in the last 7 days
// relative to the days before.
function stories(r: SourceResult): Array<{ name: string; cpa: number; ctrRatio: number }> {
  const obs = r.write.observations;
  const sum = (id: string, m: string) => series(obs, id, m).reduce((a, x) => a + x.value, 0);
  return r.write.nodes.filter((n) => n.type === "Campaign").map((c) => {
    const ctr = series(obs, c.id, "ctr").map((x) => x.value);
    return { name: c.name, cpa: sum(c.id, "spend") / sum(c.id, "conversions"), ctrRatio: mean(ctr.slice(-7)) / mean(ctr.slice(0, -7)) };
  });
}

describe("mulberry32", () => {
  it("is a deterministic generator of floats in [0, 1)", () => {
    const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs).not.toEqual(Array.from({ length: 5 }, () => c()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe.each(PROFILES)("simulateAds(%s)", (profile) => {
  const opts = { ...base, profile };
  const res = simulateAds(opts);
  const { nodes, edges, observations } = res.write;
  const doc = entityId("Document", "simulated ads aamdani");
  const campaigns = nodes.filter((n) => n.type === "Campaign");
  const cid = (name: string) => entityId("Campaign", name);
  const convOf = (c: (typeof campaigns)[number]) => String(c.props?.conversionMetric);

  it("is a simads SourceResult with the campaigns of the profile", () => {
    expect(res.source).toBe("simads");
    expect(res.docs).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.redactions).toEqual({});
    expect(campaigns.map((c) => c.name).sort()).toEqual([...NAMES[profile]].sort());
    expect(nodes.filter((n) => n.type === "Channel").map((n) => n.id).sort()).toEqual(["channel:google-ads", "channel:meta-ads"]);
  });

  it("marks the ad channels as not connected with simulated data, without flagging the real platforms or taking their src", () => {
    for (const ch of nodes.filter((n) => n.type === "Channel")) {
      expect(ch.props, ch.id).toMatchObject({ status: "not_connected", dataSimulated: true });
      expect(ch.simulated, ch.id).toBeUndefined();
      expect(ch.src, ch.id).toBeUndefined();
      expect(ch.asOf, ch.id).toBeUndefined();
    }
  });

  it.each(SEEDS)("is deterministic for seed %i: the same seed gives identical output, another seed does not", (seed) => {
    const a = simulateAds({ ...opts, seed });
    expect(simulateAds({ ...opts, seed })).toEqual(a);
    expect(JSON.stringify(simulateAds({ ...opts, seed: seed + 1 }).write.observations)).not.toBe(JSON.stringify(a.write.observations));
  });

  it("has one snapshot Document, flagged simulated", () => {
    const docs = nodes.filter((n) => n.type === "Document");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: doc, simulated: true, props: { kind: "snapshot", seed: opts.seed, days: 28, profile, endDate: "2026-10-14" } });
    expect(docs[0]!.props?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags the Document, every Campaign and every observation as simulated (audiences and channels are real and stay unflagged)", () => {
    for (const n of nodes) {
      if (n.type === "Audience" || n.type === "Channel") expect(n.simulated, n.id).toBeUndefined();
      else expect(n.simulated, n.id).toBe(true);
    }
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) {
      expect(o.simulated).toBe(true);
      expect(o.src).toBe(doc);
    }
    for (const c of campaigns) expect(c.props?.status).toBe("active");
  });

  it("sources every node from the Document and uses allowed edges between nodes it emits", () => {
    const type = new Map<string, EntityType>(nodes.map((n) => [n.id, n.type]));
    for (const n of nodes) {
      if (n.id === doc) continue;
      expect(edges.some((e) => e.type === "SOURCED_FROM" && e.from === n.id && e.to === doc), n.id).toBe(true);
      if (n.type !== "Channel") expect(n.src).toBe(doc); // a real platform's `src` is not ours to set
    }
    for (const e of edges) {
      expect(type.has(e.from) && type.has(e.to), `${e.from} -> ${e.to}`).toBe(true);
      expect(isAllowed(type.get(e.from)!, e.type, type.get(e.to)!), `${e.from} ${e.type} ${e.to}`).toBe(true);
    }
    for (const o of observations) expect(type.get(o.subject)).toBe("Campaign");
  });

  it("publishes each campaign on one ad channel and targets one audience", () => {
    for (const c of campaigns) {
      expect(edges.filter((e) => e.type === "PUBLISHED_ON" && e.from === c.id)).toHaveLength(1);
      expect(edges.filter((e) => e.type === "TARGETS" && e.from === c.id)).toHaveLength(1);
    }
    const published = (name: string) => edges.find((e) => e.type === "PUBLISHED_ON" && e.from === cid(name))?.to;
    for (const name of NAMES[profile]) expect(published(name)).toBe(name.startsWith("Google") || name.startsWith("YouTube") ? "channel:google-ads" : "channel:meta-ads");
    const audiences = nodes.filter((n) => n.type === "Audience").map((n) => n.id).sort();
    expect(audiences).toEqual(profile === "jobs-platform" ? ["audience:employers", "audience:job-seekers"] : ["audience:homeowners"]);
  });

  it("emits a daily series per campaign over the window, ending on endDate", () => {
    const metrics = new Set(observations.map((o) => o.metric));
    expect(metrics).toEqual(new Set(["spend", "impressions", "clicks", "ctr", "cpa", "conversions", ...campaigns.map(convOf)]));
    for (const c of campaigns) for (const m of ["spend", "impressions", "clicks", "ctr", "cpa", "conversions", convOf(c)]) {
      const s = series(observations, c.id, m);
      expect(s, `${c.id} ${m}`).toHaveLength(28);
      expect(s[0]!.date).toBe("2026-09-17");
      expect(s[27]!.date).toBe("2026-10-14");
    }
    // each campaign reports exactly one conversion metric
    for (const c of campaigns) expect(observations.filter((o) => o.subject === c.id && ["signups", "leads"].includes(o.metric) && o.metric !== convOf(c))).toEqual([]);
    for (const o of observations) expect([o.windowStart, o.windowEnd, o.asOf]).toEqual([o.windowStart, o.windowStart, o.windowStart]);
    const ids = observations.map((o) => `${o.metric}|${o.subject}|${o.windowEnd}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has realistic magnitudes and internally consistent derived metrics", () => {
    for (const c of campaigns) {
      const spend = series(observations, c.id, "spend"), imp = series(observations, c.id, "impressions"), clk = series(observations, c.id, "clicks");
      const cv = series(observations, c.id, "conversions"), ctr = series(observations, c.id, "ctr"), cpa = series(observations, c.id, "cpa");
      // every campaign reports the unified `conversions`, equal to its natural signups/leads count
      expect(cv.map((x) => x.value), c.id).toEqual(series(observations, c.id, convOf(c)).map((x) => x.value));
      spend.forEach((s, i) => {
        expect(s.value, `${c.id} spend`).toBeGreaterThanOrEqual(300);
        expect(s.value).toBeLessThanOrEqual(2500);
        for (const x of [imp[i]!.value, clk[i]!.value, cv[i]!.value]) expect(Number.isInteger(x) && x > 0).toBe(true);
        expect(clk[i]!.value).toBeLessThanOrEqual(imp[i]!.value);
        expect(cv[i]!.value).toBeLessThanOrEqual(clk[i]!.value);
        expect(ctr[i]!.value).toBeCloseTo((clk[i]!.value / imp[i]!.value) * 100, 2);
        expect(cpa[i]!.value).toBeCloseTo(s.value / cv[i]!.value, 2);
      });
    }
    const unit = (m: string) => new Set(observations.filter((o) => o.metric === m).map((o) => o.unit));
    expect(unit("spend")).toEqual(new Set(["INR"]));
    expect(unit("cpa")).toEqual(new Set(["INR"]));
    expect(unit("ctr")).toEqual(new Set(["%"]));
  });

  it.each(SEEDS)("seed %i: exactly one underperformer, whose CPA is 1.8x to 2.6x the median", (seed) => {
    const cpa = stories(simulateAds({ ...opts, seed }));
    const med = median(cpa.map((x) => x.cpa));
    const bad = cpa.filter((x) => x.cpa >= 1.5 * med);
    expect(bad, JSON.stringify(cpa)).toHaveLength(1);
    expect(bad[0]!.cpa).toBeGreaterThanOrEqual(1.8 * med);
    expect(bad[0]!.cpa).toBeLessThanOrEqual(2.6 * med);
  });

  it.each(SEEDS)("seed %i: exactly one campaign has a CTR drop in the last 7 days, the others steady, and it is not the underperformer", (seed) => {
    const st = stories(simulateAds({ ...opts, seed }));
    const dropped = st.filter((x) => x.ctrRatio <= 0.8);
    expect(dropped, JSON.stringify(st)).toHaveLength(1);
    expect(dropped[0]!.ctrRatio).toBeGreaterThanOrEqual(0.5);
    for (const x of st.filter((y) => y.ctrRatio > 0.8)) {
      expect(x.ctrRatio, x.name).toBeGreaterThan(0.88);
      expect(x.ctrRatio, x.name).toBeLessThan(1.12);
    }
    const worst = [...st].sort((a, b) => b.cpa - a.cpa)[0]!;
    expect(worst.name).not.toBe(dropped[0]!.name);
  });

  it("does not give the answer away in node props", () => {
    expect(JSON.stringify(nodes).toLowerCase()).not.toMatch(/underperform|ctr drop|fatigue|anomal/);
  });
});

describe("simulateAds: details", () => {
  it("has weekly seasonality: employer spend is lower on weekends", () => {
    const { observations } = simulateAds({ ...base, profile: "jobs-platform" }).write;
    const s = series(observations, entityId("Campaign", "Employers — lead form"), "spend");
    const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    const weekend = s.filter((x) => [0, 6].includes(dow(x.date))).map((x) => x.value);
    const weekday = s.filter((x) => ![0, 6].includes(dow(x.date))).map((x) => x.value);
    expect(mean(weekend)).toBeLessThan(0.9 * mean(weekday));
  });

  it("works for other window sizes and rejects invalid options", () => {
    const week = simulateAds({ ...base, days: 7, profile: "architecture-studio" }).write.observations;
    expect(week).toHaveLength(3 * 7 * 7);
    expect(() => simulateAds({ ...base, days: 0, profile: "jobs-platform" })).toThrow(/days/);
    expect(() => simulateAds({ ...base, endDate: "14/10/2026", profile: "jobs-platform" })).toThrow(/endDate/);
    expect(() => simulateAds({ ...base, profile: "bakery" as AdsProfile })).toThrow(/profile/);
  });

  it("names the Document after the tenant", () => {
    const r = simulateAds({ ...base, tenantSlug: "avs", profile: "architecture-studio" });
    expect(r.write.nodes.some((n) => n.id === entityId("Document", "simulated ads avs"))).toBe(true);
  });
});

describe("simulateAds: graph write (integration)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterAll(async () => {
    await cleanup?.();
    await closeAll();
  });

  it("writes cleanly, flags simulated data in the graph and is idempotent", async () => {
    const r = simulateAds({ ...base, days: 14, profile: "jobs-platform" });
    const t = await testGraph();
    cleanup = t.cleanup;
    await ensureIndexes(t.g);
    const first = await writeBatch(t.g, r.write, 1_760_000_000_000);
    expect(first.errors).toEqual([]);
    expect(first.observations).toBe(r.write.observations.length);
    const again = await writeBatch(t.g, r.write, 1_760_000_100_000);
    expect(again.errors).toEqual([]);
    expect(again.nodesCreated).toBe(0);
    expect(again.versions).toBe(0);
    const q = (cy: string) => t.g.roQuery<{ c: number }>(cy).then((rows) => rows[0]!.c);
    expect(await q("MATCH (o:Entity:Observation) RETURN count(o) AS c")).toBe(r.write.observations.length);
    expect(await q("MATCH (o:Entity:Observation) WHERE o.simulated = true RETURN count(o) AS c")).toBe(r.write.observations.length);
    expect(await q("MATCH (o:Entity:Observation)-[:SOURCED_FROM]->(:Entity:Document {id:'document:simulated-ads-aamdani'}) RETURN count(o) AS c")).toBe(r.write.observations.length);
    expect(await q("MATCH (c:Entity:Campaign) WHERE c.simulated = true RETURN count(c) AS c")).toBe(4);
  }, 90_000);
});
