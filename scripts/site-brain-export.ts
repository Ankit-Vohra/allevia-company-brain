// Exports the picture of a company brain that the website draws, from the real graph of the sample business
// (demo_growth, "Shiftly": synthetic data, no real company). Read-only: it only asks the graph questions.
//
//   npx tsx scripts/site-brain-export.ts [timed-run.json]
//
// It picks the things an owner would recognise (the business, the people, the channels, the screens, the funnel steps,
// the releases and crashes, the leads and meetings), keeps every real edge between them, attaches each funnel step's
// real daily readings, decides in which wave each thing arrives (from your website, then from each connected tool or
// file, by the source the graph records for it), lays them out once (a seeded force layout, so the page does no layout
// work) and writes site/src/brain/brain-data.json. When a timed run from site/scripts/record-live.mjs is given, the
// run's steps (who worked when, which things they read, the path of the answer, the answer) go into the same file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAll, openGraph } from "../src/graph/client.js";
import { typeOfLabels } from "../src/graph/schema.js";

const TENANT = "demo_growth";
const OUT = fileURLToPath(new URL("../site/src/brain/brain-data.json", import.meta.url));
const W = 800;
const H = 560;

type Row = { labels: string[]; id: string; name: string | null; src: string | null; summary: string | null };
type Edge = { a: string; t: string; b: string; how: string | null };
type Obs = { id: string; metric: string | null; value: number | null; asOf: string | null; subject: string | null };

// ---------- what to show ----------
// A short label for the things worth naming on the page. Everything else is a dot.
const LABEL: Record<string, string> = {
  "business:shiftly": "Shiftly",
  "person:founder": "Rhea", "person:farhan": "Farhan", "person:neha": "Neha", "person:kavya": "Kavya",
  "team:mobile": "Mobile team",
  "channel:app": "App", "channel:app-android": "Android", "channel:app-ios": "iPhone", "channel:meta-ads": "Meta Ads", "channel:google-search": "Google Search", "channel:website": "Website",
  "audience:seekers": "Job seekers",
  "feature:seekers-signup-app-opened": "Opened the app", "feature:seekers-signup-sign-up-screen-viewed": "Saw sign-up", "feature:seekers-signup-phone-number-entered": "Phone number entered",
  "feature:seekers-signup-otp-verified": "Code verified", "feature:seekers-signup-profile-completed": "Profile done", "feature:seekers-signup-first-application": "First application",
  "feature:referral-invites": "Referrals", "feature:job-alert-sms": "Job alerts", "feature:employer-applicant-inbox": "Employer inbox", "feature:employer-first-hire-promise": "First hire in 7 days",
  "campaign:meta-seekers-pune": "Pune ad campaign",
  "page:screen/app/auth/sign-up": "Sign-up screen", "page:screen/app/auth/otp": "Code screen", "page:screen/app/profile/setup": "Profile screen", "page:screen/app/jobs/feed": "Job feed",
  "event:release-shiftly-2-7-4": "Release 2.7.4", "event:release-shiftly-2-8-0": "Release 2.8.0", "event:release-shiftly-2-8-1": "Hotfix 2.8.1", "event:ios-version-2-8-1": "iPhone 2.8.1",
  "event:sentry-issue-shiftly-41": "Crash on sign-up", "event:sentry-issue-shiftly-52": "Crash: photo", "event:sentry-issue-shiftly-37": "Crash: job feed",
  "event:google-update-september-2026-spam-update": "Google update",
  "decision:014-hotfix-not-rollback": "Decision: hotfix",
  "task:ship-hotfix-2-8-1": "Ship the hotfix",
};

// Where a thing arrives from. "site" is what a website read gives; the rest are the connected tools and files, by source.
const WAVE_OF_SRC: Record<string, string> = {
  "document:funnel-daily": "analytics", "document:ads-export": "ads",
  "document:crash-reports": "files", "document:store-status": "files", "document:release-notes-2-8-0": "files", "document:release-notes-2-8-1": "files",
  "document:adr-014": "files", "document:google-update-log": "files",
};

const KEEP_IDS = new Set(Object.keys(LABEL));

// ---------- helpers ----------
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const hash = (s: string): number => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

interface N {
  id: string; type: string; label: string; name: string; group: string; wave: "site" | "analytics" | "ads" | "gmail" | "calendar" | "files";
  x: number; y: number; r: number; deg: number; order: number; labelled: boolean;
}

// Which tool group each tool's dock sits near (viewBox 800 x 560). Docks are on the edge; clusters sit inside.
const DOCK: Record<string, { x: number; y: number; name: string }> = {
  analytics: { x: 150, y: 70, name: "Analytics" },
  ads: { x: 640, y: 70, name: "Meta Ads" },
  gmail: { x: 70, y: 400, name: "Gmail" },
  calendar: { x: 200, y: 505, name: "Calendar" },
  files: { x: 650, y: 495, name: "Your files" },
};
// The picture is composed by hand, not by a force layout: a force layout of a graph this connected is a hairball, and this one
// is the page's hero. Funnel along the top (Analytics), the business and its channels on the left, the app's screens, crashes
// and releases in the middle, the ad campaign, leads and calls down the right edge. Positions are in the 800 x 560 box.
const POS: Record<string, [number, number]> = {
  "business:shiftly": [150, 285], "audience:seekers": [70, 215], "person:founder": [58, 300], "channel:website": [92, 372],
  "channel:google-search": [172, 410], "channel:app": [262, 292], "channel:app-android": [236, 360], "channel:app-ios": [320, 352],
  "channel:meta-ads": [655, 150], "team:mobile": [338, 205], "person:farhan": [405, 285], "person:neha": [300, 150], "person:kavya": [725, 235],
  "feature:referral-invites": [412, 170], "feature:job-alert-sms": [495, 182], "feature:employer-applicant-inbox": [575, 182], "feature:employer-first-hire-promise": [648, 205],
  "feature:seekers-signup-app-opened": [110, 105], "feature:seekers-signup-sign-up-screen-viewed": [222, 80], "feature:seekers-signup-phone-number-entered": [334, 105],
  "feature:seekers-signup-otp-verified": [446, 80], "feature:seekers-signup-profile-completed": [558, 105], "feature:seekers-signup-first-application": [670, 80],
  "campaign:meta-seekers-pune": [705, 185],
  "page:screen/app/auth/sign-up": [372, 258], "page:screen/app/auth/otp": [470, 240], "page:screen/app/profile/setup": [565, 252], "page:screen/app/jobs/feed": [635, 270],
  "event:sentry-issue-shiftly-41": [412, 352], "event:sentry-issue-shiftly-52": [560, 345], "event:sentry-issue-shiftly-37": [640, 352],
  "event:release-shiftly-2-8-0": [478, 425], "event:release-shiftly-2-7-4": [600, 440], "event:release-shiftly-2-8-1": [392, 430], "event:ios-version-2-8-1": [535, 478],
  "task:ship-hotfix-2-8-1": [318, 462], "decision:014-hotfix-not-rollback": [310, 400], "event:google-update-september-2026-spam-update": [112, 452],
};
const GRID_GMAIL: [number, number][] = [[690, 300], [748, 305], [690, 345], [748, 350], [690, 390], [748, 395], [690, 435]];
const GRID_CAL: [number, number][] = [[742, 450], [700, 488]];

function place(nodes: N[]): void {
  const gm = nodes.filter((n) => n.wave === "gmail").sort((x, y) => (x.type === y.type ? x.id.localeCompare(y.id) : x.type === "Lead" ? -1 : 1));
  // leads in the left column, their deals beside them
  const leads = gm.filter((n) => n.type === "Lead"), deals = gm.filter((n) => n.type === "Deal");
  leads.forEach((n, i) => { const p = GRID_GMAIL[i * 2] ?? GRID_GMAIL[GRID_GMAIL.length - 1]!; n.x = p[0]; n.y = p[1]; });
  deals.forEach((n) => {
    const suffix = n.id.replace(/^deal:/, "");
    const lead = leads.findIndex((l) => l.id === "lead:" + suffix);
    const p = GRID_GMAIL[(lead < 0 ? deals.indexOf(n) : lead) * 2 + 1] ?? GRID_GMAIL[1]!;
    n.x = p[0]; n.y = p[1];
  });
  nodes.filter((n) => n.wave === "calendar").forEach((n, i) => { const p = GRID_CAL[i] ?? GRID_CAL[0]!; n.x = p[0]; n.y = p[1]; });
  for (const n of nodes) { const p = POS[n.id]; if (p) { n.x = p[0]; n.y = p[1]; } }
  const missing = nodes.filter((n) => n.x === 0 && n.y === 0);
  if (missing.length) throw new Error("no position for " + missing.map((m) => m.id).join(", "));
}

async function main() {
  const timedPath = process.argv[2];
  const g = await openGraph(TENANT);
  const rows = await g.roQuery<Row>("MATCH (n:Entity) RETURN labels(n) AS labels, n.id AS id, n.name AS name, n.src AS src, n.summary AS summary");
  const allEdges = await g.roQuery<Edge>("MATCH (a:Entity)-[r]->(b:Entity) RETURN a.id AS a, type(r) AS t, b.id AS b, r.how AS how");
  const obs = await g.roQuery<Obs>("MATCH (o:Entity:Observation) RETURN o.id AS id, o.metric AS metric, o.value AS value, o.asOf AS asOf, o.subject AS subject");

  const byId = new Map(rows.map((r) => [r.id, r]));
  const extra = new Set<string>();
  let timed: { turnId: string; events: { t: number; ev: Record<string, unknown> }[] } | undefined;
  if (timedPath) {
    timed = JSON.parse(readFileSync(timedPath, "utf8"));
    for (const { ev } of timed!.events) {
      if (ev.type === "path") for (const n of ev.nodes as { id: string }[]) extra.add(n.id);
    }
  }

  // the Sales sample: leads, deals, meetings and messages (the leads the inbox found, the calls booked)
  const sales = rows.filter((r) => { const t = typeOfLabels(r.labels); return t === "Lead" || t === "Deal" || t === "Meeting"; });
  const keep = new Set<string>([...KEEP_IDS, ...sales.map((s) => s.id), ...[...extra].filter((id) => byId.has(id) && KEEP_IDS.has(id))]);
  const missing = [...extra].filter((id) => !keep.has(id));
  if (missing.length) console.log("path nodes not shown (not in the picture):", missing.join(", "));

  const nodes: N[] = [];
  for (const id of keep) {
    const r = byId.get(id);
    if (!r) { console.log("missing in graph:", id); continue; }
    const type = typeOfLabels(r.labels) ?? "Entity";
    // What a website gives: the business, its people, channels, audience and the features it lists. Everything else
    // arrives from a tool or a file, by the source the graph records for it.
    let wave: N["wave"] = "site";
    if (type === "Lead" || type === "Deal") wave = "gmail";
    else if (type === "Meeting") wave = "calendar";
    else if (type === "Business" || type === "Person" || type === "Team" || type === "Channel" || type === "Audience") wave = "site";
    else if (WAVE_OF_SRC[id]) wave = WAVE_OF_SRC[id] as N["wave"];
    else if (r.src && WAVE_OF_SRC[r.src]) wave = WAVE_OF_SRC[r.src] as N["wave"];
    const label = LABEL[id] ?? (type === "Lead" ? (r.name ?? "Lead").split(" ")[0]! : type === "Deal" ? "Deal" : type === "Meeting" ? "Call" : (r.name ?? id));
    const name = (r.name ?? id).replace(/\s*\(synthetic demo\)/i, "");
    const labelled = id in LABEL;
    const r0 = type === "Business" ? 11 : type === "Document" ? 5 : type === "Event" || type === "Feature" || type === "Page" || type === "Channel" ? 7 : 6;
    nodes.push({ id, type, label, name, group: type, wave, x: 0, y: 0, r: r0, deg: 0, order: 0, labelled });
  }
  const ids = new Set(nodes.map((n) => n.id));

  // every real edge between the things shown (the source links from a thing to its document are drawn as "from")
  const edges = allEdges.filter((e) => ids.has(e.a) && ids.has(e.b) && e.a !== e.b);
  const seen = new Set<string>();
  const uniq = edges.filter((e) => { const k = `${e.a}|${e.t}|${e.b}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const e of uniq) { nodes.find((n) => n.id === e.a)!.deg++; nodes.find((n) => n.id === e.b)!.deg++; }
  for (const n of nodes) n.r = Math.round((n.r + Math.min(4, n.deg * 0.35)) * 10) / 10;

  // funnel readings: the real daily numbers behind each funnel step
  const spark: Record<string, { day: string; v: number }[]> = {};
  for (const o of obs) {
    if (o.metric !== "funnel_users" || o.value == null || !o.asOf) continue;
    const m = /feature:[a-z0-9-]+/.exec(o.id);
    if (!m) continue;
    (spark[m[0]] ??= []).push({ day: String(o.asOf).slice(0, 10), v: o.value });
  }
  for (const k of Object.keys(spark)) spark[k]!.sort((a, b) => (a.day < b.day ? -1 : 1));
  const readings = Object.values(spark).reduce((s, a) => s + a.length, 0);

  place(nodes);

  // the order things appear in: from the business outward (breadth first) inside each wave
  const adj = new Map<string, string[]>();
  for (const e of uniq) { (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b); (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a); }
  const root = "business:shiftly";
  const dist = new Map<string, number>([[root, 0]]);
  const q = [root];
  while (q.length) { const c = q.shift()!; for (const nx of adj.get(c) ?? []) if (!dist.has(nx)) { dist.set(nx, dist.get(c)! + 1); q.push(nx); } }
  for (const wave of ["site", "analytics", "ads", "gmail", "calendar", "files"] as const) {
    const w = nodes.filter((n) => n.wave === wave).sort((a, b) => (dist.get(a.id) ?? 9) - (dist.get(b.id) ?? 9) || hash(a.id) - hash(b.id));
    w.forEach((n, i) => { n.order = w.length > 1 ? i / (w.length - 1) : 0; });
  }

  // the run
  let run: unknown;
  if (timed) run = summariseRun(timed, ids);

  const data = {
    tenant: TENANT, note: "Sample business (Shiftly): synthetic data from the real graph of demo_growth. Positions are a seeded layout.",
    box: { w: W, h: H },
    docks: DOCK,
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, name: n.name, wave: n.wave, x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10, r: n.r, order: Math.round(n.order * 1000) / 1000, labelled: n.labelled })),
    edges: uniq.map((e) => ({ a: e.a, b: e.b, t: e.t })),
    spark,
    counts: { nodes: nodes.length, edges: uniq.length, readings },
    run,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data));
  console.log(`brain: ${nodes.length} things, ${uniq.length} links, ${readings} readings -> ${OUT}`);
  console.log("by wave:", JSON.stringify(nodes.reduce<Record<string, number>>((m, n) => ({ ...m, [n.wave]: (m[n.wave] ?? 0) + 1 }), {})));
  await closeAll();
}

/** The run, reduced to what the page draws: who worked, when, which things they read, the path, the answer. */
function summariseRun(timed: { turnId: string; doneAt?: number; events: { t: number; ev: Record<string, unknown> }[] }, shown: Set<string>) {
  const steps: { t: number; kind: string; agent?: string; text?: string; ids?: string[]; tool?: string }[] = [];
  let path: { nodes: string[]; edges: { from: string; to: string; type: string }[] } | undefined;
  let answer = "";
  let first = Infinity;
  for (const { t, ev } of timed.events) {
    const type = ev.type as string;
    if (type === "session") first = Math.min(first, t);
    if (type === "plan") steps.push({ t, kind: "plan", agent: ev.by as string, text: String(ev.rationale ?? "") });
    if (type === "agent_start") steps.push({ t, kind: "start", agent: ev.agent as string, text: String(ev.task ?? "") });
    if (type === "tool_result") {
      const ids = ((ev.nodes as { id: string }[]) ?? []).map((n) => n.id).filter((id) => shown.has(id));
      steps.push({ t, kind: "read", agent: ev.agent as string, tool: String(ev.name), text: String(ev.summary ?? ""), ids });
    }
    if (type === "handoff") steps.push({ t, kind: "handoff", agent: ev.from as string, text: String(ev.to) });
    if (type === "finding") steps.push({ t, kind: "finding", agent: ev.agent as string, text: String(ev.text ?? "") });
    if (type === "agent_done") steps.push({ t, kind: "done", agent: ev.agent as string });
    if (type === "path") path = { nodes: (ev.nodes as { id: string }[]).map((n) => n.id), edges: (ev.edges as { from: string; to: string; type: string }[]).map((e) => ({ from: e.from, to: e.to, type: e.type })) };
    if (type === "final") answer = String(ev.answer ?? "");
  }
  return { turnId: timed.turnId, doneAt: timed.doneAt, start: Number.isFinite(first) ? first : 0, steps, path, answer };
}

await main();
