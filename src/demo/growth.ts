// demo_growth: the public twin of the hero use case, "Why did sign-ups drop this week, and what should we do?".
// A SYNTHETIC business (Shiftly, a shift-jobs app; nothing here is a real company or person) whose records tell the same
// story as Aamdani's real week: the seeker sign-up funnel falls about 80% on one day, because the release that day put a
// new phone-number box on the sign-up screen and it crashes. Around that sits what a real week holds: an unrelated old
// crash, a smaller crash on another screen from the same release, an ad campaign paused three days later (a red herring:
// the drop began before it), a Google update from September, Google sign-in holding steady (which says it is the phone
// flow, not demand), a hotfix waiting in the App Store's review queue, a decision from last week and the thread it came
// from. Everything goes through the same writers ingestion uses (writeBatch), with a source and a date on every fact.
// Seeded by `npm run cli -- seed-demo` (src/cli/demo.ts); deterministic, no network, no model.
import type { GraphHandle } from "../graph/client.js";
import { ensureIndexes } from "../graph/indexes.js";
import { writeBatch } from "../graph/batch.js";
import { SEARCHABLE, type EntityType, type RelType } from "../graph/schema.js";
import type { EdgeInput, NodeInput, ObservationInput, Prim } from "../graph/validate.js";
import { fakeEmbed } from "./embed.js";

export const GROWTH_TENANT = "demo_growth";
export const GROWTH_BUSINESS = "business:shiftly";
export const GROWTH_NOW = Date.parse("2026-10-15T20:00:00Z"); // the records are as of the evening of 15 Oct; "this week" is 12 to 15 Oct

const D = (iso: string): number => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
const RELEASE_DAY = "2026-10-07"; // 2.8.0 reaches everyone on Android
const FIRST_DAY = "2026-09-28";
const LAST_DAY = "2026-10-15";

// A small deterministic generator, so the series are the same every time without being flat.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = D(from); t <= D(to); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sunday

interface N { type: EntityType; id: string; name: string; summary?: string; props?: Record<string, Prim>; src?: string; asOf?: string; simulated?: boolean }
interface E { from: string; type: RelType; to: string; since?: string; props?: Record<string, Prim>; src?: string; conf?: number }

export async function seedGrowth(g: GraphHandle, opts: { embed?: (text: string) => number[] } = {}): Promise<{ nodes: number; edges: number; observations: number }> {
  await ensureIndexes(g);
  const embed = opts.embed ?? fakeEmbed;
  const nodes: NodeInput[] = [];
  const edges: EdgeInput[] = [];
  const observations: ObservationInput[] = [];
  const node = (n: N): void => {
    const text = n.type === "Chunk" ? String(n.props?.text ?? "") : `${n.name} ${n.summary ?? ""}`;
    nodes.push({ ...n, ...(n.type === "Chunk" || SEARCHABLE.includes(n.type) ? { embedding: embed(text) } : {}) });
  };
  const edge = (e: E): void => {
    edges.push({ from: e.from, type: e.type, to: e.to, ...(e.since ? { since: D(e.since) } : {}), ...(e.props ? { props: e.props } : {}), ...(e.src ? { src: e.src } : {}), ...(e.conf !== undefined ? { conf: e.conf } : {}) });
  };
  const obs = (o: ObservationInput): void => { observations.push(o); };
  const daily = (subject: string, metric: string, unit: string, src: string, value: (day: string, i: number) => number, from = FIRST_DAY, to = LAST_DAY, simulated = false): void => {
    for (const [i, day] of days(from, to).entries()) {
      obs({ subject, metric, value: Math.round(value(day, i) * 100) / 100, unit, windowStart: day, windowEnd: day, asOf: day, src, ...(simulated ? { simulated: true } : {}) });
    }
  };

  // ---- sources ----
  const docs: Array<[string, string, string, string]> = [
    ["document:funnel-daily", "Sign-up funnel, daily counts (analytics export)", "report", "2026-10-15"],
    ["document:crash-reports", "Crash reports: sessions and issues (error tracker export)", "report", "2026-10-15"],
    ["document:release-notes-2-8-0", "Release notes 2.8.0", "vault", "2026-10-07"],
    ["document:release-notes-2-8-1", "Release notes 2.8.1 (hotfix)", "vault", "2026-10-13"],
    ["document:store-status", "App Store and Play status", "report", "2026-10-15"],
    ["document:ads-export", "Meta Ads export (sample numbers)", "simulated", "2026-10-15"],
    ["document:adr-014", "ADR 014: Hotfix 2.8.1, no rollback", "decision", "2026-10-10"],
    ["document:google-update-log", "Search updates log", "report", "2026-09-24"],
  ];
  for (const [id, title, kind, asOf] of docs) node({ type: "Document", id, name: title, props: { kind, title }, asOf });
  const chunks: Array<[string, string, string]> = [
    ["document:release-notes-2-8-0", "chunk:release-notes-2-8-0:0", "2.8.0 replaces the plain phone box on the sign-up screen with a new phone number field that picks the country code on its own. Rolled out to everyone on Android on 7 October."],
    ["document:release-notes-2-8-1", "chunk:release-notes-2-8-1:0", "2.8.1 fixes a crash in the phone number field on the sign-up screen when no country is detected. Built 13 October; sent to the App Store the same day."],
    ["document:adr-014", "chunk:adr-014:0", "We ship a hotfix (2.8.1) instead of rolling 2.8.0 back, because the rollback would also remove the new job feed. Owner: Farhan. Decided 10 October."],
    ["document:store-status", "chunk:store-status:0", "iPhone 2.8.1 has been waiting for App Store review since 13 October. Android 2.8.1 is built and waiting for sign-off."],
  ];
  for (const [doc, id, text] of chunks) {
    node({ type: "Chunk", id, name: `${docs.find((d) => d[0] === doc)![1]} §0`, props: { text, ord: 0 } });
    edge({ from: doc, type: "HAS_CHUNK", to: id });
  }

  // ---- company ----
  node({ type: "Business", id: GROWTH_BUSINESS, name: "Shiftly (synthetic demo)", summary: "A shift-jobs app for hourly workers. Synthetic demo data: no real company.", props: { city: "Pune", synthetic: true } });
  node({ type: "Person", id: "person:founder", name: "Rhea", summary: "Founder of Shiftly (synthetic)", props: { role: "founder" } });
  node({ type: "Person", id: "person:farhan", name: "Farhan", summary: "Android engineer; owns the sign-up screens", props: { role: "engineer" } });
  node({ type: "Person", id: "person:neha", name: "Neha", summary: "Product lead; owns the sign-up funnel", props: { role: "product" } });
  node({ type: "Person", id: "person:kavya", name: "Kavya", summary: "Marketing lead; owns paid ads", props: { role: "marketing" } });
  node({ type: "Team", id: "team:mobile", name: "Mobile team" });
  for (const p of ["person:farhan", "person:neha"]) edge({ from: p, type: "MEMBER_OF", to: "team:mobile" });
  edge({ from: "person:founder", type: "MEMBER_OF", to: GROWTH_BUSINESS });

  // ---- the app, its screens, its releases ----
  node({ type: "Channel", id: "channel:app", name: "Shiftly app", props: { platform: "app", status: "active" }, src: "document:store-status", asOf: "2026-10-15" });
  node({ type: "Channel", id: "channel:app-android", name: "Android app", props: { platform: "android", status: "active" } });
  node({ type: "Channel", id: "channel:app-ios", name: "iPhone app", props: { platform: "ios", status: "active" } });
  node({ type: "Channel", id: "channel:meta-ads", name: "Meta Ads", props: { platform: "meta", status: "active" } });
  node({ type: "Channel", id: "channel:google-search", name: "Google Search", props: { platform: "google", status: "active" } });
  for (const c of ["channel:app", "channel:meta-ads", "channel:google-search"]) edge({ from: c, type: "PART_OF", to: GROWTH_BUSINESS });
  for (const c of ["channel:app-android", "channel:app-ios"]) edge({ from: c, type: "PART_OF", to: GROWTH_BUSINESS });

  const screens: Array<[string, string, string]> = [
    ["page:screen/app/auth/sign-up", "app/auth/sign-up", "Sign-up screen (phone number)"],
    ["page:screen/app/auth/otp", "app/auth/otp", "OTP screen"],
    ["page:screen/app/profile/setup", "app/profile/setup", "Profile setup screen"],
    ["page:screen/app/jobs/feed", "app/jobs/feed", "Job feed screen"],
  ];
  for (const [id, route, name] of screens) {
    node({ type: "Page", id, name, props: { kind: "app_screen", route }, src: "document:crash-reports", asOf: "2026-10-15" });
    edge({ from: id, type: "PART_OF", to: "channel:app" });
  }
  edge({ from: "person:farhan", type: "OWNS", to: "page:screen/app/auth/sign-up", since: "2026-06-01" });
  edge({ from: "person:farhan", type: "OWNS", to: "page:screen/app/auth/otp", since: "2026-06-01" });
  edge({ from: "person:neha", type: "OWNS", to: "page:screen/app/profile/setup", since: "2026-06-01" });
  edge({ from: "person:farhan", type: "OWNS", to: "page:screen/app/jobs/feed", since: "2026-06-01" });

  const release = (id: string, version: string, at: string, notes: string, doc: string): void => {
    node({ type: "Event", id, name: `Release ${version}`, summary: notes, props: { kind: "release", release: version, platform: "android", releasedAt: at }, src: doc, asOf: at });
    edge({ from: id, type: "AFFECTS", to: "channel:app", src: doc });
  };
  release("event:release-shiftly-2-7-4", "shiftly@2.7.4+90", "2026-09-29", "Routine fixes.", "document:store-status");
  release("event:release-shiftly-2-8-0", "shiftly@2.8.0+91", RELEASE_DAY, "New phone number field on the sign-up screen; new job feed.", "document:release-notes-2-8-0");
  release("event:release-shiftly-2-8-1", "shiftly@2.8.1+92", "2026-10-13", "Hotfix for the phone number field crash.", "document:release-notes-2-8-1");
  node({ type: "Event", id: "event:ios-version-2-8-1", name: "iPhone app 2.8.1", props: { kind: "release", platform: "ios", version: "2.8.1", state: "WAITING_FOR_REVIEW", submittedAt: "2026-10-13" }, src: "document:store-status", asOf: "2026-10-15" });
  edge({ from: "event:ios-version-2-8-1", type: "AFFECTS", to: "channel:app-ios", src: "document:store-status" });
  obs({ subject: "channel:app-ios", metric: "app_review_days_waiting", value: 2, unit: "days", asOf: "2026-10-15", src: "document:store-status" });

  // ---- crash issues: the cause, a smaller one from the same release, and an old unrelated one ----
  const issue = (id: string, title: string, route: string | null, first: string, level: string, rel: string | null, how: string | null): void => {
    node({ type: "Event", id, name: title, props: { kind: "sentry_issue", level, unhandled: true, firstSeen: first, lastSeen: LAST_DAY, unresolved: true }, src: "document:crash-reports", asOf: "2026-10-15" });
    edge({ from: id, type: "AFFECTS", to: "channel:app", src: "document:crash-reports" });
    if (route) edge({ from: id, type: "AFFECTS", to: `page:screen/${route}`, props: { how: "crashed_on" }, src: "document:crash-reports" });
    if (rel) edge({ from: rel, type: "AFFECTS", to: id, props: { how: how ?? "introduced" }, conf: 0.9, src: "document:crash-reports" });
  };
  issue("event:sentry-issue-shiftly-41", "TypeError: Cannot read properties of undefined (reading 'country') in PhoneInput", "app/auth/sign-up", RELEASE_DAY, "fatal", "event:release-shiftly-2-8-0", "introduced");
  issue("event:sentry-issue-shiftly-52", "OutOfMemoryError while decoding the profile photo", "app/profile/setup", "2026-10-12", "error", "event:release-shiftly-2-8-0", "introduced");
  issue("event:sentry-issue-shiftly-37", "Error: Network request failed (job feed)", "app/jobs/feed", "2026-09-02", "error", null, null);

  // ---- the funnel: steps that depend on the one before, and the screen each happens on ----
  const steps: Array<{ id: string; key: string; name: string; screen: string | null; base: number; after: number }> = [
    { id: "feature:seekers-signup-app-opened", key: "app_opened", name: "App opened", screen: null, base: 520, after: 505 },
    { id: "feature:seekers-signup-sign-up-screen-viewed", key: "sign_up_screen_viewed", name: "Sign-up screen viewed", screen: "page:screen/app/auth/sign-up", base: 390, after: 378 },
    { id: "feature:seekers-signup-phone-number-entered", key: "phone_number_entered", name: "Phone number entered", screen: "page:screen/app/auth/sign-up", base: 300, after: 62 },
    { id: "feature:seekers-signup-otp-verified", key: "otp_verified", name: "OTP verified", screen: "page:screen/app/auth/otp", base: 252, after: 52 },
    { id: "feature:seekers-signup-profile-completed", key: "profile_completed", name: "Profile completed", screen: "page:screen/app/profile/setup", base: 196, after: 40 },
    { id: "feature:seekers-signup-first-application", key: "first_application", name: "First application", screen: "page:screen/app/jobs/feed", base: 124, after: 26 },
  ];
  node({ type: "Audience", id: "audience:seekers", name: "Seekers (shift workers)" });
  steps.forEach((s, i) => {
    node({ type: "Feature", id: s.id, name: `Seekers: ${s.name}`, summary: `Step ${i + 1} of the seeker sign-up flow.`, props: { kind: "funnel_step", audience: "seekers", step: s.key, order: i + 1 }, src: "document:funnel-daily", asOf: "2026-10-15" });
    edge({ from: s.id, type: "DEPENDS_ON", to: i === 0 ? "channel:app" : steps[i - 1]!.id, src: "document:funnel-daily" });
    if (s.screen) edge({ from: s.id, type: "DEPENDS_ON", to: s.screen, src: "document:funnel-daily" });
    const r = rng(1000 + i * 17);
    daily(s.id, "funnel_users", "users", "document:funnel-daily", (day) => {
      const level = day >= RELEASE_DAY ? s.after : s.base;
      const weekend = [0, 6].includes(weekday(day)) ? 0.86 : 1;
      return Math.round(level * weekend * (0.93 + r() * 0.14));
    });
  });
  // accounts created per day: the number the owner calls "sign-ups"
  const rs = rng(7);
  const signups = (day: string): number => {
    const weekend = [0, 6].includes(weekday(day)) ? 0.86 : 1;
    return Math.round((day >= RELEASE_DAY ? 51 : 247) * weekend * (0.93 + rs() * 0.14));
  };
  daily(GROWTH_BUSINESS, "new_accounts", "count", "document:funnel-daily", signups);
  // by method: Google sign-in is untouched, so it is the phone flow, not demand
  const rg = rng(11);
  daily("channel:app", "signups_google", "count", "document:funnel-daily", () => 38 + Math.round(rg() * 8));
  const rp = rng(13);
  daily("channel:app", "signups_phone", "count", "document:funnel-daily", (day) => Math.max(8, signups(day) - 41) + Math.round(rp() * 3));

  // downstream things that need the funnel (what else breaks), and the campaign sending people into it
  node({ type: "Campaign", id: "campaign:meta-seekers-pune", name: "Seekers: Pune shift jobs (Meta ads)", props: { status: "paused", objective: "app installs", pausedAt: "2026-10-10" }, simulated: true, src: "document:ads-export", asOf: "2026-10-15" });
  edge({ from: "campaign:meta-seekers-pune", type: "PUBLISHED_ON", to: "channel:meta-ads", src: "document:ads-export" });
  edge({ from: "campaign:meta-seekers-pune", type: "DEPENDS_ON", to: "page:screen/app/auth/sign-up", src: "document:ads-export" });
  edge({ from: "person:kavya", type: "OWNS", to: "campaign:meta-seekers-pune", since: "2026-08-01" });
  const ra = rng(21);
  for (const day of days(FIRST_DAY, LAST_DAY)) {
    const live = day < "2026-10-10";
    const base = { subject: "campaign:meta-seekers-pune", windowStart: day, windowEnd: day, asOf: day, src: "document:ads-export", simulated: true };
    obs({ ...base, metric: "spend", value: live ? 9000 + Math.round(ra() * 600) : 0, unit: "INR" });
    obs({ ...base, metric: "impressions", value: live ? 118000 + Math.round(ra() * 6000) : 0, unit: "count" });
    obs({ ...base, metric: "clicks", value: live ? 3300 + Math.round(ra() * 200) : 0, unit: "count" });
  }
  node({ type: "Feature", id: "feature:referral-invites", name: "Referral invites", summary: "Seekers invite friends once verified.", props: { kind: "feature" } });
  node({ type: "Feature", id: "feature:job-alert-sms", name: "Job-alert SMS", summary: "Sends new-shift alerts to verified seekers who finished their profile.", props: { kind: "service", status: "running" } });
  node({ type: "Feature", id: "feature:employer-applicant-inbox", name: "Employer applicant inbox", summary: "Employers see completed seeker profiles here.", props: { kind: "feature" } });
  node({ type: "Feature", id: "feature:employer-first-hire-promise", name: "Employer promise: first hire within 7 days", summary: "Marketing promise to employers; needs seekers who applied.", props: { kind: "feature" } });
  edge({ from: "feature:referral-invites", type: "DEPENDS_ON", to: "feature:seekers-signup-otp-verified" });
  edge({ from: "feature:job-alert-sms", type: "DEPENDS_ON", to: "feature:seekers-signup-otp-verified" });
  edge({ from: "feature:employer-applicant-inbox", type: "DEPENDS_ON", to: "feature:seekers-signup-profile-completed" });
  edge({ from: "feature:employer-first-hire-promise", type: "DEPENDS_ON", to: "feature:seekers-signup-profile-completed" });
  edge({ from: "person:neha", type: "OWNS", to: "feature:seekers-signup-phone-number-entered", since: "2026-06-01" });

  // ---- the numbers the crash tracker keeps ----
  const rc = rng(31);
  daily("channel:app", "crash_free_sessions_daily_pct", "%", "document:crash-reports", (day) => (day >= RELEASE_DAY ? 91.2 + rc() * 1.6 : 99.2 + rc() * 0.6));
  const rn = rng(37);
  daily("channel:app", "app_sessions_daily", "count", "document:crash-reports", (day) => ([0, 6].includes(weekday(day)) ? 5100 : 5900) + Math.round(rn() * 300));
  const r41 = rng(41);
  daily("event:sentry-issue-shiftly-41", "sentry_issue_events", "count", "document:crash-reports", (day) => (day >= RELEASE_DAY ? 380 + Math.round(r41() * 70) : 0), RELEASE_DAY, LAST_DAY);
  daily("event:sentry-issue-shiftly-41", "sentry_issue_users", "count", "document:crash-reports", (day) => (day >= RELEASE_DAY ? 190 + Math.round(r41() * 30) : 0), RELEASE_DAY, LAST_DAY);
  daily("event:sentry-issue-shiftly-52", "sentry_issue_events", "count", "document:crash-reports", (day) => (day >= "2026-10-12" ? 3 + Math.round(r41() * 3) : 0), "2026-10-12", LAST_DAY);
  daily("event:sentry-issue-shiftly-37", "sentry_issue_events", "count", "document:crash-reports", () => 24 + Math.round(r41() * 6));
  obs({ subject: "channel:app", metric: "crash_free_sessions_pct", value: 92.1, unit: "%", windowStart: "2026-10-08", windowEnd: "2026-10-15", asOf: "2026-10-15", src: "document:crash-reports" });

  // ---- noise: a September search update, steady visits ----
  node({ type: "Event", id: "event:google-update-september-2026-spam-update", name: "September 2026 Spam Update", props: { kind: "google-update", at: "2026-09-24" }, src: "document:google-update-log", asOf: "2026-09-24" });
  edge({ from: "event:google-update-september-2026-spam-update", type: "AFFECTS", to: "channel:google-search", src: "document:google-update-log" });
  const rv = rng(43);
  daily("channel:google-search", "visits", "count", "document:funnel-daily", () => 410 + Math.round(rv() * 40));

  // ---- the plan from last week: a decision, its tasks, and the thread it came from ----
  node({ type: "Decision", id: "decision:014-hotfix-not-rollback", name: "Ship hotfix 2.8.1, do not roll back 2.8.0", summary: "Rolling back would also remove the new job feed, so fix the phone number field and ship 2.8.1.", props: { status: "accepted", decidedAt: "2026-10-10" }, src: "document:adr-014", asOf: "2026-10-10" });
  edge({ from: "decision:014-hotfix-not-rollback", type: "SOURCED_FROM", to: "document:adr-014" });
  edge({ from: "person:founder", type: "DECIDED", to: "decision:014-hotfix-not-rollback", since: "2026-10-10" });
  edge({ from: "decision:014-hotfix-not-rollback", type: "AFFECTS", to: "event:release-shiftly-2-8-0", since: "2026-10-10" });
  edge({ from: "decision:014-hotfix-not-rollback", type: "AFFECTS", to: "event:sentry-issue-shiftly-41", since: "2026-10-10" });
  edge({ from: "decision:014-hotfix-not-rollback", type: "BASED_ON", to: "document:crash-reports", since: "2026-10-10" });
  node({ type: "Task", id: "task:ship-hotfix-2-8-1", name: "Ship hotfix 2.8.1 on Android and iPhone", props: { status: "in_progress" }, src: "document:store-status", asOf: "2026-10-15" });
  edge({ from: "person:farhan", type: "OWNS", to: "task:ship-hotfix-2-8-1", since: "2026-10-10" });
  edge({ from: "event:ios-version-2-8-1", type: "BLOCKS", to: "task:ship-hotfix-2-8-1", src: "document:store-status" });
  edge({ from: "task:ship-hotfix-2-8-1", type: "AFFECTS", to: "event:sentry-issue-shiftly-41" });
  node({ type: "Session", id: "session:growth-001", name: "Thread: crash-free sessions", props: { channel: "discord", startedAt: D("2026-10-09T10:00:00Z") } });
  node({ type: "Turn", id: "turn:growth-001", name: "Why are crash-free sessions down since Wednesday?", summary: "Crashes since 2.8.0 on the sign-up screen; Farhan is on a hotfix.", props: {
    question: "Why are crash-free sessions down since Wednesday?",
    answer: "Crash-free sessions fell from about 99% to about 92% on 7 October, the day 2.8.0 reached everyone [[event:release-shiftly-2-8-0]]. The crash is in the new phone number field on the sign-up screen [[event:sentry-issue-shiftly-41]]. Farhan owns it [[page:screen/app/auth/sign-up]].",
    at: D("2026-10-09T10:05:00Z"), status: "ok", checks: JSON.stringify({ citationsValid: true }), agents: ["chief-of-staff", "oncall-engineer"], source: "discord" } });
  edge({ from: "turn:growth-001", type: "IN_SESSION", to: "session:growth-001" });
  edge({ from: "person:founder", type: "ASKED", to: "turn:growth-001" });
  for (const t of ["event:release-shiftly-2-8-0", "event:sentry-issue-shiftly-41", "page:screen/app/auth/sign-up", "channel:app", "decision:014-hotfix-not-rollback", "feature:seekers-signup-phone-number-entered"]) {
    edge({ from: "turn:growth-001", type: "TOUCHED", to: t });
  }
  for (const t of ["event:release-shiftly-2-8-0", "event:sentry-issue-shiftly-41"]) edge({ from: "turn:growth-001", type: "CITED", to: t });
  node({ type: "Memory", id: "memory:growth-001-1", name: "Tell users only when a fix is on its way", props: { kind: "preference", text: "Do not message users about a bug until the fix is shipping; then say what to do in two lines, no apology essay.", at: D("2026-10-09T10:10:00Z") }, src: "turn:growth-001" });
  edge({ from: "memory:growth-001-1", type: "ABOUT", to: GROWTH_BUSINESS });
  edge({ from: "person:founder", type: "STATED", to: "memory:growth-001-1" });

  const stats = await writeBatch(g, { nodes, edges, observations }, GROWTH_NOW);
  if (stats.errors.length) throw new Error(`seedGrowth: ${stats.errors.length} write errors: ${stats.errors.map((e) => `${e.kind} ${e.error}`).join(" | ")}`);
  return { nodes: nodes.length, edges: edges.length, observations: observations.length };
}
