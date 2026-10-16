// SEO evaluation of a crawl, deterministic: every check is mapped to a Rule node. The vendored open-seo audit issues
// (vendor/playbooks/every-app__open-seo, written by the playbooks source as Rule {kind:'seo-check'}) cover most of
// them; what they lack (canonical, JSON-LD, viewport, mixed content, Open Graph) are local Rules with source
// "allevia". Each (page, check) becomes Page -FAILS {evidence, severity}-> Rule or Page -PASSES-> Rule, and the site
// gets a score: the severity-weighted share of checks passed, 0-100.
import type { EdgeInput, NodeInput, ObservationInput } from "../../../graph/upsert.js";
import { entityId } from "../../../util/ids.js";
import type { GraphWrite } from "../../types.js";
import { PACKS, loadAuditIssues, playbookId, ruleId } from "../playbook-data.js";
import { loadPlaybooks } from "../playbooks.js";
import { channelId, channelNode } from "../channels.js";
import { keyPagePriority } from "./urls.js";
import type { PageData } from "./page.js";

export type Severity = "critical" | "warning" | "info";

export const THRESHOLDS = { titleMaxChars: 60, thinWords: 200, slowResponseMs: 1_500, keyPagePriority: 70 } as const;
export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, warning: 5, info: 2 };

// Checks the vendored audit set has, by its issue type.
export const VENDORED_CHECKS = [
  "missing-title", "duplicate-title", "title-too-long", "missing-meta-description", "duplicate-meta-description", "missing-h1",
  "multiple-h1", "images-missing-alt", "noindex-page", "thin-content", "broken-internal-link", "slow-response", "broken-page",
  "server-error",
] as const;

// Checks it lacks: Allevia's own Rules.
export const LOCAL_RULES = [
  { key: "missing-canonical", severity: "info", title: "Missing canonical link",
    text: "The page declares no rel=canonical URL, so search engines pick the version of the page to index on their own (with or without www, slash, tracking parameters).",
    howToFix: "Add <link rel=\"canonical\" href=\"…\"> with the page's preferred absolute URL." },
  { key: "missing-structured-data", severity: "warning", title: "No structured data on a key page",
    text: "A key page (home, about, services, projects, contact, pricing) has no JSON-LD structured data, so search engines cannot read the business's name, address, services or projects reliably.",
    howToFix: "Add a JSON-LD block (LocalBusiness or Organization on the home and contact pages; Service or CreativeWork where it fits)." },
  { key: "missing-viewport", severity: "warning", title: "Missing viewport meta tag",
    text: "The page has no <meta name=\"viewport\">, so phones render it zoomed out; Google indexes the mobile version first.",
    howToFix: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">." },
  { key: "mixed-content", severity: "warning", title: "Mixed content",
    text: "An https page loads images, scripts or styles over plain http; browsers block or flag them and the padlock disappears.",
    howToFix: "Serve every resource over https (update the URLs or use the https version of the host)." },
  { key: "missing-open-graph", severity: "info", title: "Open Graph tags missing",
    text: "The page lacks og:title or og:image, so links shared on WhatsApp, Facebook, LinkedIn or iMessage show a bare preview.",
    howToFix: "Add og:title, og:description and og:image (1200x630) meta tags." },
] as const;

export type CheckKey = (typeof VENDORED_CHECKS)[number] | (typeof LOCAL_RULES)[number]["key"];

export const ALLEVIA_SEO_PLAYBOOK = entityId("Playbook", "allevia seo checks");
export const localRuleId = (key: string) => ruleId("seo-check", `allevia ${key}`);
export const seoRuleId = (key: CheckKey): string =>
  (VENDORED_CHECKS as readonly string[]).includes(key) ? ruleId("seo-check", key) : localRuleId(key);

let severities: Map<string, Severity> | undefined;
export function severityOf(key: CheckKey): Severity {
  const local = LOCAL_RULES.find((r) => r.key === key);
  if (local) return local.severity;
  severities ??= new Map(loadAuditIssues().data.issues.map((i) => [i.type, i.severity as Severity]));
  return severities.get(key) ?? "warning";
}

export interface SeoResult { page: string; check: CheckKey; ruleId: string; pass: boolean; severity: Severity; evidence: string }
export interface SeoReport {
  results: SeoResult[];
  score: number;                                         // 0-100
  pageScores: Record<string, number>;
  failing: Array<{ check: CheckKey; ruleId: string; severity: Severity; pages: number }>; // most pages first
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const short = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
const list = (xs: string[], n = 5) => `${xs.slice(0, n).join(", ")}${xs.length > n ? ` and ${xs.length - n} more` : ""}`;

export function evaluateSeo(pages: PageData[], linkStatus: Record<string, number> = {}): SeoReport {
  const results: SeoResult[] = [];
  const add = (p: PageData, check: CheckKey, pass: boolean, evidence: string) =>
    results.push({ page: p.finalUrl, check, ruleId: seoRuleId(check), pass, severity: severityOf(check), evidence });
  const ok = pages.filter((p) => p.status >= 200 && p.status < 300 && !p.error);
  const dupes = (key: (p: PageData) => string) => {
    const m = new Map<string, PageData[]>();
    for (const p of ok) {
      const k = key(p);
      if (k) m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  };
  const titles = dupes((p) => norm(p.title));
  const descs = dupes((p) => norm(p.metaDescription));

  for (const p of pages) {
    if (p.status >= 400 || p.status === 0) {
      add(p, p.status >= 500 || p.status === 0 ? "server-error" : "broken-page", false, `the page answers HTTP ${p.status}`);
      continue;
    }
    if (!ok.includes(p)) continue; // a render failure says nothing about the page's SEO
    add(p, "broken-page", true, `HTTP ${p.status}`);
    add(p, "server-error", true, `HTTP ${p.status}`);

    const title = p.title?.trim() ?? "";
    add(p, "missing-title", !!title, title ? `title: "${title}"` : "the page has no <title>");
    if (title) {
      const same = (titles.get(norm(title)) ?? []).filter((x) => x !== p);
      add(p, "duplicate-title", !same.length, same.length ? `same title as ${list(same.map((x) => short(x.finalUrl)))}: "${title}"` : "unique title");
      add(p, "title-too-long", title.length <= THRESHOLDS.titleMaxChars, `${title.length} characters (limit ${THRESHOLDS.titleMaxChars})`);
    }
    const desc = p.metaDescription?.trim() ?? "";
    add(p, "missing-meta-description", !!desc, desc ? `${desc.length} characters` : "no meta description");
    if (desc) {
      const same = (descs.get(norm(desc)) ?? []).filter((x) => x !== p);
      add(p, "duplicate-meta-description", !same.length, same.length ? `same description as ${list(same.map((x) => short(x.finalUrl)))}` : "unique description");
    }
    add(p, "missing-h1", p.h1.length > 0, p.h1.length ? `h1: "${p.h1[0]}"` : "no <h1> heading");
    add(p, "multiple-h1", p.h1.length <= 1, p.h1.length > 1 ? `${p.h1.length} <h1> headings: ${list(p.h1.map((h) => `"${h.slice(0, 60)}"`), 3)}` : `${p.h1.length} <h1>`);

    const noAlt = p.images.filter((i) => i.alt === null && !(i.naturalWidth > 0 && i.naturalWidth <= 2 && i.naturalHeight <= 2));
    add(p, "images-missing-alt", !noAlt.length, noAlt.length
      ? `${noAlt.length} of ${p.images.length} images have no alt attribute: ${list(noAlt.map((i) => i.src.split("/").pop()?.split("?")[0] || i.src), 3)}`
      : `${p.images.length} images, all with alt`);
    add(p, "missing-canonical", !!p.canonical, p.canonical ? `canonical: ${p.canonical}` : "no rel=canonical link");
    const noindex = /\bnoindex\b|\bnone\b/i.test(p.robotsMeta ?? "");
    add(p, "noindex-page", !noindex, noindex ? `robots: "${p.robotsMeta}"` : "indexable");
    add(p, "thin-content", p.wordCount >= THRESHOLDS.thinWords, `${p.wordCount} words of main text (threshold ${THRESHOLDS.thinWords})`);

    const broken = p.internalLinks.filter((l) => (linkStatus[l] ?? 0) >= 400);
    add(p, "broken-internal-link", !broken.length, broken.length
      ? `links to ${list(broken.map((l) => `${short(l)} (HTTP ${linkStatus[l]})`))}` : "no broken internal links found");

    if (keyPagePriority(new URL(p.finalUrl)) >= THRESHOLDS.keyPagePriority) {
      const has = p.jsonLd.length > 0;
      add(p, "missing-structured-data", has, has ? `JSON-LD types: ${p.jsonLdTypes.join(", ") || "none named"}`
        : p.jsonLdErrors ? `${p.jsonLdErrors} JSON-LD block(s), none valid` : "no JSON-LD on this key page");
    }
    add(p, "missing-viewport", !!p.viewport, p.viewport ? `viewport: ${p.viewport}` : "no viewport meta tag");
    add(p, "slow-response", p.timing.responseMs <= THRESHOLDS.slowResponseMs,
      `HTML in ${p.timing.responseMs} ms (limit ${THRESHOLDS.slowResponseMs} ms)${p.timing.loadMs !== undefined ? `, loaded in ${p.timing.loadMs} ms` : ""}`);
    if (p.finalUrl.startsWith("https:")) {
      add(p, "mixed-content", !p.mixedContent.length, p.mixedContent.length ? `http resources: ${list(p.mixedContent, 3)}` : "every resource is https");
    }
    const missingOg = ["og:title", "og:description", "og:image"].filter((k) => !p.og[k]);
    add(p, "missing-open-graph", !!p.og["og:title"] && !!p.og["og:image"], missingOg.length ? `missing ${missingOg.join(", ")}` : "og:title, og:description and og:image set");
  }

  const weigh = (rs: SeoResult[]) => {
    const total = rs.reduce((n, r) => n + SEVERITY_WEIGHT[r.severity], 0);
    return total ? Math.round((100 * rs.filter((r) => r.pass).reduce((n, r) => n + SEVERITY_WEIGHT[r.severity], 0)) / total) : 100;
  };
  const pageScores: Record<string, number> = {};
  for (const p of pages) pageScores[p.finalUrl] = weigh(results.filter((r) => r.page === p.finalUrl));
  const fails = new Map<CheckKey, number>();
  for (const r of results) if (!r.pass) fails.set(r.check, (fails.get(r.check) ?? 0) + 1);
  const rank = { critical: 0, warning: 1, info: 2 };
  const failing = [...fails].map(([check, n]) => ({ check, ruleId: seoRuleId(check), severity: severityOf(check), pages: n }))
    .sort((a, b) => b.pages - a.pages || rank[a.severity] - rank[b.severity]);
  return { results, score: weigh(results), pageScores, failing };
}

// ---------- graph ----------

// The Rules FAILS/PASSES point at: the vendored seo-check pack (exactly as the playbooks source writes it, so the two
// never disagree) and Allevia's local checks, both INCLUDED by their Playbook and APPLIES_TO the website channel.
export function seoRulesWrite(): GraphWrite {
  const pb = loadPlaybooks({ tenantSlug: "onboard" }).write;
  const seoPlaybook = playbookId(PACKS.seo);
  const keep = new Set<string>([seoPlaybook, channelId("website")]);
  for (const e of pb.edges) if (e.from === seoPlaybook && (e.type === "INCLUDES" || e.type === "SOURCED_FROM")) keep.add(e.to);
  const nodes: NodeInput[] = pb.nodes.filter((n) => keep.has(n.id));
  const edges: EdgeInput[] = pb.edges.filter((e) => keep.has(e.from) && keep.has(e.to));

  nodes.push({ type: "Playbook", id: ALLEVIA_SEO_PLAYBOOK, name: "Allevia SEO checks",
    summary: "Allevia's own website checks for what the vendored open-seo audit does not cover: canonical links, structured data, viewport, mixed content and Open Graph.",
    props: { source: "allevia" } });
  if (!nodes.some((n) => n.id === channelId("website"))) nodes.push(channelNode("website"));
  edges.push({ from: ALLEVIA_SEO_PLAYBOOK, type: "APPLIES_TO", to: channelId("website") });
  for (const r of LOCAL_RULES) {
    const id = localRuleId(r.key);
    nodes.push({ type: "Rule", id, name: `SEO check: ${r.title}`, summary: `${r.title}. ${r.text}`,
      props: { kind: "seo-check", source: "allevia", severity: r.severity, text: `${r.title}. ${r.text}`, howToFix: r.howToFix, issueType: r.key } });
    edges.push({ from: ALLEVIA_SEO_PLAYBOOK, type: "INCLUDES", to: id });
    edges.push({ from: id, type: "APPLIES_TO", to: channelId("website") });
  }
  return { nodes, edges, observations: [] };
}

export const auditDocId = (host: string, day: string) => entityId("Document", `website seo audit ${host} ${day}`);

// FAILS/PASSES edges, the audit Document, and the site score as an Observation on the website channel. Each page's own score is
// an Observation too (`seo_page_score`, MEASURES the Page, one per day), so a page's score has a history; onboarding also keeps the
// latest as the Page's `seoScore` property, which is what a card reads without a traversal.
export function seoWrite(report: SeoReport, ctx: { host: string; asOf: string; day: string; pages: PageData[] }): GraphWrite {
  const doc = auditDocId(ctx.host, ctx.day);
  const fails = report.results.filter((r) => !r.pass).length;
  const nodes: NodeInput[] = [{
    type: "Document", id: doc, name: `Website SEO audit of ${ctx.host}, ${ctx.day}`, asOf: ctx.asOf,
    summary: `Allevia's onboarding audit of ${ctx.pages.length} pages: site score ${report.score}/100, ${fails} failed checks.`,
    props: { kind: "report", title: `Website SEO audit, ${ctx.day}`, score: report.score },
  }];
  const pageIds = new Map(ctx.pages.map((p) => [p.finalUrl, entityId("Page", p.finalUrl)]));
  const edges: EdgeInput[] = report.results.map((r): EdgeInput => ({
    from: pageIds.get(r.page) ?? entityId("Page", r.page), type: r.pass ? "PASSES" : "FAILS", to: r.ruleId, src: doc, asOf: ctx.asOf,
    props: r.pass ? { severity: r.severity } : { evidence: r.evidence.slice(0, 400), severity: r.severity },
  }));
  edges.push({ from: doc, type: "LINKS_TO_PAGE", to: entityId("Page", ctx.pages[0]?.finalUrl ?? `https://${ctx.host}/`), src: doc, asOf: ctx.asOf });
  return {
    nodes, edges: edges.filter((e) => ctx.pages.length > 0 || e.type !== "LINKS_TO_PAGE"),
    observations: [
      { subject: channelId("website"), metric: "seo_site_score", value: report.score, unit: "/100", asOf: ctx.day, src: doc,
        evidence: `${report.results.length - fails} of ${report.results.length} checks passed across ${ctx.pages.length} pages` },
      ...ctx.pages.map((p): ObservationInput => {
        const checks = report.results.filter((r) => r.page === p.finalUrl);
        return { subject: pageIds.get(p.finalUrl)!, metric: "seo_page_score", value: report.pageScores[p.finalUrl] ?? 100, unit: "/100", asOf: ctx.day, src: doc,
          evidence: `${checks.filter((r) => r.pass).length} of ${checks.length} checks passed on this page` };
      }),
    ],
  };
}
