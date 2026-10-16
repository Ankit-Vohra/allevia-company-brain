// How the app is used and how healthy it is: AI screening / voice onboarding / helpline, PostHog activity and funnels,
// Sentry stability and issues, Play vitals and their thresholds, App Store review state, versions and builds. For the
// Tech desks (Arjun, Zoya on call, Imran for releases) and Analytics.
//
// Sentry issues, releases and builds are Event nodes that AFFECT the app's Channel, so a Recommendation can cite them
// as evidence; the numbers on them (events, people, a day's sessions) are dated Observations. The issue's link names the
// Sentry organisation and is never kept; its title is redacted free text.
import { entityId } from "../../../util/ids.js";
import { appWindow, arr, isDate, lastDays, numOf, obj, snake, str, type Builder, type Json, type Mapper } from "./builder.js";

// "<global>(app/auth/login)" -> "app/auth/login": the screen route a tracker puts in an issue's `where`.
export const screenRoute = (where: unknown): string | undefined => /\((app\/[\w\-./[\]]+)\)/.exec(typeof where === "string" ? where : "")?.[1];

const day = (v: unknown): string | undefined => {
  const d = typeof v === "string" ? v.slice(0, 10) : undefined;
  return isDate(d) ? d : undefined;
};

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
  // Each step is also a node (Feature, kind funnel_step) that depends on the step before it, so the steps can be walked and
  // a break at one is a break at every later one; its count is a reading on the step itself.
  const audience = name === "seeker_signup" ? "seekers" : name === "employer_post" ? "employers" : undefined;
  let prev: string | undefined;
  for (const s of arr(f.steps)) {
    const ev = snake(str(s.event) ?? "");
    if (!ev) continue;
    b.obs(subject, `${snake(name)}_funnel_${ev}`, s.users, { ...w, unit: "users" });
    if (audience) {
      prev = b.funnelStep(audience, ev, ev.replace(/_/g, " "), numOf(s.step) ?? 0, prev);
      b.obs(prev, "funnel_users", s.users, { ...w, unit: "users" });
    }
  }
};

const SENTRY_PERIOD_DAYS: Record<string, number> = { "24h": 1, "7d": 7, "14d": 14 };

// One Sentry issue as an Event on the app: new ones first (the first value of a prop wins), then the unresolved ones add
// their own flag. Events and people in the period are Observations on the Event.
function sentryIssue(b: Builder, app: string, x: Json, flag: "isNew" | "unresolved", w: { windowStart?: string; windowEnd?: string }): void {
  const key = str(x.id);
  const title = b.text(x.title, 120);
  if (!key || !title) return;
  const id = b.node("Event", entityId("Event", `sentry issue ${key}`), title, {
    kind: "sentry_issue", level: str(x.level), priority: str(x.priority), unhandled: typeof x.unhandled === "boolean" ? x.unhandled : undefined,
    where: b.text(x.where, 80), firstSeen: day(x.firstSeen), lastSeen: day(x.lastSeen), [flag]: true,
  });
  b.edge(id, "AFFECTS", app);
  // The screen it happened on (a route in `where`), and the release that first carried it when the tracker says so.
  const route = screenRoute(x.where);
  if (route) b.edge(id, "AFFECTS", b.screen(route), { props: { how: "crashed_on" } });
  const first = obj(x.firstRelease);
  const version = b.text(str(x.firstRelease) ?? first.version, 80);
  if (version) {
    const rel = b.node("Event", entityId("Event", `release ${version}`), `Release ${version}`, { kind: "release", release: version, platform: "app", releasedAt: day(first.dateReleased ?? first.dateCreated) });
    b.edge(rel, "AFFECTS", app);
    b.edge(rel, "AFFECTS", id, { props: { how: "introduced" }, conf: 0.9 });
  }
  b.obs(id, "sentry_issue_events", x.eventsInPeriod, { ...w, unit: "count" });
  b.obs(id, "sentry_issue_users", x.users, { ...w, unit: "count" });
}

const sentryIssues: Mapper = (b, { data: d }) => {
  const app = b.channel("app");
  const days = SENTRY_PERIOD_DAYS[str(d.period) ?? ""];
  const w = days ? lastDays(b.ctx.asOf, days) : {};
  const st = obj(d.stability);
  b.obs(app, "crash_free_sessions_pct", st.crashFreeSessionsPct, w);
  b.obs(app, "crash_free_users_pct", st.crashFreeUsersPct, w);
  b.obs(app, "app_sessions", st.sessions, { ...w, unit: "count" });
  b.obs(app, "app_users", st.users, { ...w, unit: "count" });
  b.obs(app, "sentry_new_issues", obj(d.newIssues).count, { ...w, unit: "count" });
  b.obs(app, "sentry_top_unresolved", arr(d.topUnresolved).length, { ...w, unit: "count" });
  // The day-by-day series, so a change after a release can be read: one reading per day (a day's window is that day).
  for (const p of arr(st.series)) {
    const at = day(p.at);
    if (!at) continue;
    b.obs(app, "crash_free_sessions_daily_pct", p.crashFreePct, { windowStart: at, windowEnd: at });
    b.obs(app, "app_sessions_daily", p.sessions, { windowStart: at, windowEnd: at, unit: "count" });
  }
  for (const x of arr(obj(d.newIssues).items)) sentryIssue(b, app, x, "isNew", w);
  for (const x of arr(d.topUnresolved)) sentryIssue(b, app, x, "unresolved", w);
  for (const r of arr(d.latestRelease)) {
    const release = b.text(r.release, 80);
    if (!release) continue;
    const id = b.node("Event", entityId("Event", `release ${release}`), `Release ${release}`, { kind: "release", release, project: b.text(r.project, 60), platform: "app", releasedAt: day(r.dateReleased ?? r.dateCreated) });
    b.edge(id, "AFFECTS", app);
  }
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
  // Play's own "bad behaviour" lines (a user-perceived crash or ANR rate above these hurts the app's visibility).
  const th = obj(d.badBehaviourThresholdsPct);
  b.obs(android, "user_perceived_crash_rate_threshold_pct", th.userPerceivedCrash);
  b.obs(android, "user_perceived_anr_rate_threshold_pct", th.userPerceivedAnr);
};

const LIVE_STATES = /^(?:READY_FOR_SALE|READY_FOR_DISTRIBUTION|PROCESSING_FOR_DISTRIBUTION)$/;

const appStoreStatus: Mapper = (b, { data: d }) => {
  const versions = arr(d.versions);
  const pending = arr(d.submissions).find((s) => /WAITING|IN_REVIEW|UNRESOLVED/.test(str(s.state) ?? ""));
  const ios = b.channel("app-ios", {
    onSaleVersion: str(d.onSale), latestVersion: str(versions[0]?.version),
    latestVersionState: str(versions[0]?.state) ?? str(versions[0]?.appStoreState),
    reviewSubmittedAt: pending ? day(pending.submitted) : undefined,
  });
  if (pending) b.obs(ios, "app_review_days_waiting", pending.daysSinceSubmitted, { unit: "days" });
  for (const v of versions) {
    const version = b.text(v.version, 40);
    if (!version) continue;
    const state = str(v.state) ?? str(v.appStoreState);
    const id = b.node("Event", entityId("Event", `ios version ${version}`), `iPhone app ${version}`, {
      kind: "release", platform: "ios", version, state, versionCreated: day(v.created), ...(state && LIVE_STATES.test(state) ? { live: true } : {}),
    });
    b.edge(id, "AFFECTS", ios);
  }
  for (const x of arr(d.latestBuilds)) {
    const build = b.text(x.build, 40);
    if (!build) continue;
    const id = b.node("Event", entityId("Event", `ios build ${build}`), `iPhone app build ${build}`, {
      kind: "build", platform: "ios", build, processing: str(x.processing), uploadedAt: day(x.uploaded), expired: typeof x.expired === "boolean" ? x.expired : undefined,
    });
    b.edge(id, "AFFECTS", ios);
  }
};

export const APP_HEALTH_MAPPERS: Record<string, Mapper> = {
  ai_features: aiFeatures, posthog_funnels: posthogFunnels, sentry_issues: sentryIssues, play_health: playHealth,
  app_store_status: appStoreStatus,
};
