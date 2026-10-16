// The Google products Allevia connects, in owner's words, and the daily reads of the two that feed numbers (Analytics, Ads).
// Search Console is its own connector (search-console.ts) because it was built first and keeps its own sealed record and
// website choice. Permissions per product: Calendar free/busy + events, Gmail send (+ read the inbox only when the owner opts
// in), Analytics read-only, Ads read-only. docs/connections-setup.md lists which of them Google must verify.
import { settleGoals } from "../../program/late.js";
import { syncCapabilities } from "../../capabilities/ladder.js";
import { upsertNode, writeBatch, type NodeInput, type ObservationInput } from "../../graph/upsert.js";
import { addDays } from "../../insights/text.js";
import { isoDate } from "../../util/time.js";
import type { ConnectorCtx } from "../types.js";
import { GoogleProductConnector, type GoogleProductDeps, type GoogleSession, type ProductSpec } from "./product.js";
import { SCOPES } from "./oauth.js";

export const WEBSITE_CHANNEL = "channel:website";
export const GOOGLE_ADS_CHANNEL = "channel:google-ads";

const calendar: ProductSpec = {
  info: {
    id: "google-calendar", name: "Google Calendar", group: "google", provider: "google",
    blurb: "Your team sees when you're free and books calls with your clients on your calendar, after your OK.",
    reads: ["When you are busy or free. Not what your meetings are about."],
    acts: ["Adds a meeting to your calendar, only after you say OK."],
    capabilities: ["calendar"],
  },
  system: { id: "system:google-calendar", name: "Google Calendar" },
  scopes: () => [SCOPES.calendarBusy, SCOPES.calendarEvents],
  required: [SCOPES.calendarBusy],
};

const gmail: ProductSpec = {
  info: {
    id: "gmail", name: "Gmail", group: "google", provider: "google",
    blurb: "Your team drafts follow-ups to your leads and sends them from your address, after your OK.",
    reads: ["Nothing from your inbox, unless you choose to allow it."],
    acts: ["Sends an email from your address, only after you say OK."],
    capabilities: ["email"],
  },
  system: { id: "system:gmail", name: "Gmail" },
  scopes: (o) => [SCOPES.gmailSend, ...(o.inbox === "1" ? [SCOPES.gmailRead] : [])],
  required: [SCOPES.gmailSend],
  extras: (s) => (s === SCOPES.gmailRead ? ["Your team can read your inbox"] : []),
};

function ga4Day(d: string): string | null {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

async function pullGa4(_deps: GoogleProductDeps, ctx: ConnectorCtx, s: GoogleSession): Promise<{ ok: boolean; message: string }> {
  const property = s.meta.selected;
  if (!property) return { ok: false, message: "Pick which analytics property to read first." };
  const now = ctx.now();
  const today = isoDate(now);
  const end = addDays(today, -1);
  const start = addDays(end, -27);
  const rows = await s.apis.ga4Report(s.accessToken, property, { startDate: start, endDate: end, dimensions: ["date"], metrics: ["sessions", "activeUsers", "keyEvents"], limit: 100 });
  const docId = `document:ga4-pull-${today}`;
  const g = await ctx.graph();
  const haveChannel = (await g.roQuery<{ id: string }>("MATCH (c:Entity:Channel {id:$id}) RETURN c.id AS id", { id: WEBSITE_CHANNEL })).length > 0;
  const nodes: NodeInput[] = [
    ...(haveChannel ? [] : [{ type: "Channel" as const, id: WEBSITE_CHANNEL, name: "Website" }]),
    { type: "Document", id: docId, name: `Analytics numbers read on ${today}`, summary: `Sessions, visitors and key events for ${s.meta.selectedLabel ?? property}, ${start} to ${end}.`, props: { kind: "snapshot", provider: "ga4", property }, asOf: today },
  ];
  const observations: ObservationInput[] = [];
  for (const r of rows) {
    const d = ga4Day(r.dimensions[0] ?? "");
    if (!d) continue;
    const w = { windowStart: d, windowEnd: d, asOf: today, src: docId };
    observations.push(
      { subject: WEBSITE_CHANNEL, metric: "ga4_sessions", value: r.metrics[0] ?? 0, unit: "count", ...w },
      { subject: WEBSITE_CHANNEL, metric: "ga4_users", value: r.metrics[1] ?? 0, unit: "count", ...w },
      { subject: WEBSITE_CHANNEL, metric: "ga4_conversions", value: r.metrics[2] ?? 0, unit: "count", ...w },
    );
  }
  const stats = await writeBatch(g, { nodes, observations }, now);
  if (stats.errors.length) throw new Error(`ga4: ${stats.errors[0]!.error}`);
  await finish(ctx, "system:ga4", "Google Analytics", end);
  return { ok: true, message: `Read ${rows.length} days of Analytics up to ${end}.` };
}

async function pullAds(_deps: GoogleProductDeps, ctx: ConnectorCtx, s: GoogleSession): Promise<{ ok: boolean; message: string }> {
  const customer = s.meta.selected;
  if (!customer) return { ok: false, message: "Pick which ads account to read first." };
  const now = ctx.now();
  const today = isoDate(now);
  const end = addDays(today, -1);
  const start = addDays(end, -27);
  const camps = await s.apis.adsCampaigns(s.accessToken, customer, { startDate: start, endDate: end });
  const sum = (f: (c: (typeof camps)[number]) => number) => camps.reduce((a, c) => a + f(c), 0);
  const docId = `document:ads-pull-${today}`;
  const g = await ctx.graph();
  const haveChannel = (await g.roQuery<{ id: string }>("MATCH (c:Entity:Channel {id:$id}) RETURN c.id AS id", { id: GOOGLE_ADS_CHANNEL })).length > 0;
  const nodes: NodeInput[] = [
    ...(haveChannel ? [] : [{ type: "Channel" as const, id: GOOGLE_ADS_CHANNEL, name: "Google Ads" }]),
    { type: "Document", id: docId, name: `Google Ads numbers read on ${today}`, summary: `Spend, clicks and conversions across ${camps.length} campaigns, ${start} to ${end}.`, props: { kind: "snapshot", provider: "google-ads" }, asOf: today },
  ];
  const w = { windowStart: start, windowEnd: end, asOf: today, src: docId };
  const observations: ObservationInput[] = [
    { subject: GOOGLE_ADS_CHANNEL, metric: "ads_spend", value: Math.round(sum((c) => c.costMicros) / 10_000) / 100, unit: "currency", ...w },
    { subject: GOOGLE_ADS_CHANNEL, metric: "ads_clicks", value: sum((c) => c.clicks), unit: "count", ...w },
    { subject: GOOGLE_ADS_CHANNEL, metric: "ads_impressions", value: sum((c) => c.impressions), unit: "count", ...w },
    { subject: GOOGLE_ADS_CHANNEL, metric: "ads_conversions", value: Math.round(sum((c) => c.conversions) * 100) / 100, unit: "count", ...w },
  ];
  const stats = await writeBatch(g, { nodes, observations }, now);
  if (stats.errors.length) throw new Error(`ads: ${stats.errors[0]!.error}`);
  await finish(ctx, "system:google-ads", "Google Ads", end);
  return { ok: true, message: `Read ${camps.length} campaigns up to ${end}.` };
}

async function finish(ctx: ConnectorCtx, systemId: string, name: string, through: string): Promise<void> {
  const g = await ctx.graph();
  const now = ctx.now();
  await upsertNode(g, { type: "System", id: systemId, name, props: { kind: "connector", provider: "google", status: "ok", lastPullAt: now, dataThrough: through, lastError: null } }, now);
  try {
    await settleGoals(g, { now, ...(ctx.businessId ? { businessId: ctx.businessId } : {}) });
    await syncCapabilities(g, { now, ...(ctx.businessId ? { businessId: ctx.businessId } : {}) });
  } catch {
    // the numbers are in; the goals and the ladder catch up on the next read of the plan
  }
}

const analytics: ProductSpec = {
  info: {
    id: "google-analytics", name: "Google Analytics", group: "google", provider: "google",
    blurb: "Your team reads your website visits, where they come from and what they do, every morning.",
    reads: ["Visits, where they come from, and sign-ups or enquiries counted on your site."],
    acts: [],
    capabilities: ["ga4"],
  },
  system: { id: "system:ga4", name: "Google Analytics" },
  scopes: () => [SCOPES.analytics],
  required: [SCOPES.analytics],
  needsPickToRun: true,
  pickWords: "Pick which website's numbers to read.",
  discover: async (apis, token) => {
    const props = await apis.ga4Properties(token);
    return { key: "property", label: "Which website's analytics should we read?", choices: props.map((p) => ({ value: p.property, label: `${p.displayName} (${p.property.replace("properties/", "")})` })) };
  },
  daily: pullGa4,
};

const ads: ProductSpec = {
  info: {
    id: "google-ads", name: "Google Ads", group: "google", provider: "google",
    blurb: "Your team reads your ad spend, clicks and enquiries so it can say where your money works and where it leaks.",
    reads: ["Campaigns, what you spent, clicks and enquiries."],
    acts: [],
    capabilities: ["ads"],
  },
  system: { id: "system:google-ads", name: "Google Ads" },
  scopes: () => [SCOPES.ads],
  required: [SCOPES.ads],
  ads: true,
  needsPickToRun: true,
  pickWords: "Pick which ads account to read.",
  discover: async (apis, token) => {
    const cs = await apis.adsCustomers(token);
    return { key: "customer", label: "Which ads account should we read?", choices: cs.map((c) => ({ value: c.id, label: `Ads account ${c.id}` })) };
  },
  daily: pullAds,
};

export const PRODUCT_SPECS: ProductSpec[] = [calendar, gmail, analytics, ads];

export function googleProductConnectors(deps: GoogleProductDeps): GoogleProductConnector[] {
  return PRODUCT_SPECS.map((s) => new GoogleProductConnector(s, deps));
}
