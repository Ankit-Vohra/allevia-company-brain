// Users, sign-ups, the sign-up funnel, the marketplace and the admin (COE) dashboard: the app database's ops views.
// Finance stays out (founder's privacy rule): no plan, price, revenue or subscription numbers are mapped.
import { appWindow, arr, isChannelKey, isDate, lastDays, numOf, obj, snake, str, type ChannelKey, type Mapper } from "./builder.js";

const PLATFORM: Record<string, ChannelKey> = { android: "app-android", ios: "app-ios", web: "web-app" };

function createdViaChannel(v: string): ChannelKey | null {
  if (/voice/i.test(v)) return "voice-onboarding";
  if (/helpline/i.test(v)) return "helpline";
  if (/^app$/i.test(v)) return "app";
  return null;
}

const usersSummary: Mapper = (b, { data: d }) => {
  const biz = b.business;
  const t = obj(d.totals), setup = obj(d.setup);
  const sk = b.audience("seekers"), em = b.audience("employers");
  b.obs(biz, "users_total", t.all, { unit: "count" });
  b.obs(sk, "users_total", obj(t.seekers).total, { unit: "count" });
  b.obs(em, "users_total", t.employers, { unit: "count" });
  b.obs(biz, "employer_staff_total", t.employerStaff, { unit: "count" });
  b.obs(biz, "setup_completed_pct", setup.completedPct, {});
  b.obs(sk, "setup_completed_pct", obj(setup.seekers).pct, {});
  b.obs(em, "setup_completed_pct", obj(setup.employers).pct, {});
  b.obs(biz, "kyc_verified", d.kycVerified, { unit: "count" });
  // New accounts per kind come day by day from new_users; here only the per-channel split, over its 30 IST days.
  const today = str(d.todayIST);
  const w30 = isDate(today) ? lastDays(today, 30) : {};
  const perChannel = (ch: ChannelKey | null | undefined, r: Record<string, unknown>) => {
    if (!ch) return;
    const id = b.channel(ch);
    b.obs(id, "accounts_total", r.total, { unit: "count" });
    b.obs(id, "new_accounts", r.last30Days, { ...w30, unit: "count" });
  };
  for (const p of arr(d.bySignupPlatform)) perChannel(PLATFORM[str(p.platform) ?? ""], p);
  for (const c of arr(d.byChannel)) perChannel(createdViaChannel(str(c.createdVia) ?? ""), c);
};

const newUsers: Mapper = (b, { data: d }) => {
  if (str(d.groupBy) !== "day") return;
  const sk = b.audience("seekers"), em = b.audience("employers");
  for (const r of arr(d.rows)) {
    const day = str(r.day);
    if (!isDate(day)) continue;
    const w = { windowStart: day, windowEnd: day, unit: "count" };
    b.obs(b.business, "new_accounts", r.total, w);
    b.obs(sk, "new_accounts", r.seekers, w);
    b.obs(em, "new_accounts", r.employers, w);
    b.obs(b.business, "new_accounts_setup_completed", r.setupCompleted, w);
  }
};

// acquisition_sources' channel buckets (CHANNEL_SQL in aamdani-ops). Buckets that are not a channel go to the Business.
const ACQUISITION: Record<string, ChannelKey | "organic" | "other_tagged" | "unattributed"> = {
  instagram: "instagram", facebook: "facebook", youtube: "youtube", ai_search: "ai-search", search: "google-search",
  ads: "paid-ads", poster: "poster", shares: "app-shares", website: "website", play_store: "play-store",
  organic: "organic", other_tagged: "other_tagged", unknown_old_app: "unattributed", unknown: "unattributed",
};

const acquisitionSources: Mapper = (b, { data: d }) => {
  const w = { ...appWindow(d), unit: "count" };
  b.obs(b.business, "signups", d.signups, w);
  const rest: Record<string, number> = {};
  for (const r of arr(d.byChannel)) {
    const to = ACQUISITION[str(r.channel) ?? ""];
    if (!to) continue;
    if (isChannelKey(to)) {
      const id = b.channel(to);
      b.obs(id, "signups", r.signups, w);
      b.obs(id, "signups_setup_completed", r.setupCompleted, w);
    } else {
      rest[to] = (rest[to] ?? 0) + (numOf(r.signups) ?? 0);
    }
  }
  for (const [k, v] of Object.entries(rest)) b.obs(b.business, `signups_${k}`, v, w);
};

// signup_funnel's stage names (app-users.ts funnel()) -> step keys. Matched by name, never by position.
export function funnelStep(stage: string): string {
  const s = stage.trim().toLowerCase();
  if (s === "accounts created") return "accounts_created";
  if (s === "otp verified") return "otp_verified";
  if (s === "setup completed") return "setup_completed";
  if (s === "first application" || s === "first live job") return "activated";
  return snake(stage);
}

const FLOW_ORDER = ["accounts_created", "otp_verified", "setup_completed", "activated"];

const signupFunnel: Mapper = (b, { data: d }) => {
  const w = { ...appWindow(d), unit: "users" };
  for (const key of ["seekers", "employers"] as const) {
    const id = b.audience(key);
    let prev: string | undefined;
    let order = 0;
    // the steps follow the flow's own order: by stage name when every stage is a known one, else as the tool listed them
    const listed = arr(obj(d[key]).stages);
    const rank = (s: Record<string, unknown>) => FLOW_ORDER.indexOf(funnelStep(str(s.stage) ?? ""));
    const stages = listed.every((s) => rank(s) >= 0) ? [...listed].sort((x, y) => rank(x) - rank(y)) : listed;
    for (const s of stages) {
      const stage = str(s.stage);
      if (!stage) continue;
      b.obs(id, `signup_funnel_${funnelStep(stage)}`, s.count, w);
      // the same count on the step itself (a node that depends on the step before it), so the flow can be walked
      prev = b.funnelStep(key, funnelStep(stage), stage, ++order, prev);
      b.obs(prev, "funnel_users", s.count, w);
    }
  }
};

const MARKET_FLOWS = ["jobs_posted", "jobs_approved", "applications", "skips", "rejections", "shortlists", "interviews", "hires", "joins", "saves", "messages_sent"];
const marketplace: Mapper = (b, { data: d }) => {
  const w = { ...appWindow(d), unit: "count" };
  const f = obj(d.inWindow);
  for (const k of MARKET_FLOWS) b.obs(b.business, k, f[k], w);
  const now = obj(d.now);
  b.obs(b.business, "live_jobs", now.liveJobs, { unit: "count" });
  b.obs(b.business, "pending_first_job_review", now.pendingFirstJobReview, { unit: "count" });
  b.obs(b.business, "open_but_expired_jobs", now.openButExpired, { unit: "count" });
  b.obs(b.business, "jobs_all_time", now.jobsAllTime, { unit: "count" });
};

// admin_metrics is the COE dashboard. Its money tab (subscriptions, MRR, plans and their prices, payments) never enters
// the graph: a metric is dropped when its category or tabs say money, or its key or label is about money.
// Whole words (snake_case and dotted keys count as words) for the short ones, so "applications" stays and
// "featured_plan_buyers" goes.
export const FINANCE_METRIC =
  /^money\.|revenue|subscri|upgrade|payment|paying|refund|invoice|payout|rupee|currency|pric(e|ing)|arpu|₹|(^|[^a-z])(mrr|plans?|paid|inr)([^a-z]|$)/i;

export function isFinanceMetric(m: Record<string, unknown>): boolean {
  const tabs = Array.isArray(m.tabs) ? m.tabs.map((t) => String(t)) : [];
  return str(m.category)?.toLowerCase() === "money" || tabs.some((t) => /money|finance|revenue|billing/i.test(t)) ||
    FINANCE_METRIC.test(str(m.key) ?? "") || FINANCE_METRIC.test(str(m.label) ?? "") || /inr|usd|eur|gbp|aed|aud|currency|₹|\$/i.test(str(m.unit) ?? "");
}

const adminMetrics: Mapper = (b, { data: d }) => {
  for (const m of arr(d.metrics)) {
    const key = str(m.key);
    if (!key || !/^[a-z]+\.[a-z0-9_]+$/.test(key) || isFinanceMetric(m)) continue;
    const latest = obj(m.latest);
    const asOf = str(latest.day);
    if (!isDate(asOf)) continue;
    // A window in the key ("users.engaged_seekers_7d", "agents.calls_48h") moves to windowStart/windowEnd (whole IST
    // days). An age threshold ("health.verifications_pending_48h", labelled "pending >48h") is part of what is
    // counted, so it stays in the name, spelled as one: coe_health_verifications_pending_over_48h.
    const suffix = /_(\d{1,3})([dh])$/.exec(key);
    const threshold = suffix?.[2] === "h" && /[>≥]|\bover\b|\bolder\b|more than/i.test(str(m.label) ?? "");
    const base = `coe_${snake(suffix ? key.slice(0, -suffix[0].length) : key)}`;
    const name = threshold ? `${base}_over_${suffix![1]}h` : base;
    const windowDays = suffix && !threshold ? (suffix[2] === "d" ? Number(suffix[1]) : Math.ceil(Number(suffix[1]) / 24)) : 0;
    const w = { asOf, ...(windowDays ? lastDays(asOf, windowDays) : {}) };
    const unit = (str(m.unit) ?? "").toLowerCase();
    if (unit === "ratio" || unit === "share") {
      const v = numOf(latest.value);
      if (v !== undefined) b.obs(b.business, `${name}_pct`, Math.round(v * 1000) / 10, w);
    } else if (unit === "%" || unit === "pct" || unit === "percent") {
      b.obs(b.business, `${name.replace(/_pct$/, "")}_pct`, latest.value, w);
    } else {
      b.obs(b.business, name, latest.value, { ...w, unit: unit || undefined });
    }
  }
};

export const USER_MAPPERS: Record<string, Mapper> = {
  users_summary: usersSummary, new_users: newUsers, acquisition_sources: acquisitionSources, signup_funnel: signupFunnel,
  marketplace, admin_metrics: adminMetrics,
};
