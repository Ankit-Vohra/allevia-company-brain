// The on-call and release detectors (Zoya: errors, crashes, Play vitals; Imran: App Store review, release health), run on
// the SYNTHETIC ops snapshot (tests/fixtures/ops) mapped into a throwaway graph, plus a one-off App Store snapshot. Every
// candidate has evidence ids that exist, plain words (no engineer terms), and a stable key. Talks to the local FalkorDB.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { mapSnapshot } from "../../src/ingest/sources/ops-map/index.js";
import { DETECTORS, runDetectors, type Candidate, type DetectorName } from "../../src/insights/detectors.js";
import { runInsights } from "../../src/insights/recommend.js";
import { writeBrief } from "../../src/insights/brief.js";
import { ownerJargon } from "../../src/agent/style.js";
import { testGraph } from "../helpers/graph.js";
import { whenFree } from "../helpers/tools.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/ops/snapshot/2026-10-15", import.meta.url));
const ctx = { tenantSlug: "aamdani", asOf: "2026-10-15" };
const NOW = Date.parse("2026-10-15T04:00:00Z");
const TECH: DetectorName[] = ["tech.sentry_new_issues", "tech.sentry_hot_issue", "tech.crash_free_low", "tech.play_vitals", "tech.app_review_waiting", "tech.release_health"];

const tmp: string[] = [];
function snapshot(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "allevia-tech-"));
  tmp.push(dir);
  for (const [tool, data] of Object.entries(files)) {
    writeFileSync(join(dir, `${tool}.json`), JSON.stringify({ tool, status: "ok", asOf: "2026-10-15T03:00:00Z", sources: [], data }));
  }
  return dir;
}
const STORE = {
  appId: "123", onSale: "2.4.0", headline: "x",
  versions: [{ version: "2.5.0", state: "WAITING_FOR_REVIEW", platform: "IOS", created: "2026-10-05T10:00:00Z" }, { version: "2.4.0", state: "READY_FOR_SALE", platform: "IOS", created: "2026-09-20T10:00:00Z" }],
  submissions: [{ state: "WAITING_FOR_REVIEW", submitted: "2026-10-09T08:00:00Z", daysSinceSubmitted: 6.2 }],
  latestBuilds: [{ build: "88", processing: "VALID", uploaded: "2026-10-08T12:00:00Z", expired: false }],
};

async function load(g: GraphHandle, ...dirs: string[]): Promise<void> {
  await ensureIndexes(g);
  await upsertNode(g, { type: "Business", id: "business:aamdani", name: "Aamdani" }, NOW);
  for (const d of dirs) {
    const s = await writeBatch(g, mapSnapshot(d, ctx).write, NOW);
    expect(s.errors.map((e) => e.error)).toEqual([]);
  }
}

let g: GraphHandle;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ g, cleanup } = await whenFree(async () => {
    const t = await testGraph();
    try { await load(t.g, FIXTURE, snapshot({ app_store_status: STORE })); } catch (e) { await t.cleanup().catch(() => undefined); throw e; }
    return t;
  }));
});
afterAll(async () => {
  await cleanup?.();
  await closeAll();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const run = (name: DetectorName, extra: Record<string, number> = {}): Promise<Candidate[]> => DETECTORS[name].run(g, { now: NOW, ...extra });
const exists = async (ids: string[]): Promise<string[]> =>
  (await g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id", { ids })).map((r) => r.id);

describe("Sentry: new errors and the one hitting the most people (Zoya)", () => {
  it("a pile of new app errors: counted over the period, the crashing ones named, the worst one first, a GitHub issue to triage", async () => {
    const [c] = await run("tech.sentry_new_issues");
    expect(c).toMatchObject({ key: "tech.sentry_new_issues:channel:app", area: "tech", agent: "oncall-engineer", title: "95 new app errors in the last 14 days" });
    expect(c!.numbers).toEqual({ new_errors: 95, period_days: 14, crashed_the_app: 1 });
    expect(c!.why).toContain("95 new kinds of error have shown up in the app over 14 days to 15 Oct");
    expect(c!.why).toContain("1 of the ones we can see crashed the app outright");
    expect(c!.why).toContain('SyntheticCheckoutError: cart is undefined (310 times, 120 people)');
    expect(c!.evidence[1]).toBe("event:sentry-issue-app-7");
    expect(c!.suggestedAction).toMatchObject({ kind: "github_issue", payload: { targetId: "channel:app" } });
    expect(c!.suggestedAction!.payload.body).toContain("- [ ] SyntheticCheckoutError: cart is undefined (310 times, 120 people) (crashed the app)");
  });

  it("a handful of new errors is quiet, unless it is double the last period", async () => {
    const quiet = await run("tech.sentry_new_issues", { newErrorsMin: 200 });
    expect(quiet).toEqual([]);
  });

  it("an issue that crashes or goes unhandled for many people, at most three, each with its own key and issue", async () => {
    const cs = await run("tech.sentry_hot_issue");
    expect(cs.map((c) => c.key)).toEqual(["tech.sentry_hot_issue:event:sentry-issue-app-7", "tech.sentry_hot_issue:event:sentry-issue-app-1"]);
    const [a] = cs;
    expect(a).toMatchObject({ agent: "oncall-engineer", area: "tech", title: 'An app error is hitting 120 people: "SyntheticCheckoutError: cart is undefined"' });
    expect(a!.numbers).toMatchObject({ people: 120, times: 310, period_days: 14, people_using_the_app: 1462 });
    expect(a!.why).toContain("crashed the app 310 times for 120 people in 14 days, out of 1,462 who used the app. First seen 10 Oct.");
    expect(a!.evidence).toEqual(expect.arrayContaining(["event:sentry-issue-app-7"]));
    expect(a!.suggestedAction).toMatchObject({ kind: "github_issue", payload: { targetId: "event:sentry-issue-app-7" } });
    // handled and quiet ones are not here
    expect(cs.map((c) => c.evidence[0])).not.toContain("event:sentry-issue-app-2");
    expect(cs.map((c) => c.evidence[0])).not.toContain("event:sentry-issue-app-9");
  });

  it("people count against the app's own audience: 2 of 17 is a lot, 2 of 1,462 is not", async () => {
    const small = snapshot({ sentry_issues: {
      period: "14d", stability: { crashFreeSessionsPct: 99.9, crashFreeUsersPct: 99.9, sessions: 500, users: 17, series: [] }, newIssues: { count: 0, items: [] },
      topUnresolved: [{ id: "S-1", title: "SyntheticFatal", where: "x", level: "fatal", priority: "high", unhandled: true, eventsInPeriod: 4, users: 2, firstSeen: "2026-10-08", lastSeen: "2026-10-14" }], latestRelease: [] } });
    const { g: g2, cleanup: c2 } = await testGraph();
    try {
      await load(g2, small);
      const cs = await DETECTORS["tech.sentry_hot_issue"].run(g2, { now: NOW });
      expect(cs.map((c) => c.key)).toEqual(["tech.sentry_hot_issue:event:sentry-issue-s-1"]);
      expect(cs[0]!.why).toContain("out of 17 who used the app");
    } finally { await c2(); }
    expect(await run("tech.sentry_hot_issue", {})).toHaveLength(2); // 2 of 1,462 (APP-2, quiet) never qualified
  });
});

describe("crashes and Play vitals (Zoya)", () => {
  it("sessions that crashed, said in plain percentages, only with enough sessions behind them", async () => {
    const [c] = await run("tech.crash_free_low");
    expect(c).toMatchObject({ key: "tech.crash_free_low:channel:app", agent: "oncall-engineer", title: "The app crashed in 1.5% of sessions over 14 days" });
    expect(c!.why).toBe("98.48% of 87,563 sessions ran without a crash in 14 days to 15 Oct; we aim for 99.5% or better. About 4% of the people who used the app hit a crash.");
    expect(c!.numbers).toEqual({ sessions_without_a_crash_pct: 98.48, sessions_that_crashed_pct: 1.5, sessions: 87563, aim_pct: 99.5, people_who_hit_a_crash_pct: 4 });
    expect(c!.confidence).toBe(0.85);
    expect(await run("tech.crash_free_low", { crashFreeMin: 98 })).toEqual([]);
    expect(await run("tech.crash_free_low", { minSessions: 100_000 })).toEqual([]);
  });

  it("Play: a rate near Google's limit is flagged, one comfortably under it is not", async () => {
    const cs = await run("tech.play_vitals");
    expect(cs.map((c) => c.key)).toEqual(["tech.play_vitals:channel:app-android:crash"]); // anr 0.334 vs 0.47: under 80%
    expect(cs[0]).toMatchObject({ agent: "oncall-engineer", title: "Google Play: 0.94% of people had the app crash, close to Google's 1.09% limit" });
    expect(cs[0]!.numbers).toEqual({ rate_pct: 0.94, limit_pct: 1.09, period_days: 7 });
    expect(cs[0]!.why).toContain("Google marks an app as behaving badly above 1.09%, and this is close");
    expect(cs[0]!.suggestedAction).toMatchObject({ kind: "github_issue" });
  });
});

describe("the App Store and releases (Imran)", () => {
  it("an update waiting for review for days, with the version, the day it was sent and where it stands", async () => {
    const [c] = await run("tech.app_review_waiting");
    expect(c).toMatchObject({ key: "tech.app_review_waiting:channel:app-ios", agent: "qa-release", title: "The iPhone app update 2.5.0 has waited 6 days for Apple's review" });
    expect(c!.why).toBe("The iPhone app update 2.5.0 was sent to Apple on 9 Oct and is still waiting in line: 6 days so far. Most reviews finish within a couple of days.");
    expect(c!.numbers).toEqual({ days_waiting: 6.2, limit_days: 3 });
    expect(c!.evidence).toEqual(expect.arrayContaining(["channel:app-ios", "event:ios-version-2-5-0"]));
    expect(c!.suggestedAction).toBeUndefined();
    expect(await run("tech.app_review_waiting", { reviewWaitDays: 7 })).toEqual([]);
  });

  it("release health: new errors since the newest build, and crash-free sessions falling after it", async () => {
    const [c] = await run("tech.release_health");
    expect(c!["key"]).toBe(["tech.release_health", "event", "ios-build-88"].join(":"));
    expect(c).toMatchObject({ agent: "qa-release", title: "Since the app build of 8 Oct: 3 new app errors appeared" });
    expect(c!.numbers).toEqual({ new_errors_since: 3 });
    const fell = (await run("tech.release_health", { releaseDropPoints: 0.9 }))[0]!;
    expect(fell.title).toBe("Since the app build of 8 Oct: sessions without a crash fell from 99.7% to 98.7% and 3 new app errors appeared");
    expect(fell.numbers).toEqual({ before_pct: 99.7, after_pct: 98.7, sessions_after: 44350, new_errors_since: 3 });
    expect(fell.why).toContain("(the 7 days before it: 99.7%; since: 98.7% across 44,350 sessions)");
    expect(fell.evidence[0]).toBe("event:ios-build-88");
    expect(fell.suggestedAction).toMatchObject({ kind: "github_issue", payload: { targetId: "event:ios-build-88" } });
  });
});

describe("every tech candidate", () => {
  it("has evidence that exists in the graph, a stable key, scores in 0..1, and none of the engineer's words", async () => {
    const all = (await runDetectors(g, { now: NOW, only: TECH, releaseDropPoints: 0.9 })).candidates;
    expect(all.length).toBeGreaterThanOrEqual(7);
    const again = (await runDetectors(g, { now: NOW, only: TECH, releaseDropPoints: 0.9 })).candidates;
    expect(again.map((c) => c.key)).toEqual(all.map((c) => c.key));
    for (const c of all) {
      expect(c.area, c.key).toBe("tech");
      expect(["oncall-engineer", "qa-release"], c.key).toContain(c.agent);
      expect(await exists(c.evidence), c.key).toEqual(expect.arrayContaining(c.evidence));
      expect(c.score, c.key).toBeGreaterThan(0);
      expect(c.score, c.key).toBeLessThanOrEqual(1);
      expect(ownerJargon(`${c.title} ${c.why} ${c.impact ?? ""}`), c.key).toEqual([]);
      expect(`${c.title} ${c.why}`, c.key).not.toMatch(/sentry|\banr\b|crash-free/i);
    }
  });

  it("a healthy app raises nothing", async () => {
    const healthy = snapshot({
      sentry_issues: { period: "14d", stability: { crashFreeSessionsPct: 99.9, crashFreeUsersPct: 99.8, sessions: 9000, users: 800, series: [] }, newIssues: { count: 2, items: [] }, topUnresolved: [], latestRelease: [] },
      play_health: { crash: { latestDay: "2026-10-13", last7dUserPerceivedPct: 0.1, last7dPct: 0.1 }, anr: { latestDay: "2026-10-13", last7dUserPerceivedPct: 0.05, last7dPct: 0.05 }, badBehaviourThresholdsPct: { userPerceivedCrash: 1.09, userPerceivedAnr: 0.47 } },
      app_store_status: { ...STORE, submissions: [{ state: "WAITING_FOR_REVIEW", submitted: "2026-10-14T08:00:00Z", daysSinceSubmitted: 0.6 }] },
    });
    const { g: g3, cleanup: c3 } = await testGraph();
    try {
      await load(g3, healthy);
      expect((await runDetectors(g3, { now: NOW, only: TECH })).candidates).toEqual([]);
    } finally { await c3(); }
  });

  it("a business with no ops data raises nothing and reports no detector errors", async () => {
    const { g: g4, cleanup: c4 } = await testGraph();
    try {
      await load(g4);
      const r = await runDetectors(g4, { now: NOW, only: TECH });
      expect(r.candidates).toEqual([]);
      expect(r.errors).toEqual([]);
    } finally { await c4(); }
  });
});

describe("recommendations and Today's note", () => {
  it("become Recommendations by Zoya and Imran in the tech area, and the note gets an On call section in plain words", async () => {
    await runInsights("test", { graph: g, now: NOW, only: TECH });
    const recs = await g.roQuery<{ id: string; by: string; area: string; status: string }>(
      "MATCH (a:Agent)-[:PRODUCED]->(r:Recommendation) WHERE r.area = 'tech' RETURN r.id AS id, r.by AS by, r.area AS area, r.status AS status ORDER BY id");
    expect(new Set(recs.map((r) => r.by))).toEqual(new Set(["oncall-engineer", "qa-release"]));
    expect(recs.every((r) => r.status === "open")).toBe(true);

    const brief = await writeBrief("test", { graph: g, now: NOW });
    const lines = brief.text.split("\n");
    const at = lines.indexOf("On call");
    expect(at).toBeGreaterThan(lines.indexOf("What we noticed"));
    expect(at).toBeLessThan(lines.indexOf("Waiting for your OK"));
    const section = lines.slice(at + 1, lines.indexOf("Waiting for your OK")).filter(Boolean);
    expect(section.length).toBeGreaterThanOrEqual(1);
    expect(section.length).toBeLessThanOrEqual(4);
    expect(section[0]).toMatch(/\((?:Zoya, on call|Imran, app releases)\)\. \[\[recommendation:/);
    expect(brief.onCall.length).toBeGreaterThanOrEqual(3);
    expect(ownerJargon(brief.text)).toEqual([]);
    // the top three above it are not the on-call ones
    expect(brief.top.map((r) => r.id).filter((id) => brief.onCall.some((o) => o.id === id))).toEqual([]);
    // a severe open item is the next step
    expect(brief.next).toMatch(/^Look at this first: /);
  });
});
