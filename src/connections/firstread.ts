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

export interface FirstRead { headline?: string }
export type Reader = (execute: Execute, ctx: ConnectorCtx) => Promise<FirstRead>;

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
    case "instagram": return instagram(ref);
    case "googlecalendar": return calendar(ref);
    case "stripe": return stripe(ref);
    case "shopify": return shopify(ref);
    case "gmail": return gmail(ref);
    default: return null;
  }
}
