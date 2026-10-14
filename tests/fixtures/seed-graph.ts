// A small Aamdani-like company graph that exercises every agent tool: decisions with evidence and a superseded
// predecessor, tasks with a reassigned owner and a Version, a DEPENDS_ON chain with one closed edge, documents with
// chunks, reels with view observations and hook rules, pages failing SEO rules with Search Console numbers, simulated
// ad campaigns, a past Turn with a Memory and an open Recommendation, and KNOWS_ABOUT/AUTHORED for "who knows".
// Everything goes through upsertNode/upsertEdge/addObservation, the same path ingestion uses.
import type { GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes, VECTOR_DIM } from "../../src/graph/indexes.js";
import { SEARCHABLE, type EntityType, type RelType } from "../../src/graph/schema.js";
import { addObservation, closeEdge, upsertEdge, upsertNode, type ObservationInput, type Prim } from "../../src/graph/upsert.js";

export const D = (iso: string): number => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
export const SEED_NOW = D("2026-10-15T00:00:00Z"); // the ToolContext.now tests use

// Deterministic stand-in for e5 embeddings: hashed bag of (crudely stemmed) words, L2-normalised. Texts that share
// words are close; texts that share none are orthogonal.
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(VECTOR_DIM).fill(0);
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    const w = raw.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % VECTOR_DIM]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

interface N { type: EntityType; id: string; name: string; summary?: string; props?: Record<string, Prim>; src?: string; asOf?: string; simulated?: boolean }

export async function seedMini(g: GraphHandle): Promise<void> {
  await ensureIndexes(g);
  const t0 = D("2026-08-01");
  const node = async (n: N, at = t0) => {
    const text = n.type === "Chunk" ? String(n.props?.text ?? "") : `${n.name} ${n.summary ?? ""}`;
    const embed = n.type === "Chunk" || SEARCHABLE.includes(n.type);
    await upsertNode(g, { ...n, ...(embed ? { embedding: fakeEmbed(text) } : {}) }, at);
  };
  const edge = async (from: string, type: RelType, to: string, opts: { since?: number; props?: Record<string, Prim>; src?: string } = {}) => {
    await upsertEdge(g, { from, type, to, ...opts }, opts.since ?? t0);
  };
  const obs = async (o: ObservationInput) => addObservation(g, o, D(o.asOf));

  // ---- documents (sources) and their chunks ----
  const docs: Array<[string, string, string, string]> = [
    ["document:adr-007", "ADR 007: Pause daily stories", "decision", "2026-09-20"],
    ["document:adr-003", "ADR 003: Post daily stories", "decision", "2026-08-01"],
    ["document:ig-insights-sep", "Instagram insights, September 2026", "report", "2026-09-30"],
    ["document:ig-insights-oct", "Instagram insights export, 10 Oct", "report", "2026-10-10"],
    ["document:gsc-oct", "Search Console export, Oct 2026", "report", "2026-10-10"],
    ["document:pending", "PENDING.md", "vault", "2026-10-12"],
    ["document:systems-notes", "Systems map", "vault", "2026-10-01"],
    ["document:runbook", "Publisher runbook", "vault", "2026-10-02"],
    ["document:meta-ads-sim", "Meta Ads export (simulated)", "simulated", "2026-10-14"],
    ["document:hook-playbook", "Reel hooks playbook", "playbook", "2026-08-15"],
    ["document:seo-checklist", "SEO checklist", "playbook", "2026-08-15"],
  ];
  for (const [id, title, kind, asOf] of docs) await node({ type: "Document", id, name: title, props: { kind, title }, asOf });
  const chunks: Array<[string, string, number, string]> = [
    ["document:adr-007", "chunk:adr-007:0", 0, "We pause daily Instagram stories. Reels drove 4x more signups per hour of effort than stories in September."],
    ["document:adr-007", "chunk:adr-007:1", 1, "Stories took 40 minutes a day and brought almost no profile visits. The time moves to two reels a week with tested hooks."],
    ["document:adr-003", "chunk:adr-003:0", 0, "Post an Instagram story every day to stay visible to job seekers in Raipur."],
    ["document:ig-insights-sep", "chunk:ig-insights-sep:0", 0, "The salary reveal reel reached 48,000 accounts; reels brought 55 signups in September."],
    ["document:pending", "chunk:pending:0", 0, "Fix the Instagram token refresh in the connector before scheduling more reels."],
    ["document:systems-notes", "chunk:systems-notes:0", 0, "The reel publisher depends on the Instagram connector; the scheduler depends on the publisher."],
  ];
  for (const [doc, id, ord, text] of chunks) {
    await node({ type: "Chunk", id, name: `${docs.find((d) => d[0] === doc)![1]} §${ord}`, props: { text, ord } });
    await edge(doc, "HAS_CHUNK", id);
  }

  // ---- company ----
  await node({ type: "Business", id: "business:aamdani", name: "Aamdani", summary: "Hyperlocal jobs platform for Raipur", props: { city: "Raipur" } });
  await node({ type: "Person", id: "person:founder", name: "Ankit", summary: "Founder of Aamdani", props: { role: "founder" } });
  await node({ type: "Person", id: "person:priya", name: "Priya", summary: "Marketing associate", props: { role: "marketing" } });
  await node({ type: "Agent", id: "agent:jarvis", name: "Jarvis", summary: "The founder's ops agent", props: { kind: "assistant" } });
  await node({ type: "Agent", id: "agent:allevia-librarian", name: "Sara", summary: "Allevia librarian", props: { kind: "allevia" } });
  await node({ type: "Agent", id: "agent:allevia-content-strategist", name: "Tara", summary: "Allevia content strategist", props: { kind: "allevia" } });
  await node({ type: "Team", id: "team:marketing", name: "Marketing team" });
  await node({ type: "Team", id: "team:tech", name: "Tech team" });
  await edge("person:priya", "MEMBER_OF", "team:marketing");
  await edge("agent:jarvis", "MEMBER_OF", "team:tech");
  await edge("person:founder", "MEMBER_OF", "business:aamdani");

  // ---- channels ----
  for (const [id, name, platform] of [
    ["channel:instagram", "Instagram", "instagram"], ["channel:website", "Website", "web"],
    ["channel:google-search", "Google Search", "google"], ["channel:meta-ads", "Meta Ads", "meta"],
  ] as const) await node({ type: "Channel", id, name, props: { platform, status: "active" } });
  await edge("channel:instagram", "PART_OF", "business:aamdani");
  await edge("team:tech", "OWNS", "channel:website");

  // ---- decisions: 007 supersedes 003, based on an observation and a report ----
  await node({ type: "Decision", id: "decision:003-daily-stories", name: "Post daily Instagram stories", summary: "Post a story every day to stay visible",
    props: { status: "superseded", decidedAt: "2026-08-01" }, src: "document:adr-003", asOf: "2026-08-01" });
  await node({ type: "Decision", id: "decision:007-pause-daily-stories", name: "Pause daily stories", summary: "Pause daily stories and put the time into two reels a week",
    props: { status: "accepted", decidedAt: "2026-09-20" }, src: "document:adr-007", asOf: "2026-09-20" });
  await edge("decision:003-daily-stories", "SOURCED_FROM", "document:adr-003");
  await edge("decision:007-pause-daily-stories", "SOURCED_FROM", "document:adr-007");
  await edge("decision:007-pause-daily-stories", "SUPERSEDES", "decision:003-daily-stories", { since: D("2026-09-20") });
  await edge("person:founder", "DECIDED", "decision:003-daily-stories", { props: { at: "2026-08-01" } });
  await edge("person:founder", "DECIDED", "decision:007-pause-daily-stories", { since: D("2026-09-20"), props: { at: "2026-09-20" } });
  await edge("decision:007-pause-daily-stories", "AFFECTS", "channel:instagram", { since: D("2026-09-20") });
  const reelSignups = await obs({ subject: "channel:instagram", metric: "signups_from_reels", value: 55, unit: "signups",
    windowStart: "2026-09-01", windowEnd: "2026-09-30", asOf: "2026-09-30", src: "document:ig-insights-sep" });
  await edge("decision:007-pause-daily-stories", "BASED_ON", reelSignups, { since: D("2026-09-20") });
  await edge("decision:007-pause-daily-stories", "BASED_ON", "document:ig-insights-sep", { since: D("2026-09-20") });

  // ---- tasks: one reassigned (founder -> Priya), one with a status Version ----
  await node({ type: "Task", id: "task:fix-ig-token", name: "Fix Instagram token refresh", props: { status: "open", kind: "pending" },
    src: "document:pending", asOf: "2026-09-25" }, D("2026-09-25"));
  await node({ type: "Task", id: "task:fix-ig-token", name: "Fix Instagram token refresh", props: { status: "in_progress", kind: "pending" },
    src: "document:pending", asOf: "2026-10-12" }, D("2026-10-06"));
  await edge("task:fix-ig-token", "SOURCED_FROM", "document:pending");
  await edge("person:founder", "OWNS", "task:fix-ig-token", { since: D("2026-09-25") });
  await edge("person:priya", "OWNS", "task:fix-ig-token", { since: D("2026-10-05") }); // closes the founder's edge
  await node({ type: "Task", id: "task:schedule-reels", name: "Schedule two reels a week", props: { status: "open" }, src: "document:adr-007" });
  await edge("team:marketing", "OWNS", "task:schedule-reels");
  await edge("task:fix-ig-token", "BLOCKS", "task:schedule-reels");
  await node({ type: "Task", id: "task:fix-sitemap", name: "Fix sitemap errors", props: { status: "open" }, src: "document:pending" });
  await edge("person:founder", "OWNS", "task:fix-sitemap");

  // ---- systems: scheduler -> publisher -> connector, instagram -> connector; a legacy edge that was closed ----
  for (const [id, name] of [
    ["system:ig-connector", "Instagram connector"], ["system:reel-publisher", "Reel publisher"],
    ["system:reel-scheduler", "Reels scheduler"], ["system:legacy-poster", "Legacy story poster"],
  ] as const) {
    await node({ type: "System", id, name, props: { kind: "service", status: "running" }, src: "document:systems-notes", asOf: "2026-10-01" });
    await edge(id, "SOURCED_FROM", "document:systems-notes");
  }
  await edge("system:reel-publisher", "DEPENDS_ON", "system:ig-connector");
  await edge("system:reel-scheduler", "DEPENDS_ON", "system:reel-publisher");
  await edge("channel:instagram", "DEPENDS_ON", "system:ig-connector");
  await edge("system:ig-connector", "BLOCKS", "task:schedule-reels");
  await edge("system:legacy-poster", "DEPENDS_ON", "system:ig-connector");
  await closeEdge(g, "system:legacy-poster", "DEPENDS_ON", "system:ig-connector", D("2026-09-01"), "retired");
  await edge("team:tech", "OWNS", "system:ig-connector");
  await edge("team:tech", "OWNS", "system:reel-publisher");
  await node({ type: "Event", id: "event:ig-api-outage", name: "Instagram API outage", props: { kind: "outage", at: "2026-10-03" } });
  await edge("event:ig-api-outage", "AFFECTS", "system:ig-connector");

  // ---- knowledge: who knows what, who wrote what, and two tight topic clusters ----
  await edge("person:founder", "KNOWS_ABOUT", "channel:instagram", { props: { weight: 5 } });
  await edge("person:priya", "KNOWS_ABOUT", "channel:instagram", { props: { weight: 2 } });
  await edge("agent:jarvis", "KNOWS_ABOUT", "system:ig-connector", { props: { weight: 3 } });
  await edge("person:founder", "AUTHORED", "document:adr-007");
  await edge("person:founder", "AUTHORED", "document:adr-003");
  await edge("person:priya", "AUTHORED", "document:ig-insights-sep");
  await edge("agent:jarvis", "AUTHORED", "document:systems-notes");
  for (const d of ["document:adr-007", "document:adr-003", "document:ig-insights-sep"]) await edge(d, "MENTIONS", "channel:instagram");
  await edge("document:adr-007", "LINKS_TO", "document:adr-003");
  await edge("document:adr-007", "LINKS_TO", "document:ig-insights-sep");
  await edge("document:adr-003", "LINKS_TO", "document:ig-insights-sep");
  for (const d of ["document:systems-notes", "document:runbook"]) {
    await edge(d, "MENTIONS", "system:ig-connector");
    await edge(d, "MENTIONS", "system:reel-publisher");
  }
  await edge("document:runbook", "LINKS_TO", "document:systems-notes");

  // ---- content: reels with hooks, audiences and view observations ----
  await node({ type: "Audience", id: "audience:job-seekers", name: "Job seekers in Raipur" });
  await node({ type: "Audience", id: "audience:employers", name: "Small employers" });
  await node({ type: "Playbook", id: "playbook:reel-hooks", name: "Reel hooks", props: { source: "internal", license: "own" }, src: "document:hook-playbook" });
  await node({ type: "Rule", id: "rule:hook-curiosity-gap", name: "Curiosity gap hook", summary: "Open with a question the viewer must see answered",
    props: { kind: "hook", text: "Open with a question the viewer must see answered.", template: "I asked {n} {people} about {topic}. Number {k} surprised me.",
      example: "I asked 10 delivery riders in Raipur what they earn.", rank: 0.9 }, src: "document:hook-playbook" });
  await node({ type: "Rule", id: "rule:hook-listicle", name: "Numbered list hook", summary: "Promise a numbered list in the first second",
    props: { kind: "hook", text: "Promise a numbered list in the first second.", template: "{n} {mistakes} that {consequence}", rank: 0.4 }, src: "document:hook-playbook" });
  for (const r of ["rule:hook-curiosity-gap", "rule:hook-listicle"]) await edge("playbook:reel-hooks", "INCLUDES", r);
  await edge("playbook:reel-hooks", "APPLIES_TO", "channel:instagram");
  const reels: Array<[string, string, string, string, string, number]> = [
    ["content:reel-salary-reveal", "Salary reveal: what a Raipur delivery job pays", "2026-09-05", "rule:hook-curiosity-gap", "audience:job-seekers", 48000],
    ["content:reel-interview-mistakes", "3 interview mistakes", "2026-09-12", "rule:hook-listicle", "audience:job-seekers", 6000],
    ["content:reel-hire-24h", "Hire in 24 hours", "2026-09-19", "rule:hook-listicle", "audience:employers", 4000],
    ["content:reel-store-manager", "Day in the life of a store manager", "2026-09-26", "rule:hook-curiosity-gap", "audience:job-seekers", 9000],
    ["content:reel-old-hiring", "Hiring is hard (old)", "2026-07-01", "rule:hook-listicle", "audience:employers", 3000],
  ];
  for (const [id, name, publishedAt, rule, aud, views] of reels) {
    await node({ type: "Content", id, name, props: { format: "reel", publishedAt, caption: `${name} #raipurjobs` }, src: "document:ig-insights-oct", asOf: "2026-10-10" });
    await edge(id, "PUBLISHED_ON", "channel:instagram");
    await edge(id, "USES_RULE", rule);
    await edge(id, "TARGETS", aud);
    await obs({ subject: id, metric: "views", value: views, unit: "count", windowEnd: "2026-10-10", asOf: "2026-10-10", src: "document:ig-insights-oct" });
  }
  await obs({ subject: "content:reel-salary-reveal", metric: "views", value: 30000, unit: "count", windowEnd: "2026-09-10", asOf: "2026-09-10", src: "document:ig-insights-sep" });
  for (const [metric, value] of [["shares", 900], ["saves", 1500], ["avg_watch_s", 11.2], ["skip_rate", 0.31]] as const) {
    await obs({ subject: "content:reel-salary-reveal", metric, value, windowEnd: "2026-10-10", asOf: "2026-10-10", src: "document:ig-insights-oct" });
  }
  await edge("document:ig-insights-sep", "MENTIONS", "content:reel-salary-reveal");

  // ---- metric series: weekly followers, daily signups ----
  const weeks = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
  const followers = [1000, 1080, 1150, 1260, 1400];
  for (const [i, day] of weeks.entries()) {
    await obs({ subject: "channel:instagram", metric: "followers", value: followers[i]!, unit: "count", windowEnd: day, asOf: day, src: "document:ig-insights-oct" });
  }
  for (let d = 1; d <= 10; d++) {
    const day = `2026-10-${String(d).padStart(2, "0")}`;
    await obs({ subject: "business:aamdani", metric: "signups", value: d + 4, unit: "count", windowStart: day, windowEnd: day, asOf: day, src: "document:ig-insights-oct" });
  }

  // ---- website / SEO ----
  await node({ type: "Playbook", id: "playbook:seo-basics", name: "SEO basics", src: "document:seo-checklist" });
  await node({ type: "Rule", id: "rule:seo-meta-description", name: "Meta description present", summary: "Every indexable page needs a meta description",
    props: { kind: "seo_check", severity: "high", text: "Every indexable page needs a 140-160 character meta description.",
      howToFix: "Write a unique meta description that names the city and the job type.", rank: 0.6 }, src: "document:seo-checklist" });
  await node({ type: "Rule", id: "rule:seo-h1", name: "One H1 per page", summary: "Exactly one H1 per page",
    props: { kind: "seo_check", severity: "medium", text: "Exactly one H1 per page.", howToFix: "Keep one H1 that matches the search intent.", rank: 0.3 }, src: "document:seo-checklist" });
  for (const r of ["rule:seo-meta-description", "rule:seo-h1"]) await edge("playbook:seo-basics", "INCLUDES", r);
  await edge("playbook:seo-basics", "APPLIES_TO", "channel:website");
  const pages: Array<[string, string, string]> = [
    ["page:www.aamdani.ai/jobs", "Jobs in Raipur", "/jobs"],
    ["page:www.aamdani.ai", "Aamdani: jobs near you", "/"],
    ["page:www.aamdani.ai/blog/delivery-salary", "What delivery jobs pay in Raipur", "/blog/delivery-salary"],
  ];
  for (const [id, title, path] of pages) {
    await node({ type: "Page", id, name: title, props: { url: `https://${id.slice(5)}`, path, title }, src: "document:gsc-oct", asOf: "2026-10-10" });
    await edge(id, "PART_OF", "channel:website");
  }
  await edge("page:www.aamdani.ai/jobs", "FAILS", "rule:seo-meta-description", { props: { evidence: "no meta description" } });
  await edge("page:www.aamdani.ai/jobs", "FAILS", "rule:seo-h1", { props: { evidence: "2 H1 tags" } });
  await edge("page:www.aamdani.ai/blog/delivery-salary", "FAILS", "rule:seo-h1", { props: { evidence: "no H1" } });
  await node({ type: "Query", id: "query:jobs-in-raipur", name: "jobs in raipur", props: { text: "jobs in raipur" } });
  await edge("page:www.aamdani.ai/jobs", "RANKS_FOR", "query:jobs-in-raipur", { props: { position: 12 } });
  const gsc = (subject: string, metric: string, value: number) => obs({ subject, metric, value, windowStart: "2026-09-12", windowEnd: "2026-10-09", asOf: "2026-10-10", src: "document:gsc-oct" });
  await gsc("page:www.aamdani.ai/jobs", "clicks", 120);
  await gsc("page:www.aamdani.ai/jobs", "impressions", 9000);
  await gsc("page:www.aamdani.ai/jobs", "ctr", 0.0133);
  await gsc("page:www.aamdani.ai/jobs", "position", 14.2);
  await gsc("page:www.aamdani.ai/jobs", "sessions", 300);
  await gsc("page:www.aamdani.ai", "clicks", 20);
  await gsc("page:www.aamdani.ai", "impressions", 5000);
  await gsc("page:www.aamdani.ai", "ctr", 0.004);
  await gsc("page:www.aamdani.ai/blog/delivery-salary", "clicks", 40);
  await gsc("page:www.aamdani.ai/blog/delivery-salary", "impressions", 1500);

  // ---- simulated ads: employers CPA 300, seekers 50, retarget 150 (median 150) ----
  const camps: Array<[string, string, number[], number[]]> = [
    ["campaign:meta-employers", "Employers: hire in 24h", [1000, 1000, 1000], [3, 3, 4]],
    ["campaign:meta-seekers", "Seekers: Raipur jobs", [700, 650, 650], [13, 13, 14]],
    ["campaign:meta-retarget", "Retarget site visitors", [500, 500, 500], [3, 3, 4]],
  ];
  for (const [id, name, spend, signups] of camps) {
    await node({ type: "Campaign", id, name, props: { status: "active", objective: "leads" }, simulated: true, src: "document:meta-ads-sim", asOf: "2026-10-14" });
    await edge(id, "PUBLISHED_ON", "channel:meta-ads");
    for (let i = 0; i < 3; i++) {
      const day = `2026-10-1${i + 1}`;
      const base = { subject: id, windowStart: day, windowEnd: day, asOf: day, src: "document:meta-ads-sim", simulated: true };
      await obs({ ...base, metric: "spend", value: spend[i]!, unit: "INR" });
      await obs({ ...base, metric: "signups", value: signups[i]!, unit: "count" });
      await obs({ ...base, metric: "impressions", value: spend[i]! * 10, unit: "count" });
      await obs({ ...base, metric: "clicks", value: spend[i]! / 10, unit: "count" });
    }
  }

  // ---- episodic memory: one past turn, a fact and a preference, an open recommendation with a pending approval ----
  await node({ type: "Session", id: "session:s-001", name: "Thread about stories", props: { channel: "web", startedAt: D("2026-10-14T09:00:00Z") } });
  await node({ type: "Turn", id: "turn:t-001", name: "Why did we pause daily stories?", props: {
    question: "Why did we pause daily stories?",
    answer: `We paused daily stories on 20 Sep [[decision:007-pause-daily-stories]] because reels brought 55 signups in September. ${"Stories took time without results. ".repeat(12)}`,
    at: D("2026-10-14T09:00:00Z"), checks: JSON.stringify({ citationsValid: true }), agents: ["chief-of-staff", "librarian"] } });
  await edge("turn:t-001", "IN_SESSION", "session:s-001");
  await edge("person:founder", "ASKED", "turn:t-001");
  await edge("turn:t-001", "TOUCHED", "decision:007-pause-daily-stories");
  await edge("turn:t-001", "TOUCHED", "channel:instagram");
  await edge("turn:t-001", "CITED", "document:adr-007");
  await edge("turn:t-001", "HANDLED_BY", "agent:allevia-librarian");
  await node({ type: "Memory", id: "memory:t-001-1", name: "Daily stories stay paused until Diwali", props: { kind: "fact", text: "Daily stories stay paused until Diwali.", at: D("2026-10-14T09:05:00Z") }, src: "turn:t-001" });
  await edge("memory:t-001-1", "ABOUT", "decision:007-pause-daily-stories");
  await edge("person:founder", "STATED", "memory:t-001-1");
  await node({ type: "Memory", id: "memory:t-000-1", name: "Answer in Hinglish, numbers first", props: { kind: "preference", text: "Answer in Hinglish, numbers first.", at: D("2026-10-10T09:00:00Z") }, src: "turn:t-000" });
  await edge("memory:t-000-1", "ABOUT", "business:aamdani");
  await edge("person:founder", "STATED", "memory:t-000-1");
  await node({ type: "Recommendation", id: "recommendation:double-down-on-salary-reels", name: "Double down on salary reels",
    summary: "The salary reveal reel did 6x the median views", props: { status: "open", area: "content", confidence: 0.8, score: 0.8, by: "content-strategist" } });
  await node({ type: "Approval", id: "approval:t-001-1", name: "content_draft: Double down on salary reels", props: { status: "pending", kind: "content_draft", payload: "{}" } });
  await edge("recommendation:double-down-on-salary-reels", "EVIDENCED_BY", "content:reel-salary-reveal");
  await edge("recommendation:double-down-on-salary-reels", "EVIDENCED_BY", "rule:hook-curiosity-gap");
  await edge("recommendation:double-down-on-salary-reels", "PROPOSES", "approval:t-001-1");
  await edge("agent:allevia-content-strategist", "PRODUCED", "recommendation:double-down-on-salary-reels");
}
