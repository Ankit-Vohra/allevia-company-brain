// The first read: when a business connects a tool, its first numbers are read straight away so day one has something real
// ("Google Analytics connected: 3,412 visits last week"), and the same read is repeated every day. Each reader makes one or two
// read-only calls through the connection, returns one plain line (the headline the owner sees), and where the numbers are a
// kind the brain already uses (search clicks, followers) writes them as Observations with their source and date.
// Response shapes are read defensively (a missing field means no headline, never an error), because they have only been
// checked against Composio's published schemas, not against a live account (docs/connections-setup.md).
import { settleGoals } from "../program/late.js";
import { syncCapabilities } from "../capabilities/ladder.js";
import { upsertNode, writeBatch, type NodeInput, type ObservationInput } from "../graph/upsert.js";
import { addDays } from "../insights/text.js";
import { isoDate } from "../util/time.js";
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

async function markRead(ctx: ConnectorCtx, system: { id: string; name: string }, extra: Record<string, string | number | null> = {}): Promise<void> {
  const g = await ctx.graph();
  const now = ctx.now();
  await upsertNode(g, { type: "System", id: system.id, name: system.name, props: { kind: "connector", provider: "composio", status: "ok", lastPullAt: now, lastError: null, ...extra } }, now);
  try {
    await settleGoals(g, { now, ...(ctx.businessId ? { businessId: ctx.businessId } : {}) });
    await syncCapabilities(g, { now, ...(ctx.businessId ? { businessId: ctx.businessId } : {}) });
  } catch {
    // the numbers are in; the goals and the ladder catch up on the next read of the plan
  }
}

const searchConsole = (system: { id: string; name: string }): Reader => async (execute, ctx) => {
  const sites = list(await execute("GOOGLE_SEARCH_CONSOLE_LIST_SITES", {}), ["siteEntry", "sites"]).map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {})).filter((s) => typeof s.siteUrl === "string" && s.permissionLevel !== "siteUnverifiedUser");
  const site = (sites.find((s) => String(s.siteUrl).startsWith("sc-domain:")) ?? sites[0])?.siteUrl;
  if (typeof site !== "string") return {};
  const today = isoDate(ctx.now());
  const end = addDays(today, -3), start = addDays(end, -27);
  const rows = list(await execute("GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", { site_url: site, start_date: start, end_date: end, dimensions: ["date"], row_limit: 40 }), ["rows"]);
  const days = rows.flatMap((r) => { const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>; const d = Array.isArray(o.keys) ? String(o.keys[0]) : ""; return /^\d{4}-\d{2}-\d{2}$/.test(d) ? [{ d, clicks: num(o.clicks) ?? 0, impressions: num(o.impressions) ?? 0 }] : []; });
  if (!days.length) return {};
  const docId = `${SRC_PREFIX}search-console-${today}`;
  const g = await ctx.graph();
  const channel = "channel:google-search";
  const haveChannel = (await g.roQuery<{ id: string }>("MATCH (c:Entity:Channel {id:$id}) RETURN c.id AS id", { id: channel })).length > 0;
  const nodes: NodeInput[] = [
    ...(haveChannel ? [] : [{ type: "Channel" as const, id: channel, name: "Google Search" }]),
    { type: "Document", id: docId, name: `Search Console numbers read on ${today}`, summary: `Clicks and impressions for ${site}, ${start} to ${end}.`, props: { kind: "snapshot", provider: "search-console", property: site }, asOf: today },
  ];
  const observations: ObservationInput[] = days.flatMap((x) => [
    { subject: channel, metric: "gsc_clicks", value: x.clicks, unit: "count", windowStart: x.d, windowEnd: x.d, asOf: today, src: docId },
    { subject: channel, metric: "gsc_impressions", value: x.impressions, unit: "count", windowStart: x.d, windowEnd: x.d, asOf: today, src: docId },
  ]);
  const stats = await writeBatch(g, { nodes, observations }, ctx.now());
  if (stats.errors.length) return {};
  await markRead(ctx, system, { dataThrough: end, property: site });
  const clicks = days.reduce((a, x) => a + x.clicks, 0);
  return { headline: `${plural(clicks, "click", "clicks")} from Google searches in the last 28 days` };
};

const instagram = (system: { id: string; name: string }): Reader => async (execute, ctx) => {
  const d = await execute("INSTAGRAM_GET_USER_INFO", {});
  const followers = num(find(d, ["followers_count", "followersCount"]));
  if (followers === null) return {};
  const today = isoDate(ctx.now());
  const g = await ctx.graph();
  const channel = "channel:instagram";
  const docId = `${SRC_PREFIX}instagram-${today}`;
  const haveChannel = (await g.roQuery<{ id: string }>("MATCH (c:Entity:Channel {id:$id}) RETURN c.id AS id", { id: channel })).length > 0;
  const nodes: NodeInput[] = [
    ...(haveChannel ? [] : [{ type: "Channel" as const, id: channel, name: "Instagram" }]),
    { type: "Document", id: docId, name: `Instagram numbers read on ${today}`, summary: "Followers, read from the connected account.", props: { kind: "snapshot", provider: "instagram" }, asOf: today },
  ];
  const stats = await writeBatch(g, { nodes, observations: [{ subject: channel, metric: "followers", value: followers, unit: "count", windowStart: today, windowEnd: today, asOf: today, src: docId }] }, ctx.now());
  if (stats.errors.length) return {};
  await markRead(ctx, system);
  return { headline: `${plural(followers, "follower", "followers")} on Instagram` };
};

const calendar: Reader = async (execute, ctx) => {
  const now = ctx.now();
  const d = await execute("GOOGLECALENDAR_EVENTS_LIST", { calendarId: "primary", timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86_400_000).toISOString(), singleEvents: true, maxResults: 50 });
  const n = list(d, ["items", "events"]).length;
  return { headline: `${plural(n, "meeting", "meetings")} on your calendar in the next 7 days` };
};

const stripe: Reader = async (execute) => {
  const d = await execute("STRIPE_RETRIEVE_BALANCE", {});
  const available = list(d, ["available"]).map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {}))[0];
  const amount = available ? num(available.amount) : null;
  const cur = available && typeof available.currency === "string" ? available.currency.toUpperCase() : "";
  return amount === null ? {} : { headline: `${fmt(amount / 100)} ${cur} available in your balance`.trim() };
};

const shopify: Reader = async (execute, ctx) => {
  const since = new Date(ctx.now() - 7 * 86_400_000).toISOString();
  const d = await execute("SHOPIFY_GET_ORDER_LIST", { created_at_min: since, status: "any", limit: 250 });
  const n = list(d, ["orders"]).length;
  return { headline: `${plural(n, "order", "orders")} in the last 7 days` };
};

const gmail: Reader = async (execute) => {
  const d = await execute("GMAIL_GET_PROFILE", {});
  const n = num(find(d, ["messagesTotal", "messages_total"]));
  return n === null ? {} : { headline: `${plural(n, "email", "emails")} in your mailbox` };
};

/** Readers by Composio toolkit slug. */
export function readerFor(toolkit: string, system: { id: string; name: string }): Reader | null {
  switch (toolkit) {
    case "google_search_console": return searchConsole(system);
    case "instagram": return instagram(system);
    case "googlecalendar": return calendar;
    case "stripe": return stripe;
    case "shopify": return shopify;
    case "gmail": return gmail;
    default: return null;
  }
}

