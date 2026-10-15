// How the app is used and how healthy it is: AI screening / voice onboarding / helpline, PostHog activity and funnels,
// Sentry stability, Play vitals, App Store review state. For the Tech and Analytics desks.
import { appWindow, arr, isDate, lastDays, numOf, obj, snake, str, type Mapper } from "./builder.js";

const aiFeatures: Mapper = (b, { data: d }) => {
  const w = appWindow(d);
  const s = obj(d.screening), v = obj(d.voiceOnboarding), h = obj(d.helpline);
  b.obs(b.business, "screening_calls", s.calls, { ...w, unit: "count" });
  b.obs(b.business, "screening_completed", s.completed, { ...w, unit: "count" });
  b.obs(b.business, "screening_failed", s.failed, { ...w, unit: "count" });
  b.obs(b.business, "screening_completion_rate_pct", s.completionRatePct, w);
  b.obs(b.business, "screening_avg_score", s.avgScore, { ...w, unit: "score" });
  b.obs(b.business, "screening_avg_duration_s", s.avgDurationSeconds, { ...w, unit: "s" });
  const vo = b.channel("voice-onboarding");
  b.obs(vo, "voice_sessions", v.sessions, { ...w, unit: "count" });
  b.obs(vo, "voice_sessions_completed", v.completed, { ...w, unit: "count" });
  b.obs(vo, "voice_sessions_abandoned", v.abandoned, { ...w, unit: "count" });
  b.obs(vo, "voice_completion_rate_pct", v.completionRatePct, w);
  const hl = b.channel("helpline");
  b.obs(hl, "helpline_calls", h.calls, { ...w, unit: "count" });
  b.obs(hl, "helpline_new_users", h.newUsers, { ...w, unit: "count" });
  b.obs(hl, "helpline_applications", h.applications, { ...w, unit: "count" });
};

const posthogFunnels: Mapper = (b, c) => {
  const d = c.data;
  const app = b.channel("app");
  const w = lastDays(b.ctx.asOf, numOf(d.days) ?? numOf(c.args.days) ?? 7);
  b.obs(app, "app_active_users", d.activeUsers, { ...w, unit: "users" });
  for (const r of arr(d.daily)) {
    const day = str(r.day);
    if (isDate(day)) b.obs(app, "app_daily_users", r.users, { windowStart: day, windowEnd: day, unit: "users" });
  }
  const f = obj(d.funnel);
  const name = str(f.name);
  if (!name) return;
  const subject = name === "seeker_signup" ? b.audience("seekers") : name === "employer_post" ? b.audience("employers") : app;
  for (const s of arr(f.steps)) {
    const ev = snake(str(s.event) ?? "");
    if (ev) b.obs(subject, `${snake(name)}_funnel_${ev}`, s.users, { ...w, unit: "users" });
  }
};

const SENTRY_PERIOD_DAYS: Record<string, number> = { "24h": 1, "7d": 7, "14d": 14 };

const sentryIssues: Mapper = (b, { data: d }) => {
  const app = b.channel("app");
  const days = SENTRY_PERIOD_DAYS[str(d.period) ?? ""];
  const w = days ? lastDays(b.ctx.asOf, days) : {};
  const st = obj(d.stability);
  b.obs(app, "crash_free_sessions_pct", st.crashFreeSessionsPct, w);
  b.obs(app, "crash_free_users_pct", st.crashFreeUsersPct, w);
  b.obs(app, "app_sessions", st.sessions, { ...w, unit: "count" });
  b.obs(app, "sentry_new_issues", obj(d.newIssues).count, { ...w, unit: "count" });
  b.obs(app, "sentry_top_unresolved", arr(d.topUnresolved).length, { ...w, unit: "count" });
};

const playHealth: Mapper = (b, { data: d }) => {
  const android = b.channel("app-android");
  // Play's 7-day user-weighted rates, as of its latest published day.
  for (const [key, prefix] of [["crash", "crash"], ["anr", "anr"]] as const) {
    const x = obj(d[key]);
    const day = str(x.latestDay);
    if (!isDate(day)) continue;
    const w = { ...lastDays(day, 7), asOf: day };
    b.obs(android, `user_perceived_${prefix}_rate_pct`, x.last7dUserPerceivedPct, w);
    b.obs(android, `${prefix}_rate_pct`, x.last7dPct, w);
  }
};

const appStoreStatus: Mapper = (b, { data: d }) => {
  const versions = arr(d.versions);
  const ios = b.channel("app-ios", {
    onSaleVersion: str(d.onSale), latestVersionState: str(versions[0]?.state) ?? str(versions[0]?.appStoreState),
  });
  const pending = arr(d.submissions).find((s) => /WAITING|IN_REVIEW|UNRESOLVED/.test(str(s.state) ?? ""));
  if (pending) b.obs(ios, "app_review_days_waiting", pending.daysSinceSubmitted, { unit: "days" });
};

export const APP_HEALTH_MAPPERS: Record<string, Mapper> = {
  ai_features: aiFeatures, posthog_funnels: posthogFunnels, sentry_issues: sentryIssues, play_health: playHealth,
  app_store_status: appStoreStatus,
};
