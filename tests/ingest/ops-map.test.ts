// Mappers from a recorded ops snapshot (one envelope per tool file) to graph writes. The fixture snapshot under
// tests/fixtures/ops/snapshot/ is SYNTHETIC: it mirrors the aamdani-ops envelope shapes with seeded random numbers
// (checked against a real snapshot: no non-constant value matches), and it plants personal data (a phone, emails, a
// user id, a host) that must never reach the graph. Expected values are read from the fixture files themselves.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countWrite, funnelStep, mapSnapshot, stripPersonalFields } from "../../src/ingest/sources/ops-map/index.js";
import { isAllowed } from "../../src/graph/schema.js";
import { observationId, type ObservationInput } from "../../src/graph/upsert.js";
import { typeFromId } from "../../src/util/ids.js";

const DIR = fileURLToPath(new URL("../fixtures/ops/snapshot/2026-10-15", import.meta.url));
const ctx = { tenantSlug: "aamdani", asOf: "2026-10-15" };
const r = mapSnapshot(DIR, ctx);
const { nodes, edges, observations } = r.write;

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A fixture file's envelope data. */
const fx = (call: string): J => JSON.parse(readFileSync(join(DIR, `${call}.json`), "utf8")).data;
const node = (id: string) => nodes.find((n) => n.id === id);
const obs = (subject: string, metric: string, at?: string): ObservationInput | undefined =>
  observations.find((o) => o.subject === subject && o.metric === metric && (at === undefined || (o.windowEnd ?? o.asOf) === at));
const val = (subject: string, metric: string, at?: string) => obs(subject, metric, at)?.value;
const doc = (call: string) => `document:ops-snapshot-${call}-2026-10-15`;
const BIZ = "business:aamdani";

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
/** A one-off snapshot dir with the given envelope files. */
function snap(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "allevia-opsmap-"));
  tmp.push(dir);
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
}
const env = (tool: string, data: unknown) => ({ tool, status: "ok", asOf: "2026-10-15T03:00:00Z", sources: [], data });
const RANGE = { from: "2026-09-18", to: "2026-10-15", days: 28 };

describe("mapSnapshot: shape and invariants", () => {
  it("is the ops source with one snapshot Document per mapped tool file, and no source labels", () => {
    expect(r.source).toBe("ops");
    expect(r.docs).toEqual([]);
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json");
    const docs = nodes.filter((n) => n.type === "Document");
    expect(docs).toHaveLength(files.length);
    expect(node(doc("users-summary"))).toMatchObject({ type: "Document", props: { kind: "snapshot", tool: "users_summary", status: "ok" }, asOf: "2026-10-15" });
    expect(node(doc("search-console-page"))?.props?.tool).toBe("search_console");
    expect(node(doc("users-summary"))?.props?.hash).toMatch(/^[0-9a-f]{64}$/);
    // The envelope's source labels name database roles, tables and account ids: never in the graph.
    for (const d of docs) expect(d.props, d.id).not.toHaveProperty("sources");
  });

  it("has unique ids, and every edge is an allowed pattern between known nodes", () => {
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    expect(new Set(observations.map((o) => observationId(o))).size).toBe(observations.length);
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      const from = typeFromId(e.from)!, to = typeFromId(e.to)!;
      expect(isAllowed(from, e.type, to), `${e.from} ${e.type} ${e.to}`).toBe(true);
      expect(ids.has(e.from) || e.from === BIZ, e.from).toBe(true);
      expect(ids.has(e.to) || e.to === BIZ, e.to).toBe(true);
    }
    for (const n of nodes) expect(typeFromId(n.id), n.id).toBe(n.type);
  });

  it("every observation measures a node in the write (or the Business) and cites its snapshot Document", () => {
    const ids = new Set(nodes.map((n) => n.id));
    const docs = new Set(nodes.filter((n) => n.type === "Document").map((n) => n.id));
    expect(observations.length).toBeGreaterThan(100);
    for (const o of observations) {
      expect(ids.has(o.subject) || o.subject === BIZ, o.subject).toBe(true);
      expect(docs.has(o.src), o.src).toBe(true);
      expect(o.metric).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(Number.isFinite(o.value)).toBe(true);
      expect(o.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(isAllowed("Observation", "MEASURES", typeFromId(o.subject)!)).toBe(true);
    }
  });

  it("percentages end in _pct and are 0-100 with unit %; windows live in windowStart/windowEnd, not in names", () => {
    for (const o of observations) {
      // (an age threshold such as review_queue_older_than_30_days or _over_48h is a definition, not a window)
      expect(o.metric, o.metric).not.toMatch(/_\d+d(_|$)|(?<!_over)_\d+h(_|$)|_last_?\d+|_share$|_ctr$|_rate$/);
      if (o.metric.endsWith("_pct")) {
        expect(o.unit, o.metric).toBe("%");
        expect(o.value, o.metric).toBeGreaterThanOrEqual(0);
        expect(o.value, o.metric).toBeLessThanOrEqual(100);
      }
      if (o.windowStart || o.windowEnd) expect(o.windowStart! <= o.windowEnd!, o.metric).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(mapSnapshot(DIR, ctx)).toEqual(r);
  });

  it("countWrite tallies types and metrics without values", () => {
    const c = countWrite(r);
    expect(c.nodes.Document).toBe(23);
    expect(c.nodes.Channel).toBeGreaterThanOrEqual(10);
    expect(c.nodes.Task).toBeUndefined();
    expect(c.edges.PUBLISHED_ON).toBeGreaterThanOrEqual(5);
    expect(c.observations.reel_views).toBe(3);
    expect(Object.values(c.observations).reduce((a, b) => a + b, 0)).toBe(observations.length);
    expect(c.skipped).toBe(1);
    expect(JSON.stringify(c)).not.toMatch(/"value"/);
  });

  it("skips envelopes that are not ok, but keeps their Document", () => {
    expect(r.skipped).toContainEqual({ ref: "app_store_status.json", reason: expect.stringMatching(/not_configured/) });
    expect(node(doc("app-store-status"))?.props?.status).toBe("not_configured");
    expect(observations.filter((o) => o.src === doc("app-store-status"))).toEqual([]);
  });
});

describe("mapSnapshot: one bad file never spoils the rest", () => {
  it("an unreadable file is skipped with its reason; the others map", () => {
    const dir = snap({ "users_summary.json": "{not json", "marketplace.json": env("marketplace", { range: RANGE, inWindow: { hires: 31 } }) });
    const out = mapSnapshot(dir, ctx);
    expect(out.skipped).toContainEqual({ ref: "users_summary.json", reason: expect.stringMatching(/could not map/) });
    expect(out.write.observations.find((o) => o.metric === "hires")?.value).toBe(31);
    expect(out.write.nodes.find((n) => n.id === doc("users-summary"))).toBeUndefined();
  });

  it("a mapper that throws half-way is rolled back: nothing from that file stays", () => {
    // ai_features maps screening numbers first, then the voice channel, then trips on a 150% completion rate.
    const dir = snap({
      "ai_features.json": env("ai_features", { range: RANGE, screening: { calls: 41 }, voiceOnboarding: { sessions: 23, completionRatePct: 150 } }),
      "marketplace.json": env("marketplace", { range: RANGE, inWindow: { hires: 31 } }),
    });
    const out = mapSnapshot(dir, ctx);
    expect(out.skipped).toContainEqual({ ref: "ai_features.json", reason: expect.stringMatching(/could not map: .*0-100/) });
    expect(out.write.observations.map((o) => o.metric).sort()).toEqual(["hires"]);
    expect(out.write.nodes.map((n) => n.id)).not.toContain("channel:voice-onboarding");
    expect(out.write.nodes.map((n) => n.id)).not.toContain(doc("ai-features"));
  });

  it("an unreadable manifest only loses the call arguments", () => {
    const dir = snap({ "manifest.json": "{", "marketplace.json": env("marketplace", { range: RANGE, inWindow: { hires: 31 } }) });
    const out = mapSnapshot(dir, ctx);
    expect(out.skipped).toContainEqual({ ref: "manifest.json", reason: expect.stringMatching(/unreadable/) });
    expect(out.write.observations).toHaveLength(1);
  });
});

describe("mapSnapshot: users and sign-ups", () => {
  const acq = fx("acquisition_sources");
  const signupsOf = (ch: string) => acq.byChannel.find((c: J) => c.channel === ch).signups;

  it("signups per acquisition channel over the window, and the unattributed rest on the Business", () => {
    expect(obs("channel:instagram", "signups")).toMatchObject({ value: signupsOf("instagram"), windowStart: "2026-09-18", windowEnd: "2026-10-15", src: doc("acquisition-sources") });
    expect(val("channel:website", "signups")).toBe(signupsOf("website"));
    expect(val("channel:google-search", "signups")).toBe(signupsOf("search"));
    expect(val("channel:ai-search", "signups")).toBe(signupsOf("ai_search"));
    expect(val("channel:play-store", "signups")).toBe(signupsOf("play_store"));
    expect(val(BIZ, "signups")).toBe(acq.signups);
    expect(val(BIZ, "signups_organic")).toBe(signupsOf("organic"));
    expect(val(BIZ, "signups_unattributed")).toBe(signupsOf("unknown_old_app") + signupsOf("unknown"));
    expect(val(BIZ, "signups_other_tagged")).toBe(signupsOf("other_tagged"));
    expect(node("channel:organic")).toBeUndefined();
  });

  it("users_total by audience, setup as _pct, accounts by platform and by sign-up channel over 30 days", () => {
    const u = fx("users_summary");
    expect(node("audience:seekers")).toMatchObject({ type: "Audience", name: "Seekers" });
    expect(val("audience:seekers", "users_total")).toBe(u.totals.seekers.total);
    expect(val("audience:employers", "users_total")).toBe(u.totals.employers);
    expect(val(BIZ, "users_total")).toBe(u.totals.all);
    expect(obs(BIZ, "setup_completed_pct")).toMatchObject({ value: u.setup.completedPct, unit: "%" });
    expect(val("audience:seekers", "setup_completed_pct")).toBe(u.setup.seekers.pct);
    const android = u.bySignupPlatform.find((p: J) => p.platform === "android");
    expect(val("channel:app-android", "accounts_total")).toBe(android.total);
    expect(obs("channel:app-android", "new_accounts")).toMatchObject({ value: android.last30Days, windowStart: "2026-09-16", windowEnd: "2026-10-15" });
    expect(val("channel:web-app", "accounts_total")).toBe(u.bySignupPlatform.find((p: J) => p.platform === "web").total);
    expect(val("channel:app-ios", "accounts_total")).toBe(u.bySignupPlatform.find((p: J) => p.platform === "ios").total);
    expect(val("channel:voice-onboarding", "accounts_total")).toBe(u.byChannel.find((c: J) => c.createdVia === "voice_onboarding").total);
    expect(val("channel:helpline", "accounts_total")).toBe(u.byChannel.find((c: J) => c.createdVia === "helpline").total);
  });

  it("new accounts per day", () => {
    const rows = fx("new_users").rows as J[];
    const d14 = rows.find((x) => x.day === "2026-10-14")!, d13 = rows.find((x) => x.day === "2026-10-13")!;
    expect(obs(BIZ, "new_accounts", "2026-10-14")).toMatchObject({ value: d14.total, windowStart: "2026-10-14", windowEnd: "2026-10-14" });
    expect(val("audience:seekers", "new_accounts", "2026-10-13")).toBe(d13.seekers);
  });

  it("the sign-up funnel per step, for seekers and employers", () => {
    const f = fx("signup_funnel");
    const count = (who: string, stage: string) => f[who].stages.find((s: J) => s.stage === stage).count;
    expect(val("audience:seekers", "signup_funnel_accounts_created")).toBe(count("seekers", "accounts created"));
    expect(val("audience:seekers", "signup_funnel_otp_verified")).toBe(count("seekers", "OTP verified"));
    expect(val("audience:seekers", "signup_funnel_setup_completed")).toBe(count("seekers", "setup completed"));
    expect(val("audience:seekers", "signup_funnel_activated")).toBe(count("seekers", "first application"));
    expect(val("audience:employers", "signup_funnel_activated")).toBe(count("employers", "first live job"));
  });

  it("matches funnel steps by stage name, never by position", () => {
    const stages = [
      { stage: "first application", count: 13 }, { stage: "Profile photo added", count: 17 },
      { stage: "OTP verified", count: 61 }, { stage: "accounts created", count: 89 },
    ];
    const out = mapSnapshot(snap({ "signup_funnel.json": env("signup_funnel", { range: RANGE, seekers: { stages } }) }), ctx);
    const got = Object.fromEntries(out.write.observations.map((o) => [o.metric, o.value]));
    expect(got).toEqual({
      signup_funnel_activated: 13, signup_funnel_profile_photo_added: 17, signup_funnel_otp_verified: 61, signup_funnel_accounts_created: 89,
    });
    expect(funnelStep(" Setup Completed ")).toBe("setup_completed");
    expect(funnelStep("first live job")).toBe("activated");
  });
});

describe("mapSnapshot: search and the website", () => {
  const sc = fx("search_console"), scp = fx("search_console.page");
  const q = sc.top.rows.find((x: J) => x.query === "driver jobs near me");

  it("Search Console per Query and per Page (ctr as gsc_ctr_pct), and the totals on Google Search", () => {
    expect(node("query:driver-jobs-near-me")).toMatchObject({ type: "Query", name: "driver jobs near me", props: { text: "driver jobs near me" } });
    expect(obs("query:driver-jobs-near-me", "gsc_clicks")).toMatchObject({ value: q.clicks, windowStart: "2026-09-17", windowEnd: "2026-10-14" });
    expect(val("query:driver-jobs-near-me", "gsc_impressions")).toBe(q.impressions);
    expect(obs("query:driver-jobs-near-me", "gsc_ctr_pct")).toMatchObject({ value: q.ctrPct, unit: "%" });
    expect(obs("query:driver-jobs-near-me", "gsc_ctr")).toBeUndefined();
    expect(val("query:driver-jobs-near-me", "gsc_position")).toBe(q.avgPosition);
    const role = scp.top.rows.find((x: J) => x.page.endsWith("/jobs/example-role"));
    expect(node("page:www.aamdani.ai/jobs/example-role")).toMatchObject({ type: "Page", props: { url: "https://www.aamdani.ai/jobs/example-role", path: "/jobs/example-role" } });
    expect(val("page:www.aamdani.ai/jobs/example-role", "gsc_clicks")).toBe(role.clicks);
    expect(val("page:www.aamdani.ai", "gsc_impressions")).toBe(scp.top.rows.find((x: J) => x.page === "https://www.aamdani.ai/").impressions);
    expect(val("channel:google-search", "gsc_clicks")).toBe(sc.totals.clicks);
    expect(val("channel:google-search", "gsc_impressions")).toBe(sc.totals.impressions);
    expect(val("channel:google-search", "gsc_ctr_pct")).toBe(sc.totals.ctrPct);
    const www = sc.sitemaps.find((m: J) => m.path.startsWith("https://www.")), app = sc.sitemaps.find((m: J) => m.path.startsWith("https://app."));
    expect(val("channel:website", "gsc_sitemap_indexed_urls")).toBe(www.indexedUrls);
    expect(val("channel:web-app", "gsc_sitemap_submitted_urls")).toBe(app.submittedUrls);
  });

  it("pages are PART_OF their site's Channel", () => {
    expect(edges).toContainEqual(expect.objectContaining({ from: "page:www.aamdani.ai/jobs/example-role", type: "PART_OF", to: "channel:website" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "page:app.aamdani.ai/example-page", type: "PART_OF", to: "channel:web-app" }));
  });

  it("GA4 sessions by source fold into channels; users are never summed across source rows", () => {
    const g = fx("analytics_ga4"), gp = fx("analytics_ga4.page");
    const row = (s: string) => g.breakdown.rows.find((x: J) => x.source === s);
    expect(val("channel:google-search", "ga4_sessions")).toBe(row("google / organic").sessions);
    expect(val("channel:google-search", "ga4_active_users")).toBe(row("google / organic").activeUsers); // one row: its users
    expect(val("channel:instagram", "ga4_sessions")).toBe(row("l.instagram.com / referral").sessions + row("instagram / social").sessions);
    expect(obs("channel:instagram", "ga4_active_users")).toBeUndefined(); // two rows: one person can arrive by both
    expect(val("channel:ai-search", "ga4_sessions")).toBe(row("chatgpt.com / referral").sessions);
    expect(val("channel:facebook", "ga4_sessions")).toBe(row("m.facebook.com / referral").sessions);
    expect(val(BIZ, "ga4_sessions_direct")).toBe(row("(direct) / (none)").sessions);
    expect(val(BIZ, "ga4_sessions_other")).toBe(row("bing / organic").sessions);
    expect(val(BIZ, "ga4_sessions")).toBe(g.totals.sessions);
    expect(val(BIZ, "ga4_active_users")).toBe(g.totals.activeUsers);
    expect(obs(BIZ, "ga4_engagement_rate_pct")).toMatchObject({ value: g.totals.engagementRatePct, unit: "%" });
    expect(val("channel:website", "ga4_sessions")).toBe(gp.totals.sessions);
    expect(val("page:www.aamdani.ai", "ga4_page_views")).toBe(gp.breakdown.rows.find((x: J) => x.page === "/").pageViews);
    expect(val("page:www.aamdani.ai/jobs/example-role", "ga4_sessions")).toBe(gp.breakdown.rows.find((x: J) => x.page === "/jobs/example-role").sessions);
  });

  it("RANKS_FOR when a row pairs a page with a query", () => {
    const dir = snap({ "search_console.json": env("search_console", {
      window: { from: "2026-09-17", to: "2026-10-14", days: 28 }, totals: { clicks: 1, impressions: 2 },
      top: { by: "query", rows: [{ query: "electrician job", page: "https://www.aamdani.ai/jobs/electrician", clicks: 1, impressions: 2, ctrPct: 50, avgPosition: 3 }] },
    }) });
    const w = mapSnapshot(dir, ctx).write;
    expect(w.edges).toContainEqual(expect.objectContaining({ from: "page:www.aamdani.ai/jobs/electrician", type: "RANKS_FOR", to: "query:electrician-job" }));
  });
});

describe("mapSnapshot: content and social channels", () => {
  const reel = "content:instagram-17800000000000001";
  const rp = fx("reels_performance");
  const r1 = rp.reels.find((x: J) => x.id === "17800000000000001");

  it("reels are Content PUBLISHED_ON Instagram with their numbers (skip rate as _pct)", () => {
    expect(node(reel)).toMatchObject({ type: "Content", props: {
      platform: "instagram", format: "reel", permalink: "https://www.instagram.com/reel/FAKE0001/", publishedAt: r1.publishedAt,
    } });
    expect(edges).toContainEqual(expect.objectContaining({ from: reel, type: "PUBLISHED_ON", to: "channel:instagram" }));
    expect(val(reel, "reel_views")).toBe(r1.views);
    expect(val(reel, "reel_reach")).toBe(r1.reach);
    expect(val(reel, "reel_avg_watch_s")).toBe(r1.avgWatchS);
    expect(obs(reel, "reel_skip_rate_3s_pct")).toMatchObject({ value: r1.skipPct, unit: "%" });
    expect(val(reel, "reel_shares")).toBe(r1.shares);
    expect(val(reel, "reel_saves")).toBe(r1.saves);
    expect(val("content:instagram-17800000000000009", "reel_views")).toBe(rp.baseline.bestReel.views); // the best reel (baseline)
    expect(val("channel:instagram", "reel_median_views")).toBe(rp.baseline.medianViews);
  });

  it("keeps only the caption's first line, redacted", () => {
    expect(node(reel)?.props?.caption).toBe("Driver ki naukri chahiye? Call [redacted:phone] or mail [redacted:email]");
  });

  it("account reach, followers and their history on the Instagram channel, windows in windowStart/windowEnd", () => {
    const a = fx("account_reach");
    expect(node("channel:instagram")).toMatchObject({ type: "Channel", name: "Instagram", props: { platform: "instagram", handle: "example_business" } });
    expect(obs("channel:instagram", "followers", "2026-10-15")?.value).toBe(a.account.followers);
    expect(obs("channel:instagram", "followers", "2026-10-13")?.value).toBe(a.followerHistory.find((h: J) => h.day === "2026-10-13").followers);
    expect(obs("channel:instagram", "account_reach")).toMatchObject({ value: a.last28d.reach, windowStart: "2026-09-18", windowEnd: "2026-10-15" });
    expect(val("channel:instagram", "account_views")).toBe(a.last28d.views);
    expect(obs("channel:instagram", "non_follower_share_pct")).toMatchObject({ value: Math.round(a.last28d.nonFollowerShare * 1000) / 10, unit: "%" });
    expect(obs("channel:instagram", "new_followers")).toMatchObject({ value: a.newFollowers.last28d.change, windowStart: "2026-09-17", windowEnd: "2026-10-15" });
    for (const m of ["account_reach_28d", "account_reach_7d", "new_followers_28d", "non_follower_share_28d"]) expect(obs("channel:instagram", m), m).toBeUndefined();
  });

  it("published content links each channel's post, and counts failures per channel", () => {
    expect(node("content:instagram-17800000000000005")).toMatchObject({ props: { platform: "instagram", format: "post" } });
    expect(node("content:facebook-990000000000001")).toBeDefined();
    expect(edges).toContainEqual(expect.objectContaining({ from: "content:facebook-990000000000001", type: "PUBLISHED_ON", to: "channel:facebook" }));
    expect(obs("channel:instagram", "posts_published")).toMatchObject({ value: 2, windowStart: "2026-09-18", windowEnd: "2026-10-15" });
    expect(val("channel:youtube", "publish_failures")).toBe(1);
  });

  it("Facebook reels and YouTube", () => {
    const fb = fx("facebook_reels").reels[0], yt = fx("youtube_stats");
    expect(val("content:facebook-990000000000001", "reel_plays")).toBe(fb.plays);
    expect(val("content:facebook-990000000000001", "reel_avg_watch_s")).toBe(fb.avgWatchS);
    expect(val("channel:youtube", "yt_views")).toBe(yt.channel.views);
    expect(val("channel:youtube", "subscribers")).toBe(yt.channel.subscribers);
    expect(node("content:youtube-vid000000a1")).toMatchObject({ props: { platform: "youtube", format: "short", permalink: "https://youtube.com/shorts/vid000000a1" } });
    expect(val("content:youtube-vid000000a1", "yt_views")).toBe(yt.videos[0].views);
    expect(edges).toContainEqual(expect.objectContaining({ from: "content:youtube-vid000000a1", type: "PUBLISHED_ON", to: "channel:youtube" }));
  });

  it("every Channel is PART_OF the Business", () => {
    for (const c of nodes.filter((n) => n.type === "Channel")) {
      expect(edges, c.id).toContainEqual(expect.objectContaining({ from: c.id, type: "PART_OF", to: BIZ }));
    }
  });
});

describe("mapSnapshot: on-call and release signals (Sentry, Play, the App Store)", () => {
  const issueId = (id: string) => `event:sentry-issue-${id.toLowerCase()}`;
  const APP = "channel:app";

  it("every Sentry issue is an Event that AFFECTS the app, with its events and people as dated Observations", () => {
    const se = fx("sentry_issues");
    const hot = node(issueId("APP-7"));
    expect(hot).toMatchObject({ type: "Event", name: "SyntheticCheckoutError: cart is undefined", props: {
      kind: "sentry_issue", level: "fatal", unhandled: true, isNew: true, unresolved: true, firstSeen: "2026-10-10", lastSeen: "2026-10-14",
    } });
    expect(edges).toContainEqual(expect.objectContaining({ from: issueId("APP-7"), type: "AFFECTS", to: APP }));
    expect(obs(issueId("APP-7"), "sentry_issue_events")).toMatchObject({ value: se.topUnresolved[0].eventsInPeriod, windowStart: "2026-10-02", windowEnd: "2026-10-15" });
    expect(val(issueId("APP-7"), "sentry_issue_users")).toBe(se.topUnresolved[0].users);
    // new only, unresolved only, and both
    expect(node(issueId("APP-9"))?.props).toMatchObject({ isNew: true });
    expect(node(issueId("APP-9"))?.props).not.toHaveProperty("unresolved");
    expect(node(issueId("APP-1"))?.props).toMatchObject({ unresolved: true, unhandled: true });
    expect(node(issueId("APP-1"))?.props).not.toHaveProperty("isNew");
    // the issue link names the Sentry org: never kept
    expect(JSON.stringify(nodes.filter((n) => n.id.startsWith("event:sentry-issue")))).not.toMatch(/example\.test|link/);
  });

  it("people who used the app, the daily crash-free series and the latest release", () => {
    const se = fx("sentry_issues");
    expect(obs(APP, "app_users")).toMatchObject({ value: se.stability.users, unit: "count", windowStart: "2026-10-02", windowEnd: "2026-10-15" });
    expect(obs(APP, "crash_free_sessions_daily_pct", "2026-10-12")).toMatchObject({ value: 98.1, windowStart: "2026-10-12", windowEnd: "2026-10-12" });
    expect(val(APP, "app_sessions_daily", "2026-10-12")).toBe(6600);
    expect(observations.filter((o) => o.metric === "crash_free_sessions_daily_pct")).toHaveLength(se.stability.series.length);
    expect(node("event:release-app-1-2-3-45")).toMatchObject({ type: "Event", props: { kind: "release", release: "app@1.2.3+45", project: "app" } });
    expect(edges).toContainEqual(expect.objectContaining({ from: "event:release-app-1-2-3-45", type: "AFFECTS", to: APP }));
  });

  it("Play's bad-behaviour thresholds sit next to the rates they judge", () => {
    expect(val("channel:app-android", "user_perceived_crash_rate_threshold_pct")).toBe(1.09);
    expect(val("channel:app-android", "user_perceived_anr_rate_threshold_pct")).toBe(0.47);
    expect(val("channel:app-android", "user_perceived_anr_rate_pct")).toBe(fx("play_health").anr.last7dUserPerceivedPct);
  });

  const store = (over: Record<string, unknown> = {}) => snap({ "app_store_status.json": env("app_store_status", {
    appId: "123", onSale: "2.4.0", headline: "x",
    versions: [{ version: "2.5.0", state: "WAITING_FOR_REVIEW", platform: "IOS", created: "2026-10-05T10:00:00Z" }, { version: "2.4.0", state: "READY_FOR_SALE", platform: "IOS", created: "2026-09-20T10:00:00Z" }],
    submissions: [{ state: "WAITING_FOR_REVIEW", submitted: "2026-10-09T08:00:00Z", daysSinceSubmitted: 6.2 }],
    latestBuilds: [{ build: "88", processing: "VALID", uploaded: "2026-10-08T12:00:00Z", expired: false }, { build: "87", processing: "VALID", uploaded: "2026-09-20T12:00:00Z", expired: false }],
    ...over,
  }) });

  it("App Store: versions and builds become release Events, and a waiting review is days on the iOS app", () => {
    const m = mapSnapshot(store(), ctx).write;
    const n = (id: string) => m.nodes.find((x) => x.id === id);
    expect(n("event:ios-version-2-5-0")).toMatchObject({ type: "Event", props: { kind: "release", platform: "ios", version: "2.5.0", state: "WAITING_FOR_REVIEW", versionCreated: "2026-10-05" } });
    expect(n("event:ios-version-2-4-0")?.props).toMatchObject({ state: "READY_FOR_SALE", live: true });
    expect(n("event:ios-build-88")).toMatchObject({ type: "Event", props: { kind: "build", platform: "ios", build: "88", processing: "VALID", uploadedAt: "2026-10-08" } });
    expect(m.edges).toContainEqual(expect.objectContaining({ from: "event:ios-build-88", type: "AFFECTS", to: "channel:app-ios" }));
    expect(m.nodes.find((x) => x.id === "channel:app-ios")?.props).toMatchObject({ latestVersion: "2.5.0", latestVersionState: "WAITING_FOR_REVIEW", reviewSubmittedAt: "2026-10-09" });
    expect(m.observations.find((o) => o.subject === "channel:app-ios" && o.metric === "app_review_days_waiting")?.value).toBe(6.2);
  });

  it("App Store: nothing waiting means no days-waiting number, and an unreadable build or version is skipped, not fatal", () => {
    const m = mapSnapshot(store({ submissions: [], versions: [{ version: "2.4.0", state: "READY_FOR_SALE", platform: "IOS", created: "not a date" }, {}], latestBuilds: [{ processing: "VALID" }] }), ctx);
    expect(m.write.observations.some((o) => o.metric === "app_review_days_waiting")).toBe(false);
    expect(m.write.nodes.filter((x) => x.type === "Event").map((x) => x.id)).toEqual(["event:ios-version-2-4-0"]);
    expect(m.skipped).toEqual([]);
  });
});

describe("mapSnapshot: the business and app health", () => {
  it("marketplace, AI features, review queue and app health", () => {
    const m = fx("marketplace"), ai = fx("ai_features"), rc = fx("review_cards"), se = fx("sentry_issues"), ph = fx("posthog_funnels"), pl = fx("play_health");
    expect(obs(BIZ, "applications")).toMatchObject({ value: m.inWindow.applications, windowStart: "2026-09-18", windowEnd: "2026-10-15" });
    expect(val(BIZ, "hires")).toBe(m.inWindow.hires);
    expect(val(BIZ, "live_jobs")).toBe(m.now.liveJobs);
    expect(val(BIZ, "screening_calls")).toBe(ai.screening.calls);
    expect(val(BIZ, "screening_completion_rate_pct")).toBe(ai.screening.completionRatePct);
    expect(val("channel:voice-onboarding", "voice_sessions")).toBe(ai.voiceOnboarding.sessions);
    expect(val("channel:helpline", "helpline_applications")).toBe(ai.helpline.applications);
    expect(val(BIZ, "review_cards_awaiting_approval")).toBe(rc.summary.awaitingApproval);
    expect(val(BIZ, "review_queue_stale")).toBe(rc.allPending.stale);
    expect(obs("channel:app", "crash_free_sessions_pct")).toMatchObject({ value: se.stability.crashFreeSessionsPct, windowStart: "2026-10-02", windowEnd: "2026-10-15" });
    expect(val("channel:app", "app_active_users")).toBe(ph.activeUsers);
    expect(val("audience:seekers", "seeker_signup_funnel_otp_verified")).toBe(ph.funnel.steps.find((s: J) => s.event === "otp_verified").users);
    expect(obs("channel:app-android", "user_perceived_crash_rate_pct")).toMatchObject({
      value: pl.crash.last7dUserPerceivedPct, asOf: "2026-10-13", windowStart: "2026-10-07", windowEnd: "2026-10-13",
    });
  });

  it("COE dashboard numbers, ratios as _pct", () => {
    const metric = (key: string) => fx("admin_metrics").metrics.find((x: J) => x.key === key);
    expect(obs(BIZ, "coe_users_new_seekers")).toMatchObject({ value: metric("users.new_seekers").latest.value, asOf: "2026-10-14" });
    expect(val(BIZ, "coe_market_jobs_live")).toBe(metric("market.jobs_live").latest.value);
    expect(obs(BIZ, "coe_health_screening_failure_rate_pct")).toMatchObject({
      value: Math.round(metric("health.screening_failure_rate").latest.value * 1000) / 10, unit: "%",
    });
    expect(obs(BIZ, "coe_health_refresh_ok")).toBeUndefined(); // no reading in the window
  });

  it("an hours suffix is an age threshold when the label says so, else a window; never left as a bare _48h", () => {
    const m = (key: string, label: string) => ({ key, label, category: "health", unit: "count", tabs: ["overview"], latest: { day: "2026-10-14", value: 3 } });
    const dir = snap({ "admin_metrics.json": env("admin_metrics", { metrics: [
      m("health.verifications_pending_48h", "Verifications pending >48h"),
      m("agents.calls_48h", "Calls in the last 48 hours"),
    ] }) });
    const out = mapSnapshot(dir, ctx).write.observations;
    expect(out.map((o) => o.metric).sort()).toEqual(["coe_agents_calls", "coe_health_verifications_pending_over_48h"]);
    expect(out.find((o) => o.metric === "coe_health_verifications_pending_over_48h")).not.toHaveProperty("windowStart");
    expect(out.find((o) => o.metric === "coe_agents_calls")).toMatchObject({ windowStart: "2026-10-13", windowEnd: "2026-10-14" });
  });
});

describe("finance stays out", () => {
  const FINANCE = /money|mrr|revenue|subscription|price|(^|_)plans?(_|$)|payment|paid|(^|_)inr(_|$)|currency/i;

  it("no money, revenue, subscription, plan or price metric is emitted from the fixture (which has two)", () => {
    expect(fx("admin_metrics").metrics.filter((x: J) => x.category === "money")).toHaveLength(2);
    for (const o of observations) expect(o.metric, o.metric).not.toMatch(FINANCE);
  });

  it("admin_metrics drops a metric whose category, tab, key, label or unit is about money", () => {
    const m = (key: string, extra: J = {}) => ({ key, label: key, category: "users", unit: "count", tabs: ["overview"], latest: { day: "2026-10-14", value: 7 }, ...extra });
    const dir = snap({ "admin_metrics.json": env("admin_metrics", { metrics: [
      m("money.active_subs", { category: "money" }),
      m("users.paying_seekers", { tabs: ["overview", "money"] }),
      m("market.featured_plan_buyers"),
      m("users.top_up", { label: "Revenue from top-ups" }),
      m("market.boost_value", { unit: "inr" }),
      m("users.new_seekers"),
      m("users.engaged_seekers_7d"),
    ] }) });
    const out = mapSnapshot(dir, ctx).write.observations;
    expect(out.map((o) => o.metric).sort()).toEqual(["coe_users_engaged_seekers", "coe_users_new_seekers"]);
    // The window in the key moves to windowStart/windowEnd.
    expect(out.find((o) => o.metric === "coe_users_engaged_seekers")).toMatchObject({ windowStart: "2026-10-08", windowEnd: "2026-10-14", asOf: "2026-10-14" });
  });

  it("a money.json in an older snapshot is not even read: no Document, no observation", () => {
    const dir = snap({
      "money.json": env("money", { revenue: { collectedMrrInrPerMonth: 4321 }, planPrices: [{ plan: "x", inr: 99 }] }),
      "marketplace.json": env("marketplace", { range: RANGE, inWindow: { hires: 31 } }),
    });
    const out = mapSnapshot(dir, ctx);
    expect(out.skipped).toContainEqual({ ref: "money.json", reason: "no mapper for tool money" });
    expect(out.write.nodes.map((n) => n.id)).not.toContain(doc("money"));
    expect(JSON.stringify(out.write)).not.toMatch(/4321|money/);
  });
});

describe("mapSnapshot: systems and the work queue", () => {
  it("connectors become Systems (registry id format) with name and status only, and channels DEPEND_ON theirs", () => {
    expect(node("system:instagram")).toEqual(expect.objectContaining({ type: "System", name: "instagram", props: { kind: "connector", status: "ok" } }));
    expect(node("system:sentry")?.props).toEqual({ kind: "connector", status: "error" });
    expect(node("system:vercel")?.props).toEqual({ kind: "connector", status: "not_configured" });
    expect(node("system:search-console")?.name).toBe("search_console");
    expect(edges).toContainEqual(expect.objectContaining({ from: "channel:instagram", type: "DEPENDS_ON", to: "system:instagram" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "channel:google-search", type: "DEPENDS_ON", to: "system:search-console" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "channel:app-android", type: "DEPENDS_ON", to: "system:play" }));
  });

  it("PENDING items become no Tasks (the vault source owns them): only open counts by owner, on the Business", () => {
    expect(nodes.filter((n) => n.type === "Task")).toEqual([]);
    // Fixture: 2 founder + 2 agent + 1 other open; 2 under sensitive headings (server access, credentials); 1 done.
    expect(obs(BIZ, "pending_open_items")).toMatchObject({ value: 5, unit: "count", src: doc("brain-pending") });
    expect(val(BIZ, "pending_open_items_founder")).toBe(2);
    expect(val(BIZ, "pending_open_items_agent")).toBe(2);
    expect(val(BIZ, "pending_open_items_other")).toBe(1);
    expect(observations.filter((o) => o.src === doc("brain-pending")).every((o) => o.subject === BIZ)).toBe(true);
    expect(r.redactions.sensitive_section_item).toBe(2);
    const all = JSON.stringify(r.write);
    for (const s of ["Renew the store listing", "Rotate the deploy key", "Swap the bot token", "Founder queue", "Z1", "Asha"]) expect(all, s).not.toContain(s);
  });
});

describe("privacy", () => {
  const all = JSON.stringify(r);

  it("no planted personal data or infrastructure detail reaches the write", () => {
    for (const s of ["98765", "hr@example.com", "ops@example.com", "u-planted-should-drop", "192.0.2.12", "1234567890", "second line stays out", "reader_role_x", "synthetic fixture for"]) {
      expect(all, s).not.toContain(s);
    }
    expect(r.redactions.email).toBeGreaterThanOrEqual(1);
    expect(r.redactions.phone).toBeGreaterThanOrEqual(1);
    expect(r.redactions.personal_field).toBeGreaterThanOrEqual(1);
  });

  // The redaction rules themselves (every kind, and what must stay untouched) are tested once, in redact.test.ts. Here: the
  // mapper sends free text through that engine, and the counts it reports use the engine's kind names.
  it("free text goes through redact(): secret paths, addresses, credentials and company ids become placeholders, and are counted", () => {
    const caption = "copy ~/Documents/acme-secrets/x.txt to 198.51.100.7 with FOO_TOKEN=abc123 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 for Team ID ABCDE12345 now";
    const out = mapSnapshot(snap({ "reels_performance.json": env("reels_performance", { reels: [{ id: "17800000000000042", caption }] }) }), ctx);
    expect(out.write.nodes.find((n) => n.id === "content:instagram-17800000000000042")?.props?.caption).toBe(
      "copy [redacted:secret-path] to [redacted:ipv4] with FOO_TOKEN=[redacted:secret] and [redacted:secret] for Team ID [redacted:apple-team-id] now");
    expect(out.redactions).toEqual({ "secret-path": 1, ipv4: 1, secret: 2, "apple-team-id": 1 });
    expect(JSON.stringify(out.write)).not.toMatch(/acme-secrets|198\.51\.100|abc123|ghp_|ABCDE12345/);
  });

  it("stripPersonalFields drops personal keys but keeps counts named after them", () => {
    const { value, dropped } = stripPersonalFields({
      a: { phone: "+91 98765 43210", email: "x@y.z", user_id: 7, reviewerName: "A", phoneVerified: 1100, nested: [{ candidate_id: "c1", ok: 1 }] },
    });
    expect(value).toEqual({ a: { phoneVerified: 1100, nested: [{ ok: 1 }] } });
    expect(dropped).toBe(5);
  });
});
