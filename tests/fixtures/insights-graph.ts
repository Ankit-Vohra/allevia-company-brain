// seedMini plus what the insight detectors, the brief and the action layer need and seedMini does not have: a signup
// funnel, an unindexed page, sitemap numbers, a low-CTR query (in the real ingest's gsc_* metric names), a simulated
// campaign whose CTR halves in its last week, a decision with no evidence, old Instagram stories (a weak format), two
// Goals with baselines (one on track, one at risk) and a Day-0 baseline Observation. All synthetic.
// Planted stories, for the tests to find:
//   seo      /jobs fails a high-severity rule; the home page has 5,000 impressions at 0.4% CTR; "jobs in raipur" has
//            4,000 impressions and 12 clicks; /employers is not indexed; the sitemap has 40 of 112 URLs indexed, 3 errors
//   content  the curiosity-gap hook runs at 4.8× the median reel; the numbered-list hook at 0.7×; stories get 0.06× the
//            views of reels; Instagram's last post was 26 Sep (19 days before SEED_NOW); a YouTube short with no hook
//            on record did 4× the median short
//   funnel   seekers: 1,000 created, 820 OTP verified, 410 set up, 300 activated: the biggest drop is OTP -> setup (50%)
//   ads      Employers CPA ₹300 against a ₹150 median (2×); Carousel CTR 2% -> 1% week on week
//   knowledge 2 orphan docs (the two playbook files); 2 stale tasks; decision 009 has no evidence
import type { GraphHandle } from "../../src/graph/client.js";
import { addObservation, upsertEdge, upsertNode, type ObservationInput } from "../../src/graph/upsert.js";
import { D, seedMini } from "./seed-graph.js";

export { D, SEED_NOW } from "./seed-graph.js";

export async function seedInsights(g: GraphHandle): Promise<void> {
  await seedMini(g);
  const t0 = D("2026-10-01");
  const obs = (o: ObservationInput) => addObservation(g, o, D(o.asOf));
  const doc = async (id: string, name: string, kind: string, asOf: string, simulated?: boolean) =>
    upsertNode(g, { type: "Document", id, name, props: { kind, title: name }, asOf, ...(simulated ? { simulated } : {}) }, t0);

  await doc("document:ops-oct", "App funnel export, Oct 2026", "snapshot", "2026-10-14");
  await doc("document:gsc-sitemaps", "Search Console sitemaps, Oct 2026", "snapshot", "2026-10-14");

  // ---- funnel (signup_funnel_<step> on the seekers audience, one window) ----
  const funnel: Array<[string, number]> = [["accounts_created", 1000], ["otp_verified", 820], ["setup_completed", 410], ["activated", 300]];
  for (const [step, value] of funnel) {
    await obs({ subject: "audience:job-seekers", metric: `signup_funnel_${step}`, value, unit: "users",
      windowStart: "2026-09-15", windowEnd: "2026-10-14", asOf: "2026-10-14", src: "document:ops-oct" });
  }

  // ---- SEO: an unindexed page, sitemap coverage and errors, a low-CTR query in gsc_* names ----
  await upsertNode(g, { type: "Page", id: "page:www.aamdani.ai/employers", name: "Hire staff in Raipur",
    props: { url: "https://www.aamdani.ai/employers", path: "/employers", title: "Hire staff in Raipur", indexed: false, indexStatus: "Crawled - currently not indexed" },
    src: "document:gsc-sitemaps", asOf: "2026-10-14" }, t0);
  await upsertEdge(g, { from: "page:www.aamdani.ai/employers", type: "PART_OF", to: "channel:website" }, t0);
  for (const [metric, value] of [["gsc_sitemap_submitted_urls", 112], ["gsc_sitemap_indexed_urls", 40], ["gsc_sitemap_errors", 3]] as const) {
    await obs({ subject: "channel:website", metric, value, unit: "count", asOf: "2026-10-14", src: "document:gsc-sitemaps" });
  }
  for (const [metric, value] of [["gsc_impressions", 4000], ["gsc_clicks", 12], ["gsc_position", 18.4]] as const) {
    await obs({ subject: "query:jobs-in-raipur", metric, value, windowStart: "2026-09-12", windowEnd: "2026-10-09", asOf: "2026-10-10", src: "document:gsc-oct" });
  }

  // ---- content: three old Instagram stories (a weak format next to reels) ----
  const stories: Array<[string, string, string, number]> = [
    ["content:story-raipur-jobs-1", "Story: 5 new jobs today", "2026-09-01", 300],
    ["content:story-raipur-jobs-2", "Story: walk-in interviews", "2026-09-02", 400],
    ["content:story-raipur-jobs-3", "Story: salary poll", "2026-09-03", 350],
  ];
  for (const [id, name, publishedAt, views] of stories) {
    await upsertNode(g, { type: "Content", id, name, props: { format: "story", publishedAt }, src: "document:ig-insights-sep", asOf: "2026-09-30" }, t0);
    await upsertEdge(g, { from: id, type: "PUBLISHED_ON", to: "channel:instagram" }, t0);
    await obs({ subject: id, metric: "views", value: views, unit: "count", windowEnd: "2026-09-30", asOf: "2026-09-30", src: "document:ig-insights-sep" });
  }

  // ---- content: three recent YouTube shorts with no hook recorded, one of them at 4× the median (yt_views, as ingested) ----
  await upsertNode(g, { type: "Channel", id: "channel:youtube", name: "YouTube", props: { platform: "youtube", status: "active" } }, t0);
  const shorts: Array<[string, string, string, number]> = [
    ["content:short-office-tour", "Short: a day at a Raipur office job", "2026-10-10", 500],
    ["content:short-first-salary", "Short: what I did with my first salary", "2026-10-11", 2400],
    ["content:short-interview-tips", "Short: two interview tips", "2026-10-12", 600],
  ];
  for (const [id, name, publishedAt, views] of shorts) {
    await upsertNode(g, { type: "Content", id, name, props: { format: "short", platform: "youtube", publishedAt }, src: "document:ig-insights-oct", asOf: "2026-10-13" }, t0);
    await upsertEdge(g, { from: id, type: "PUBLISHED_ON", to: "channel:youtube" }, t0);
    await obs({ subject: id, metric: "yt_views", value: views, unit: "count", asOf: "2026-10-13", src: "document:ig-insights-oct" });
  }

  // ---- ads: a fourth simulated campaign, 14 days, CPA at the median, CTR halves in the last 7 days ----
  await upsertNode(g, { type: "Campaign", id: "campaign:meta-carousel", name: "Seekers: carousel", props: { status: "active", objective: "leads" },
    simulated: true, src: "document:meta-ads-sim", asOf: "2026-10-13" }, t0);
  await upsertEdge(g, { from: "campaign:meta-carousel", type: "PUBLISHED_ON", to: "channel:meta-ads" }, t0);
  for (let i = 0; i < 14; i++) {
    const day = new Date(D("2026-09-30") + i * 86_400_000).toISOString().slice(0, 10);
    const ctr = i < 7 ? 0.02 : 0.01;
    const base = { subject: "campaign:meta-carousel", windowStart: day, windowEnd: day, asOf: day, src: "document:meta-ads-sim", simulated: true };
    await obs({ ...base, metric: "spend", value: 600, unit: "INR" });
    await obs({ ...base, metric: "conversions", value: 4, unit: "count" });
    await obs({ ...base, metric: "impressions", value: 10000, unit: "count" });
    await obs({ ...base, metric: "clicks", value: 10000 * ctr, unit: "count" });
  }

  // ---- knowledge: an accepted decision with no evidence ----
  await doc("document:adr-009", "ADR 009: Answer seekers on WhatsApp", "decision", "2026-10-05");
  await upsertNode(g, { type: "Decision", id: "decision:009-whatsapp-replies", name: "Answer seekers on WhatsApp",
    props: { status: "accepted", decidedAt: "2026-10-05" }, src: "document:adr-009", asOf: "2026-10-05" }, t0);
  await upsertEdge(g, { from: "decision:009-whatsapp-replies", type: "SOURCED_FROM", to: "document:adr-009" }, t0);

  // ---- goals: signups a day (on track), Instagram followers (at risk), with a Day-0 baseline Observation ----
  await upsertNode(g, { type: "Goal", id: "goal:signups-per-day", name: "Signups a day",
    props: { metricKey: "signups", baseline: 5, target: 20, unit: "count", period: "day", startAt: "2026-10-01", dueAt: "2027-01-13", priority: 1, status: "on_track" } }, t0);
  await upsertNode(g, { type: "Goal", id: "goal:instagram-followers", name: "Instagram followers",
    props: { metricKey: "followers", target: 5000, unit: "count", startAt: "2026-09-07", dueAt: "2026-12-31", priority: 2, status: "on_track" } }, t0);
  for (const id of ["goal:signups-per-day", "goal:instagram-followers"]) await upsertEdge(g, { from: "business:aamdani", type: "PURSUES", to: id }, t0);
  await upsertNode(g, { type: "Observation", id: "obs:followers:goal:instagram-followers:baseline", name: "followers baseline (Day 0)",
    props: { metric: "followers", value: 1000, unit: "count", baseline: true, subject: "goal:instagram-followers", windowEnd: "2026-09-07" },
    src: "document:ig-insights-sep", asOf: "2026-09-07" }, t0);
  await upsertEdge(g, { from: "obs:followers:goal:instagram-followers:baseline", type: "MEASURES", to: "goal:instagram-followers" }, t0);
}
