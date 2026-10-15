// Lighthouse, run locally and free: the `lighthouse` npm package drives the Chromium Playwright already installed, one
// page and one form factor (mobile, desktop) at a time. A result is reduced to what the check-up needs: the four
// category scores (0-100), the lab Core Web Vitals, and the audits that fail, each with its estimated saving.
//
// Which audits count as issues, their severity and their order follow open-seo's Lighthouse reader
// (every-app/open-seo, MIT, src/server/lib/lighthouseStoredPayload.ts and lighthousePayload.ts; see NOTICE.md):
// numeric metrics and diagnostics are not issues, a score of 90+ passes, and an issue's severity comes from its time or
// byte saving first and its score second. `lhSeverity` and `sortLhIssues` are lifted from there and adapted.
//
// Lighthouse opens the page in a real browser, so the address is checked first (http(s), a public host, not a private
// or local address after DNS). The pages it opens are pages the crawler was allowed to read.
import { lookup } from "node:dns/promises";
import { BlockedUrlError, checkUrl } from "../ingest/sources/website/fetch.js";
import { isBlockedAddress } from "../ingest/sources/website/urls.js";

export type Strategy = "mobile" | "desktop";
export type LhCategory = "performance" | "accessibility" | "best-practices" | "seo";
export const LH_CATEGORIES: LhCategory[] = ["performance", "accessibility", "best-practices", "seo"];

export interface LhIssue {
  id: string;
  title: string;
  category: LhCategory;
  score: number | null;        // 0-100
  impactMs: number | null;
  impactBytes: number | null;
  severity: "critical" | "warning" | "info";
  displayValue?: string;
  items: string[];             // up to 5: a resource URL or an element's label
}

export interface LhMetrics {
  lcpMs?: number; cls?: number; tbtMs?: number; fcpMs?: number; speedIndexMs?: number; ttfbMs?: number;
}

export interface LighthouseResult {
  url: string;
  strategy: Strategy;
  scores: Partial<Record<LhCategory, number>>; // 0-100; a category Lighthouse could not score is absent
  metrics: LhMetrics;
  issues: LhIssue[];
  version?: string;
  fetchedAt?: string;
  error?: string;
}

// Audits that describe the page rather than say what to fix (open-seo's DIAGNOSTIC_AUDIT_KEYS).
const DIAGNOSTIC = new Set([
  "largest-contentful-paint-element", "layout-shifts", "diagnostics", "metrics", "network-requests", "network-rtt",
  "network-server-latency", "main-thread-tasks", "screenshot-thumbnails", "final-screenshot", "script-treemap-data",
  "resource-summary",
]);
const NOT_ISSUE_MODES = new Set(["numeric", "notApplicable", "informative", "manual", "error"]);

// Lifted from open-seo (MIT): critical when the fix saves 300 ms or 150 KB, or the audit scores under 50.
export function lhSeverity(input: { score: number | null; impactMs: number | null; impactBytes: number | null }): LhIssue["severity"] {
  if ((input.impactMs ?? 0) >= 300 || (input.impactBytes ?? 0) >= 150_000) return "critical";
  if (input.score != null && input.score < 50) return "critical";
  if ((input.impactMs ?? 0) >= 100 || (input.impactBytes ?? 0) >= 50_000) return "warning";
  if (input.score != null && input.score < 90) return "warning";
  return "info";
}

// Lifted from open-seo (MIT): the biggest saving first, then the lowest score.
export function sortLhIssues(issues: LhIssue[]): LhIssue[] {
  const key = (i: LhIssue) => (i.impactMs ?? 0) * 1000 + (i.impactBytes ?? 0);
  return [...issues].sort((a, b) => key(b) - key(a) || (a.score ?? 100) - (b.score ?? 100) || a.id.localeCompare(b.id));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// A Lighthouse result (lhr) reduced to a LighthouseResult. Tolerant: anything missing is left out, never invented.
export function parseLhr(lhr: unknown, strategy: Strategy, url: string): LighthouseResult {
  if (!isObj(lhr)) return { url, strategy, scores: {}, metrics: {}, issues: [], error: "Lighthouse returned nothing" };
  const cats = isObj(lhr.categories) ? lhr.categories : {};
  const audits = isObj(lhr.audits) ? lhr.audits : {};
  const scores: LighthouseResult["scores"] = {};
  for (const c of LH_CATEGORIES) {
    const s = isObj(cats[c]) ? num((cats[c] as Obj).score) : null;
    if (s !== null) scores[c] = Math.round(s * 100);
  }
  const metric = (id: string): number | undefined => {
    const a = audits[id];
    const v = isObj(a) ? num(a.numericValue) : null;
    return v === null ? undefined : v;
  };
  const metrics: LhMetrics = {};
  const set = (k: keyof LhMetrics, v: number | undefined, digits = 0) => {
    if (v !== undefined) metrics[k] = digits ? Math.round(v * 10 ** digits) / 10 ** digits : Math.round(v);
  };
  set("lcpMs", metric("largest-contentful-paint"));
  set("cls", metric("cumulative-layout-shift"), 3);
  set("tbtMs", metric("total-blocking-time"));
  set("fcpMs", metric("first-contentful-paint"));
  set("speedIndexMs", metric("speed-index"));
  set("ttfbMs", metric("server-response-time"));

  const issues: LhIssue[] = [];
  const seen = new Set<string>();
  for (const c of LH_CATEGORIES) {
    const refs = isObj(cats[c]) && Array.isArray((cats[c] as Obj).auditRefs) ? ((cats[c] as Obj).auditRefs as unknown[]) : [];
    for (const r of refs) {
      const id = isObj(r) && typeof r.id === "string" ? r.id : "";
      const a = audits[id];
      if (!id || seen.has(id) || DIAGNOSTIC.has(id) || !isObj(a)) continue;
      const mode = String(a.scoreDisplayMode ?? "");
      const raw = num(a.score);
      if (NOT_ISSUE_MODES.has(mode) || raw === null || raw >= 0.9) continue;
      seen.add(id);
      const d = isObj(a.details) ? a.details : {};
      const ms = isObj(a.metricSavings) ? a.metricSavings : {};
      const impactMs = num(d.overallSavingsMs) ?? (Math.max(num(ms.LCP) ?? 0, num(ms.FCP) ?? 0, num(ms.TBT) ?? 0, num(ms.INP) ?? 0) || null);
      const impactBytes = num(d.overallSavingsBytes);
      const score = Math.round(raw * 100);
      const items = (Array.isArray(d.items) ? d.items : []).slice(0, 5).map((it) => {
        if (!isObj(it)) return "";
        const node = isObj(it.node) ? it.node : {};
        return String(it.url ?? node.nodeLabel ?? node.snippet ?? "").slice(0, 200);
      }).filter(Boolean);
      issues.push({
        id, title: String(a.title ?? id), category: c, score, impactMs: impactMs === null ? null : Math.round(impactMs),
        impactBytes: impactBytes === null ? null : Math.round(impactBytes), severity: lhSeverity({ score, impactMs, impactBytes }),
        ...(typeof a.displayValue === "string" && a.displayValue ? { displayValue: a.displayValue } : {}), items,
      });
    }
  }
  const runtime = isObj(lhr.runtimeError) && typeof lhr.runtimeError.message === "string" ? lhr.runtimeError.message : undefined;
  return {
    url, strategy, scores, metrics, issues: sortLhIssues(issues),
    ...(typeof lhr.lighthouseVersion === "string" ? { version: lhr.lighthouseVersion } : {}),
    ...(typeof lhr.fetchTime === "string" ? { fetchedAt: lhr.fetchTime } : {}),
    ...(runtime ? { error: runtime } : {}),
  };
}

// Core Web Vitals bands (web.dev): good / needs improvement / poor. Lab values: TBT stands in for INP, which a lab run
// cannot measure.
export const CWV = { lcpMs: [2_500, 4_000], cls: [0.1, 0.25], tbtMs: [200, 600] } as const;
export type Band = "good" | "needs work" | "poor";
export const band = (k: keyof typeof CWV, v: number): Band => (v <= CWV[k][0] ? "good" : v <= CWV[k][1] ? "needs work" : "poor");

/** Runs Lighthouse on one URL for one form factor and returns the raw result (lhr). Injected in tests. */
export type LighthouseRunner = (url: string, strategy: Strategy) => Promise<unknown>;

export interface RunLighthouseOpts {
  runner?: LighthouseRunner;
  allowHosts?: string[];                                          // tests only
  resolve?: (host: string) => Promise<string[]>;                 // DNS, injectable
  log?: (line: string) => void;
}

async function assertPublic(url: string, o: RunLighthouseOpts): Promise<void> {
  const u = checkUrl(url, o.allowHosts ?? []); // throws BlockedUrlError for non-http(s) and private literal hosts
  const hp = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  if ((o.allowHosts ?? []).includes(hp)) return;
  const addrs = await (o.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address)))(u.hostname);
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a))) throw new BlockedUrlError(`${u.hostname} resolves to a private or local address`);
}

// Runs every (url, strategy) pair one after another (polite: one page load at a time). A failure is recorded on its
// result and the rest still run.
export async function runLighthouse(targets: Array<{ url: string; strategy: Strategy }>, o: RunLighthouseOpts = {}): Promise<LighthouseResult[]> {
  const out: LighthouseResult[] = [];
  let local: LocalLighthouse | undefined;
  const runner = o.runner ?? (async (url: string, s: Strategy) => (local ??= await LocalLighthouse.start()).run(url, s));
  try {
    for (const t of targets) {
      try {
        await assertPublic(t.url, o);
        const t0 = Date.now();
        const lhr = await runner(t.url, t.strategy);
        const r = parseLhr(lhr, t.strategy, t.url);
        o.log?.(`[checkup] lighthouse ${t.strategy} ${t.url}: ${JSON.stringify(r.scores)} in ${Math.round((Date.now() - t0) / 1000)} s`);
        out.push(r);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        o.log?.(`[checkup] lighthouse ${t.strategy} ${t.url} failed: ${error}`);
        out.push({ url: t.url, strategy: t.strategy, scores: {}, metrics: {}, issues: [], error: error.slice(0, 300) });
      }
    }
  } finally {
    await local?.close();
  }
  return out;
}

// One headless Chromium (Playwright's) for a whole check-up; Lighthouse attaches to it over its debugging port.
class LocalLighthouse {
  private constructor(private readonly chrome: { port: number; kill(): unknown }) {}
  static async start(): Promise<LocalLighthouse> {
    const [{ chromium }, cl] = await Promise.all([import("playwright"), import("chrome-launcher")]);
    const chrome = await cl.launch({ chromePath: chromium.executablePath(), chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"] });
    return new LocalLighthouse(chrome);
  }
  async run(url: string, strategy: Strategy): Promise<unknown> {
    const { default: lighthouse } = await import("lighthouse");
    const config = strategy === "desktop" ? (await import("lighthouse/core/config/desktop-config.js")).default : undefined;
    const r = await lighthouse(url, { port: this.chrome.port, output: "json", logLevel: "error", onlyCategories: LH_CATEGORIES, maxWaitForLoad: 45_000 }, config);
    return r?.lhr;
  }
  async close(): Promise<void> {
    try {
      await this.chrome.kill();
    } catch { /* already gone */ }
  }
}
