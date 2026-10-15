// Search and the web: Google Search Console (per Query, per Page, sitemaps) and GA4 (totals, sessions by source,
// page views per Page). Pages are PART_OF their site's Channel.
import { entityId } from "../../../util/ids.js";
import { arr, googleWindow, isChannelKey, numOf, obj, siteChannel, str, type ChannelKey, type Json, type Mapper } from "./builder.js";

const searchConsole: Mapper = (b, { data: d }) => {
  const w = googleWindow(d);
  const gsc = (id: string, r: Json) => {
    b.obs(id, "gsc_clicks", r.clicks, { ...w, unit: "count" });
    b.obs(id, "gsc_impressions", r.impressions, { ...w, unit: "count" });
    b.obs(id, "gsc_ctr_pct", r.ctrPct, w);
    b.obs(id, "gsc_position", r.avgPosition, { ...w, unit: "position" });
  };
  gsc(b.channel("google-search"), obj(d.totals));
  for (const r of arr(obj(d.top).rows)) {
    const q = b.text(r.query, 200), p = str(r.page);
    const qid = q ? b.node("Query", entityId("Query", q), q, { text: q }) : undefined;
    const pid = p && /^https?:\/\//i.test(p) ? b.page(p) : undefined;
    if (qid && pid) b.edge(pid, "RANKS_FOR", qid); // only when Google paired them in one row
    else if (qid) gsc(qid, r);
    else if (pid) gsc(pid, r);
  }
  const maps: Record<string, { submitted: number; indexed: number }> = {};
  for (const m of arr(d.sitemaps)) {
    const ch = siteChannel(str(m.path) ?? "");
    if (!ch) continue;
    const s = (maps[ch] ??= { submitted: 0, indexed: 0 });
    s.submitted += numOf(m.submittedUrls) ?? 0;
    s.indexed += numOf(m.indexedUrls) ?? 0;
  }
  for (const [ch, s] of Object.entries(maps)) {
    const id = b.channel(ch as ChannelKey);
    b.obs(id, "gsc_sitemap_submitted_urls", s.submitted, { unit: "count" });
    b.obs(id, "gsc_sitemap_indexed_urls", s.indexed, { unit: "count" });
  }
};

// GA4 sessionSourceMedium ("google / organic", "l.instagram.com / referral") -> a channel, "direct" or "other".
export function ga4SourceChannel(sourceMedium: string): ChannelKey | "direct" | "other" {
  const s = sourceMedium.toLowerCase();
  if (s.startsWith("(direct)")) return "direct";
  if (/(^|[^a-z])(instagram|ig)([^a-z]|$)/.test(s)) return "instagram";
  if (/(^|[^a-z])(facebook|fb)([^a-z]|$)/.test(s)) return "facebook";
  if (/(^|[^a-z])(youtube|yt)([^a-z]|$)/.test(s)) return "youtube";
  if (/chatgpt|openai|perplexity|gemini|claude|copilot/.test(s)) return "ai-search";
  if (/(^|[^a-z])google([^a-z]|$)/.test(s) && /organic/.test(s)) return "google-search";
  return "other";
}

const analyticsGa4: Mapper = (b, { data: d }) => {
  const w = googleWindow(d);
  const site = str(d.site) ?? "all";
  const totals = (id: string, r: Json) => {
    b.obs(id, "ga4_active_users", r.activeUsers, { ...w, unit: "users" });
    b.obs(id, "ga4_new_users", r.newUsers, { ...w, unit: "users" });
    b.obs(id, "ga4_sessions", r.sessions, { ...w, unit: "count" });
    b.obs(id, "ga4_page_views", r.pageViews, { ...w, unit: "count" });
    b.obs(id, "ga4_engagement_rate_pct", r.engagementRatePct, w);
  };
  // The tool's own totals (users de-duplicated by GA4 itself).
  totals(site === "www" ? b.channel("website") : site === "app" ? b.channel("web-app") : b.business, obj(d.totals));
  const br = obj(d.breakdown);
  const by = str(br.by);
  if (by === "source") {
    // Sessions add up across source rows (a session has one source); users do not (one person can arrive by two), so
    // a channel gets active users only when exactly one source row maps to it.
    const groups = new Map<string, Json[]>();
    for (const r of arr(br.rows)) {
      const k = ga4SourceChannel(str(r.source) ?? "");
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const [k, rows] of groups) {
      const sessions = rows.reduce((s, r) => s + (numOf(r.sessions) ?? 0), 0);
      const single = rows.length === 1 ? rows[0]!.activeUsers : undefined;
      if (isChannelKey(k)) {
        const id = b.channel(k);
        b.obs(id, "ga4_sessions", sessions, { ...w, unit: "count" });
        b.obs(id, "ga4_active_users", single, { ...w, unit: "users" });
      } else {
        b.obs(b.business, `ga4_sessions_${k}`, sessions, { ...w, unit: "count" });
        b.obs(b.business, `ga4_active_users_${k}`, single, { ...w, unit: "users" });
      }
    }
  } else if (by === "page" && site !== "all") {
    const host = site === "app" ? "app.aamdani.ai" : "www.aamdani.ai";
    for (const r of arr(br.rows)) {
      const path = str(r.page);
      if (!path?.startsWith("/")) continue;
      const id = b.page(`https://${host}${path}`);
      b.obs(id, "ga4_page_views", r.pageViews, { ...w, unit: "count" });
      b.obs(id, "ga4_sessions", r.sessions, { ...w, unit: "count" });
      b.obs(id, "ga4_active_users", r.activeUsers, { ...w, unit: "users" });
    }
  }
};

export const SEARCH_MAPPERS: Record<string, Mapper> = { search_console: searchConsole, analytics_ga4: analyticsGa4 };
