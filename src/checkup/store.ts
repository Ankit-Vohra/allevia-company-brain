// The website check-up in the company graph, with provenance:
//   - one Document {kind:'report', checkup:'website'} per run: the top five and every fix as JSON, the scores, which
//     pages and tools were used. It is the source (`src`) of everything below.
//   - Rules {kind:'website-check'} for each fix, in the "Allevia website check-up" Playbook (written once, idempotent).
//   - Page -FAILS {evidence, impact, tier}-> Rule for each fix and each page it was found on (a site-wide fix hangs off
//     the website Channel). A fix that is gone on the next run has its FAILS edge closed (run.ts), so history shows when
//     it was fixed.
//   - Observations on the website Channel (and each Lighthouse page) for the numbers: mobile speed, desktop speed, easy
//     to use, Google basics, the lab Core Web Vitals, and the number of fixes. Re-runs add readings, and progress()
//     compares the latest two: "Your mobile speed went from 41 to 78".
import type { EdgeInput, NodeInput, ObservationInput } from "../graph/upsert.js";
import { channelId, channelNode } from "../ingest/sources/channels.js";
import type { GraphWrite } from "../ingest/types.js";
import { entityId } from "../util/ids.js";
import { FIXES, type CheckupVerdict, type Fix } from "./fixes.js";
import type { LighthouseResult } from "./lighthouse.js";

export const CHECKUP_PLAYBOOK = entityId("Playbook", "allevia website checkup");
export const checkupRuleId = (key: string): string => entityId("Rule", `allevia website checkup ${key}`);
export const checkupDocId = (host: string, asOf: string): string => entityId("Document", `website checkup ${host} ${asOf}`);
export const pageNodeId = (url: string): string => entityId("Page", url);

// The numbers a check-up records, with the owner's word for each (the owner never reads the metric key).
export const CHECKUP_METRICS = {
  checkup_mobile_speed: { label: "mobile speed", unit: "/100", better: "up" },
  checkup_desktop_speed: { label: "desktop speed", unit: "/100", better: "up" },
  checkup_easy_to_use: { label: "easy to use", unit: "/100", better: "up" },
  checkup_google_basics: { label: "Google basics", unit: "/100", better: "up" },
  checkup_best_practices: { label: "safety and good practice", unit: "/100", better: "up" },
  checkup_load_seconds_mobile: { label: "time until the main content shows on a phone", unit: "s", better: "down" },
  checkup_layout_shift_mobile: { label: "page jumping while it loads", unit: "", better: "down" },
  checkup_blocking_ms_mobile: { label: "time the phone page is frozen while loading", unit: "ms", better: "down" },
  checkup_fixes: { label: "fixes found", unit: "", better: "down" },
  checkup_top_impact: { label: "impact of the biggest fix", unit: "/100", better: "down" },
} as const;
export type CheckupMetric = keyof typeof CHECKUP_METRICS;

export function checkupRulesWrite(): GraphWrite {
  const nodes: NodeInput[] = [
    { type: "Playbook", id: CHECKUP_PLAYBOOK, name: "Allevia website check-up",
      summary: "What Allevia checks on a small business's website, ranked by how likely each problem is to cost enquiries: a way to get in touch on the first screen of a phone, a clear offer, proof, speed on phones, and the search basics.",
      props: { source: "allevia" } },
    channelNode("website"),
  ];
  const edges: EdgeInput[] = [{ from: CHECKUP_PLAYBOOK, type: "APPLIES_TO", to: channelId("website") }];
  for (const f of FIXES) {
    const id = checkupRuleId(f.key);
    const title = f.title(1);
    nodes.push({ type: "Rule", id, name: `Website check-up: ${title}`, summary: `${title}. ${f.why}`,
      props: { kind: "website-check", source: "allevia", issueType: f.key, title, text: f.why, howToFix: f.what || title, baseImpact: f.base, who: f.who } });
    edges.push({ from: CHECKUP_PLAYBOOK, type: "INCLUDES", to: id }, { from: id, type: "APPLIES_TO", to: channelId("website") });
  }
  return { nodes, edges, observations: [] };
}

export interface CheckupRun {
  origin: string;
  asOf: string;                 // ISO timestamp of the run (several runs a day stay apart)
  verdict: CheckupVerdict;
  lighthouse: LighthouseResult[];
  pagesChecked: string[];       // crawled page URLs
  conversionPages: string[];    // pages read at phone and desktop size
  notes: string[];              // what could not be checked, plainly
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const slim = (f: Fix) => ({ key: f.key, title: f.title, what: f.what, why: f.why, who: f.who, effort: f.effort, impact: f.impact, tier: f.tier,
  pages: f.pages, pageCount: f.pageCount, evidence: f.evidence.slice(0, 6).map((e) => clip(e, 300)) });

/** The fixes, the scores and the report Document as a GraphWrite. Every edge and reading cites the Document. */
export function checkupWrite(run: CheckupRun): GraphWrite {
  const host = new URL(run.origin).hostname;
  const doc = checkupDocId(host, run.asOf);
  const v = run.verdict;
  const s = v.scores;
  const nodes: NodeInput[] = [{
    type: "Document", id: doc, name: `Website check-up of ${host}, ${run.asOf.slice(0, 10)}`, asOf: run.asOf,
    summary: clip(`Top fixes: ${v.top.map((f, i) => `${i + 1}. ${f.title}`).join("; ") || "none"}.`, 900),
    props: {
      kind: "report", checkup: "website", title: `Website check-up, ${run.asOf.slice(0, 10)}`, url: run.origin, businessKind: v.kind,
      top: JSON.stringify(v.top.map(slim)), all: clip(JSON.stringify(v.all.map(slim)), 60_000),
      fixKeys: v.all.map((f) => f.key), fixTitles: v.all.map((f) => `${f.key}|${f.title}`),
      good: v.good, notes: run.notes, pagesChecked: run.pagesChecked.length, conversionPages: run.conversionPages,
      lighthousePages: [...new Set(run.lighthouse.filter((r) => !r.error).map((r) => r.url))],
      lighthouseVersion: run.lighthouse.find((r) => r.version)?.version ?? "",
    },
  }];
  const site = channelId("website");
  const edges: EdgeInput[] = [];
  const seenPages = new Set<string>();
  for (const f of v.all) {
    const to = checkupRuleId(f.key);
    const props = { evidence: clip(f.evidence.join(" | "), 400), impact: f.impact, tier: f.tier, severity: f.tier === "losing enquiries" ? "critical" : f.tier === "tidy-up" ? "info" : "warning" };
    if (!f.urls.length) {
      edges.push({ from: site, type: "FAILS", to, src: doc, asOf: run.asOf, props });
      continue;
    }
    for (const url of f.urls) {
      const pid = pageNodeId(url);
      if (!seenPages.has(pid)) {
        seenPages.add(pid);
        const u = new URL(url);
        nodes.push({ type: "Page", id: pid, name: u.pathname, props: { url, path: u.pathname + u.search } });
        edges.push({ from: pid, type: "PART_OF", to: site, src: doc, asOf: run.asOf });
      }
      edges.push({ from: pid, type: "FAILS", to, src: doc, asOf: run.asOf, props });
    }
  }
  const home = pageNodeId(`${run.origin}/`);
  if (!seenPages.has(home)) {
    nodes.push({ type: "Page", id: home, name: "/", props: { url: `${run.origin}/`, path: "/" } });
    edges.push({ from: home, type: "PART_OF", to: site, src: doc, asOf: run.asOf });
  }
  edges.push({ from: doc, type: "LINKS_TO_PAGE", to: home, src: doc, asOf: run.asOf });

  const observations: ObservationInput[] = [];
  const obs = (subject: string, metric: CheckupMetric, value: number | undefined, evidence: string) => {
    if (value === undefined || !Number.isFinite(value)) return;
    observations.push({ subject, metric, value, unit: CHECKUP_METRICS[metric].unit || undefined, asOf: run.asOf, src: doc, evidence });
  };
  const lab = "Lighthouse lab test on a simulated mid-range phone over slow 4G";
  obs(site, "checkup_mobile_speed", s.mobileSpeed, `Home page, ${lab}`);
  obs(site, "checkup_desktop_speed", s.desktopSpeed, "Home page, Lighthouse desktop test");
  obs(site, "checkup_easy_to_use", s.accessibility, "Home page on a phone, Lighthouse accessibility score");
  obs(site, "checkup_google_basics", s.googleBasics, "Home page on a phone, Lighthouse SEO score");
  obs(site, "checkup_best_practices", s.bestPractices, "Home page on a phone, Lighthouse best-practices score");
  obs(site, "checkup_load_seconds_mobile", s.lcpMs === undefined ? undefined : Math.round(s.lcpMs / 100) / 10, `Largest contentful paint, ${lab}`);
  obs(site, "checkup_layout_shift_mobile", s.cls, `Cumulative layout shift, ${lab}`);
  obs(site, "checkup_blocking_ms_mobile", s.tbtMs, `Total blocking time, ${lab}`);
  obs(site, "checkup_fixes", v.all.length, `${v.all.length} fixes found across ${run.pagesChecked.length} pages`);
  obs(site, "checkup_top_impact", v.top[0]?.impact ?? 0, v.top[0] ? `Biggest fix: ${v.top[0].title}` : "No fixes found");
  for (const r of run.lighthouse) {
    if (r.error || r.strategy !== "mobile" || r.url === `${run.origin}/`) continue;
    const pid = pageNodeId(r.url);
    if (!seenPages.has(pid)) {
      seenPages.add(pid);
      const u = new URL(r.url);
      nodes.push({ type: "Page", id: pid, name: u.pathname, props: { url: r.url, path: u.pathname + u.search } });
      edges.push({ from: pid, type: "PART_OF", to: site, src: doc, asOf: run.asOf });
    }
    obs(pid, "checkup_mobile_speed", r.scores.performance, `${new URL(r.url).pathname}, ${lab}`);
  }
  return { nodes, edges, observations };
}

// ---------- progress ----------

export interface Reading { metric: string; value: number; asOf: string }
export interface Progress { lines: string[]; fixed: string[]; newFixes: string[]; previousAsOf?: string }

const fmt = (metric: CheckupMetric, v: number) => {
  const u = CHECKUP_METRICS[metric].unit;
  return u === "s" ? `${v} s` : u === "ms" ? `${Math.round(v)} ms` : String(Math.round(v * 1000) / 1000);
};

/**
 * What changed since the previous check-up, in plain words. `prev` and `cur` are the website channel's readings of
 * each run; `prevFixes`/`curFixes` are the runs' "key|title" lists. A change smaller than the noise of a lab test
 * (5 points of a score, 0.3 s, 0.05 of layout shift, 100 ms) is not reported.
 */
export function progress(prev: Reading[], cur: Reading[], prevFixes: string[], curFixes: string[], previousAsOf?: string): Progress {
  const lines: string[] = [];
  const min: Partial<Record<CheckupMetric, number>> = {
    checkup_mobile_speed: 5, checkup_desktop_speed: 5, checkup_easy_to_use: 5, checkup_google_basics: 5, checkup_best_practices: 5,
    checkup_load_seconds_mobile: 0.3, checkup_layout_shift_mobile: 0.05, checkup_blocking_ms_mobile: 100,
  };
  const p = new Map(prev.map((r) => [r.metric, r.value]));
  for (const r of cur) {
    const m = r.metric as CheckupMetric;
    const threshold = min[m];
    const before = p.get(m);
    if (threshold === undefined || before === undefined || Math.abs(r.value - before) < threshold) continue;
    const def = CHECKUP_METRICS[m];
    const better = def.better === "up" ? r.value > before : r.value < before;
    lines.push(`Your ${def.label} went from ${fmt(m, before)} to ${fmt(m, r.value)}${better ? "" : " (worse)"}.`);
  }
  const title = (x: string) => x.slice(x.indexOf("|") + 1);
  const key = (x: string) => x.slice(0, x.indexOf("|"));
  const curKeys = new Set(curFixes.map(key));
  const prevKeys = new Set(prevFixes.map(key));
  const fixed = prevFixes.filter((x) => !curKeys.has(key(x))).map(title);
  const newFixes = curFixes.filter((x) => !prevKeys.has(key(x))).map(title);
  if (fixed.length) lines.push(`Fixed since the last check-up: ${fixed.slice(0, 5).join("; ")}${fixed.length > 5 ? ` and ${fixed.length - 5} more` : ""}.`);
  if (newFixes.length && prevFixes.length) lines.push(`New since the last check-up: ${newFixes.slice(0, 3).join("; ")}${newFixes.length > 3 ? ` and ${newFixes.length - 3} more` : ""}.`);
  return { lines, fixed, newFixes, ...(previousAsOf ? { previousAsOf } : {}) };
}
