// The first read: when a business connects a tool, its first numbers are read straight away so day one has something real
// ("Google Analytics connected: 3,412 visits last week"), and the same read is repeated every day. Each reader makes one or two
// read-only calls through the connection, returns one plain line (the headline the owner sees), and where the numbers are a
// kind the brain already uses (search clicks, followers) writes them as Observations with their source and date.
// Every read is a node: a snapshot Document with its headline, PRODUCED by the connection's System (src/connections/graph.ts), and
// the System keeps when it last read and how many facts that was. Calendar, Gmail, Stripe and Shopify have no series the brain
// uses yet, so the number each one computes (meetings this week, a balance, orders, emails) is an Observation that MEASURES the
// System itself.
// Response shapes are read defensively (a missing field means no headline, never an error), because they have only been
// checked against Composio's published schemas, not against a live account (docs/connections-setup.md).
import type { NodeInput, ObservationInput } from "../graph/upsert.js";
import { addDays } from "../insights/text.js";
import { isoDate } from "../util/time.js";
import { recordRead, type ConnRef } from "./graph.js";
import type { ConnectorCtx } from "./types.js";

type Execute = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

const find = (v: unknown, keys: string[], depth = 0): unknown => {
  if (!v || typeof v !== "object" || depth > 6) return undefined;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  for (const x of Object.values(o)) { const r = find(x, keys, depth + 1); if (r !== undefined) return r; }
  return undefined;
};
const list = (v: unknown, keys: string[]): unknown[] => { const r = find(v, keys); return Array.isArray(r) ? r : []; };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const fmt = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`;

/** A read-only call to the provider's own API through the connection (Composio's proxy): for toolkits with no action for the read. */
export type Proxy = (req: { endpoint: string; method: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string> }) => Promise<unknown>;

/** `property`: the Analytics property the read used, kept with the connection so the agents' live reports read the same one. */
export interface FirstRead { headline?: string; property?: string }
export type Reader = (execute: Execute, ctx: ConnectorCtx, proxy?: Proxy) => Promise<FirstRead>;

const SRC_PREFIX = "document:first-read-";

/** The snapshot Document every reader writes: one per read, named by the day, with the one line the owner sees. */
function snapshot(provider: string, today: string, name: string, headline: string, summary: string, props: Record<string, string | number> = {}): NodeInput & { type: "Document" } {
  return { type: "Document", id: `${SRC_PREFIX}${provider}-${today}`, name, summary, props: { kind: "snapshot", provider, headline, ...props }, asOf: today };
}

async function channelNode(ctx: ConnectorCtx, id: string, name: string): Promise<NodeInput[]> {
  const g = await ctx.graph();
  const have = (await g.roQuery<{ id: string }>("MATCH (c:Entity:Channel {id:$id}) RETURN c.id AS id", { id })).length > 0;
  return have ? [] : [{ type: "Channel", id, name }];
}

const searchConsole = (ref: ConnRef): Reader => async (execute, ctx) => {
  const sites = list(await execute("GOOGLE_SEARCH_CONSOLE_LIST_SITES", {}), ["siteEntry", "sites"]).map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {})).filter((s) => typeof s.siteUrl === "string" && s.permissionLevel !== "siteUnverifiedUser");
  const site = (sites.find((s) => String(s.siteUrl).startsWith("sc-domain:")) ?? sites[0])?.siteUrl;
  if (typeof site !== "string") return {};
  const today = isoDate(ctx.now());
  const end = addDays(today, -3), start = addDays(end, -27);
  const rows = list(await execute("GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", { site_url: site, start_date: start, end_date: end, dimensions: ["date"], row_limit: 40 }), ["rows"]);
  const days = rows.flatMap((r) => { const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>; const d = Array.isArray(o.keys) ? String(o.keys[0]) : ""; return /^\d{4}-\d{2}-\d{2}$/.test(d) ? [{ d, clicks: num(o.clicks) ?? 0, impressions: num(o.impressions) ?? 0 }] : []; });
  if (!days.length) return {};
  const channel = "channel:google-search";
  const clicks = days.reduce((a, x) => a + x.clicks, 0);
  const headline = `${plural(clicks, "click", "clicks")} from Google searches in the last 28 days`;
  const doc = snapshot("search-console", today, `Search Console numbers read on ${today}`, headline, `Clicks and impressions for ${site}, ${start} to ${end}.`, { property: site });
  const observations: ObservationInput[] = days.flatMap((x) => [
    { subject: channel, metric: "gsc_clicks", value: x.clicks, unit: "count", windowStart: x.d, windowEnd: x.d, asOf: today, src: doc.id },
    { subject: channel, metric: "gsc_impressions", value: x.impressions, unit: "count", windowStart: x.d, windowEnd: x.d, asOf: today, src: doc.id },
  ]);
  const done = await recordRead(ctx, ref, { doc, nodes: await channelNode(ctx, channel, "Google Search"), observations, dataThrough: end, props: { property: site } });
  return done.ok ? { headline } : {};
};

// Google Analytics: Composio's toolkit has no report action, so both calls go to Google's own API through the proxy. The property
// is the one whose name or website matches the business's domain, else the first one the account can see.
const GA4_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const GA4_DATA = "https://analyticsdata.googleapis.com/v1beta";
const WEBSITE = "channel:website";
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const ga4Date = (d: string): string | null => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);
const bare = (d: string): string => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

async function businessDomain(ctx: ConnectorCtx): Promise<string> {
  try {
    const g = await ctx.graph();
    const rows = ctx.businessId
      ? await g.roQuery<{ domain: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.domain AS domain", { id: ctx.businessId })
      : await g.roQuery<{ domain: string | null }>("MATCH (b:Entity:Business) WHERE b.domain IS NOT NULL RETURN b.domain AS domain LIMIT 1", {});
    return bare(rows[0]?.domain ?? "");
  } catch {
    return "";
  }
}

export async function pickGa4Property(proxy: Proxy, ctx: ConnectorCtx): Promise<{ property: string; name: string } | null> {
  const props = list(await proxy({ endpoint: `${GA4_ADMIN}/accountSummaries`, method: "GET", query: { pageSize: "200" } }), ["accountSummaries"])
    .flatMap((a) => list(a, ["propertySummaries"]))
    .map(rec).filter((p) => typeof p.property === "string" && /^properties\/\d+$/.test(p.property))
    .map((p) => ({ property: String(p.property), name: typeof p.displayName === "string" ? p.displayName : String(p.property) }));
  if (props.length <= 1) return props[0] ?? null;
  const domain = await businessDomain(ctx);
  if (!domain) return props[0]!;
  const stem = domain.split(".")[0] ?? domain;
  const byName = props.find((p) => p.name.toLowerCase().includes(domain)) ?? props.find((p) => stem.length > 2 && p.name.toLowerCase().includes(stem));
  if (byName) return byName;
  for (const p of props.slice(0, 5)) { // the website each property measures, for the few the account has
    const streams = list(await proxy({ endpoint: `${GA4_ADMIN}/${p.property}/dataStreams`, method: "GET" }).catch(() => null), ["dataStreams"]);
    if (streams.some((st) => bare(String(rec(rec(st).webStreamData).defaultUri ?? "")) === domain)) return p;
  }
  return props[0]!;
}

const analytics = (ref: ConnRef): Reader => async (_execute, ctx, proxy) => {
  if (!proxy) return {};
  const picked = await pickGa4Property(proxy, ctx);
  if (!picked) return {};
  const today = isoDate(ctx.now());
  const end = addDays(today, -1), start = addDays(end, -27);
  const report = (body: Record<string, unknown>) => proxy({ endpoint: `${GA4_DATA}/${picked.property}:runReport`, method: "POST", body: { dateRanges: [{ startDate: start, endDate: end }], keepEmptyRows: false, ...body } });
  const cells = (row: unknown) => {
    const r = rec(row);
    return { dims: (Array.isArray(r.dimensionValues) ? r.dimensionValues : []).map((d) => String(rec(d).value ?? "")), vals: (Array.isArray(r.metricValues) ? r.metricValues : []).map((m) => num(rec(m).value) ?? 0) };
  };
  const daily = list(await report({ dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "newUsers" }, { name: "keyEvents" }], limit: 100 }), ["rows"])
    .flatMap((row) => { const c = cells(row); const d = ga4Date(c.dims[0] ?? ""); return d ? [{ d, sessions: c.vals[0] ?? 0, users: c.vals[1] ?? 0, newUsers: c.vals[2] ?? 0, keyEvents: c.vals[3] ?? 0 }] : []; });
  if (!daily.length) return {};
  const groups = list(await report({ dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }], limit: 25 }).catch(() => null), ["rows"])
    .flatMap((row) => { const c = cells(row); const name = c.dims[0] ?? ""; return name && slugOf(name) ? [{ name, slug: slugOf(name), sessions: c.vals[0] ?? 0 }] : []; });
  const sessions = daily.reduce((a, x) => a + x.sessions, 0);
  const headline = `${plural(sessions, "visit", "visits")} to your website in the last 28 days`;
  const top = groups.slice().sort((a, b) => b.sessions - a.sessions).slice(0, 3).map((g) => `${g.name} ${fmt(g.sessions)}`).join(", ");
  const doc = snapshot("ga4", today, `Analytics numbers read on ${today}`, headline, `Visits, visitors, new visitors and key events for ${picked.name} (${picked.property}), ${start} to ${end}.${top ? ` Where visits came from: ${top}.` : ""}`, { property: picked.property });
  const w = (d: string) => ({ windowStart: d, windowEnd: d, asOf: today, src: doc.id });
  const observations: ObservationInput[] = [
    ...daily.flatMap((x) => [
      { subject: WEBSITE, metric: "ga4_sessions", value: x.sessions, unit: "count", ...w(x.d) },
      { subject: WEBSITE, metric: "ga4_users", value: x.users, unit: "count", ...w(x.d) },
      { subject: WEBSITE, metric: "ga4_new_users", value: x.newUsers, unit: "count", ...w(x.d) },
      { subject: WEBSITE, metric: "ga4_conversions", value: x.keyEvents, unit: "count", ...w(x.d) },
    ]),
    ...groups.map((g) => ({ subject: WEBSITE, metric: `ga4_sessions_from_${g.slug}`, value: g.sessions, unit: "count", windowStart: start, windowEnd: end, asOf: today, src: doc.id, evidence: `${g.name}: ${fmt(g.sessions)} sessions` })),
  ];
  const done = await recordRead(ctx, ref, { doc, nodes: await channelNode(ctx, WEBSITE, "Website"), observations, dataThrough: end, props: { property: picked.property } });
  return done.ok ? { headline, property: picked.property } : { property: picked.property };
};

const instagram = (ref: ConnRef): Reader => async (execute, ctx) => {
  const d = await execute("INSTAGRAM_GET_USER_INFO", {});
  const followers = num(find(d, ["followers_count", "followersCount"]));
  if (followers === null) return {};
  const today = isoDate(ctx.now());
  const channel = "channel:instagram";
  const headline = `${plural(followers, "follower", "followers")} on Instagram`;
  const doc = snapshot("instagram", today, `Instagram numbers read on ${today}`, headline, "Followers, read from the connected account.");
  const done = await recordRead(ctx, ref, {
    doc, nodes: await channelNode(ctx, channel, "Instagram"),
    observations: [{ subject: channel, metric: "followers", value: followers, unit: "count", windowStart: today, windowEnd: today, asOf: today, src: doc.id }],
  });
  return done.ok ? { headline } : {};
};

// A reader whose one number is about the connection itself: it writes the snapshot and a single Observation that MEASURES the System.
async function measured(ctx: ConnectorCtx, ref: ConnRef, provider: string, label: string, headline: string, m: { metric: string; value: number; unit: string; windowStart?: string }): Promise<void> {
  const today = isoDate(ctx.now());
  const doc = snapshot(provider, today, `${label} read on ${today}`, headline, headline);
  try {
    await recordRead(ctx, ref, {
      doc,
      observations: [{ subject: ref.system.id, metric: m.metric, value: m.value, unit: m.unit, windowStart: m.windowStart ?? today, windowEnd: today, asOf: today, src: doc.id, evidence: headline }],
    });
  } catch {
    // the owner still gets the line: the record of this read is written again by tomorrow's
  }
}

const calendar = (ref: ConnRef): Reader => async (execute, ctx) => {
  const now = ctx.now();
  const d = await execute("GOOGLECALENDAR_EVENTS_LIST", { calendarId: "primary", timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86_400_000).toISOString(), singleEvents: true, maxResults: 50 });
  const n = list(d, ["items", "events"]).length;
  const headline = `${plural(n, "meeting", "meetings")} on your calendar in the next 7 days`;
  await measured(ctx, ref, "calendar", "Calendar", headline, { metric: "meetings_next_7d", value: n, unit: "count" });
  return { headline };
};

const stripe = (ref: ConnRef): Reader => async (execute, ctx) => {
  const d = await execute("STRIPE_RETRIEVE_BALANCE", {});
  const available = list(d, ["available"]).map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {}))[0];
  const amount = available ? num(available.amount) : null;
  const cur = available && typeof available.currency === "string" ? available.currency.toUpperCase() : "";
  if (amount === null) return {};
  const headline = `${fmt(amount / 100)} ${cur} available in your balance`.trim();
  await measured(ctx, ref, "stripe", "Stripe balance", headline, { metric: "stripe_balance_available", value: Math.round(amount) / 100, unit: "currency" });
  return { headline };
};

const shopify = (ref: ConnRef): Reader => async (execute, ctx) => {
  const since = new Date(ctx.now() - 7 * 86_400_000).toISOString();
  const d = await execute("SHOPIFY_GET_ORDER_LIST", { created_at_min: since, status: "any", limit: 250 });
  const n = list(d, ["orders"]).length;
  const headline = `${plural(n, "order", "orders")} in the last 7 days`;
  await measured(ctx, ref, "shopify", "Shopify orders", headline, { metric: "shopify_orders_7d", value: n, unit: "count", windowStart: addDays(isoDate(ctx.now()), -7) });
  return { headline };
};

const gmail = (ref: ConnRef): Reader => async (execute, ctx) => {
  const d = await execute("GMAIL_GET_PROFILE", {});
  const n = num(find(d, ["messagesTotal", "messages_total"]));
  if (n === null) return {};
  const headline = `${plural(n, "email", "emails")} in your mailbox`;
  await measured(ctx, ref, "gmail", "Gmail mailbox", headline, { metric: "gmail_messages_total", value: n, unit: "count" });
  return { headline };
};

/** Readers by Composio toolkit slug. `entry` is the catalogue entry: its connection id and System name tell the graph what was read. */
export function readerFor(entry: { id: string; toolkit: string; system: { id: string; name: string } }): Reader | null {
  const ref: ConnRef = { id: entry.id, system: entry.system, provider: "composio" };
  switch (entry.toolkit) {
    case "google_search_console": return searchConsole(ref);
    case "google_analytics": return analytics(ref);
    case "instagram": return instagram(ref);
    case "googlecalendar": return calendar(ref);
    case "stripe": return stripe(ref);
    case "shopify": return shopify(ref);
    case "gmail": return gmail(ref);
    default: return null;
  }
}
