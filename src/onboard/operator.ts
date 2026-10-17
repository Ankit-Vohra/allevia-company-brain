// The operator's onboarding from the terminal (`npm run cli -- onboard <url>`, src/cli/onboard.ts): exactly what the web app's
// Add a business runs (onboard() with productionOnboardDeps: crawl, brand kit, checks, goals, and with APIFY_TOKEN the public-data
// reads onboarding makes), with its progress as lines on stdout. Then, only with APIFY_TOKEN, the public reads the team's own
// tools make on request, done once up front so day one has them: the business's public Instagram numbers, its ads in the public
// ad libraries, and up to three rivals' (instagram_public, ad_library and competitor_watch, src/agent/tools/publicdata.ts). Each
// is quoted before anything runs and stays inside the business's public-data budget; --max-usd caps the whole run.
import { z } from "zod";
import type { OnboardEvent } from "../../shared/contracts.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "../agent/tool.js";
import type { GraphHandle } from "../graph/client.js";
import { estimateUsd } from "../publicdata/actors.js";
import type { PublicDataPort } from "../publicdata/service.js";
import { slugify } from "../util/ids.js";
import type { OnboardDeps, OnboardInput, OnboardResult } from "./onboard.js";

export interface Rival { name: string; instagram?: string; domain?: string }

export interface OperatorArgs {
  url: string;
  slug?: string;
  name?: string;
  country?: string;
  currency?: string;
  timeZone?: string;
  industry?: string;
  vertical?: string;
  instagram?: string;
  rivals: Rival[];
  extras: boolean;           // the public reads after onboarding (default on when public data is on)
  maxUsd: number;            // the whole run's public-data cap, in dollars
  maxPages?: number;
  model?: string;
  verbose: boolean;
  json: boolean;
}

/** "Third Wave Coffee|thirdwavecoffeeindia|thirdwavecoffee.in": a rival's name, then its Instagram handle and website (both optional). */
export function parseRival(raw: string): Rival {
  const [name, ig, domain] = raw.split("|").map((s) => s.trim());
  if (!name) throw new Error(`--rival needs a name first: "Name|instagram|website", got "${raw}"`);
  return { name, ...(ig ? { instagram: ig.replace(/^@/, "") } : {}), ...(domain ? { domain } : {}) };
}

/** A name for a business known only by its website: "bluetokaicoffee.com" -> "Bluetokaicoffee". */
export function nameFromUrl(url: string): string {
  let host = url;
  try { host = new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname; } catch { /* keep */ }
  const base = host.replace(/^www\./, "").split(".")[0] ?? host;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Business";
}

export function onboardInput(a: OperatorArgs, slug: string): OnboardInput {
  return {
    name: a.name ?? nameFromUrl(a.url), slug, url: a.url,
    ...(a.instagram ? { instagram: a.instagram } : {}), ...(a.country ? { country: a.country } : {}), ...(a.currency ? { currency: a.currency.toUpperCase() } : {}),
    ...(a.timeZone ? { timeZone: a.timeZone } : {}), ...(a.industry ? { industry: a.industry } : {}), ...(a.vertical ? { vertical: a.vertical } : {}),
  };
}

/** One progress line per event, as the web page shows them (the `nodes` events only with --verbose). */
export function progressLine(e: OnboardEvent, t0: number, now: number, verbose: boolean): string | null {
  const at = `${((now - t0) / 1000).toFixed(1)}s`;
  if (e.type === "stage") return `${at} [${e.stage}] ${e.text}`;
  if (e.type === "page") return `${at}   page ${e.url} "${e.title}"`;
  if (e.type === "nodes") return verbose ? `${at}   +${e.nodes.length} nodes, +${e.edges.length} edges` : null;
  if (e.type === "error") return `${at} ${"soft" in e && e.soft ? "note" : "ERROR"}: ${e.message}`;
  if (e.type === "done") return `${at} done ${e.tenant} ${JSON.stringify(e.counts)}`;
  return null;
}

// ---------- the public reads after onboarding ----------

export interface ExtrasPlan { own: { instagram?: string; brand: string; domain?: string }; rivals: Rival[]; quoteUsd: number; lines: string[] }

/** What the public reads will be, and the most they may cost (before anything runs). */
export function planExtras(o: { name: string; domain?: string; instagram?: string; rivals: Rival[] }): ExtrasPlan {
  const lines: string[] = [];
  let usd = 0;
  const ig = (who: string) => {
    const q = estimateUsd("apify/instagram-profile-scraper", 1) + estimateUsd("apify/instagram-post-scraper", 12);
    lines.push(`  ${who}: public Instagram profile and recent posts, up to $${q.toFixed(3)}`);
    usd += q;
  };
  const ads = (who: string, domain?: string) => {
    const meta = estimateUsd("apify/facebook-ads-scraper", 20), google = domain ? estimateUsd("s-r/google-ads-transparency", 20) : 0;
    lines.push(`  ${who}: Meta Ad Library (20 ads)${domain ? ` and Google Ads Transparency for ${domain} (20 ads)` : ""}, up to $${(meta + google).toFixed(3)}`);
    usd += meta + google;
  };
  if (o.instagram) ig(o.name);
  ads(o.name, o.domain);
  for (const r of o.rivals.slice(0, 3)) {
    if (r.instagram) ig(r.name);
    ads(r.name, r.domain);
  }
  return { own: { ...(o.instagram ? { instagram: o.instagram } : {}), brand: o.name, ...(o.domain ? { domain: o.domain } : {}) }, rivals: o.rivals.slice(0, 3), quoteUsd: Math.round(usd * 1000) / 1000, lines };
}

/** The most onboarding's own public reads may cost: the Google listing with ten reviews, and the blocked-site reader if needed. */
export const ONBOARDING_QUOTE_USD = Math.round((estimateUsd("compass/crawler-google-places", 11) + estimateUsd("apify/website-content-crawler", 12)) * 1000) / 1000;

export interface ExtrasDeps {
  instagramPublic: AlleviaTool;
  adLibrary: AlleviaTool;
  competitorWatch: AlleviaTool;
}

/** Runs the planned public reads through the team's own tools (same budget, same writers, same privacy filter). */
export async function runExtras(g: GraphHandle, pd: PublicDataPort, plan: ExtrasPlan, o: { tenant: string; now: number; tools: ExtrasDeps; out: (line: string) => void }): Promise<{ ok: number; failed: string[] }> {
  const ctx: ToolContext = { graph: g, tenant: o.tenant, turnId: `onboard-cli-${o.now}`, agentId: "growth-marketer", asker: "person:owner", touched: new TouchedSet(), now: o.now, publicData: pd };
  const call = async (label: string, tool: AlleviaTool, args: Record<string, unknown>) => {
    try {
      const r = await tool.run(z.object(tool.input).parse(args), ctx);
      const data = r.data as { found?: unknown; why?: string } | undefined;
      if (data && data.found === false) { failed.push(`${label}: ${data.why ?? "nothing found"}`); o.out(`  ${label}: ${data.why ?? "nothing found"}`); return; }
      ok++;
      o.out(`  ${label}: ${r.note ?? "done"}`);
    } catch (e) {
      failed.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      o.out(`  ${label}: failed (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  let ok = 0;
  const failed: string[] = [];
  if (plan.own.instagram) await call("Instagram (ours)", o.tools.instagramPublic, { handle: plan.own.instagram, whose: "ours" });
  await call("Ads (ours)", o.tools.adLibrary, { brand: plan.own.brand, ...(plan.own.domain ? { domain: plan.own.domain } : {}), whose: "ours" });
  if (plan.rivals.length) {
    await call(`Rivals (${plan.rivals.map((r) => r.name).join(", ")})`, o.tools.competitorWatch, {
      competitors: plan.rivals.map((r) => ({ name: r.name, ...(r.instagram ? { instagram: r.instagram } : {}), ...(r.domain ? { domain: r.domain } : {}) })),
    });
  }
  return { ok, failed };
}

/** The Instagram handle onboarding found on the website (or was given), from the graph. */
export async function instagramHandle(g: GraphHandle): Promise<string | undefined> {
  const [r] = await g.roQuery<{ h: string | null }>("MATCH (c:Entity:Channel {id:'channel:instagram'}) RETURN c.handle AS h");
  const h = r?.h?.replace(/^@/, "").trim().toLowerCase();
  return h && /^[a-z0-9._]{1,30}$/.test(h) ? h : undefined;
}

export interface OperatorRun { result: OnboardResult; extras?: { ok: number; failed: string[]; quoteUsd: number } | { skipped: string } }

/** onboard() with the given deps, then the public reads. `onboardFn` and the deps are injected so tests run it offline. */
export async function runOperatorOnboard(a: OperatorArgs, slug: string, d: {
  onboardFn: (input: OnboardInput, emit: (e: OnboardEvent) => void, deps: OnboardDeps) => Promise<OnboardResult>;
  deps: OnboardDeps;
  openGraph: (tenant: string) => Promise<GraphHandle>;
  tools?: ExtrasDeps;
  out: (line: string) => void;
  now?: () => number;
}): Promise<OperatorRun> {
  const now = d.now ?? (() => Date.now());
  const t0 = now();
  const input = onboardInput(a, slug);
  const pd = d.deps.publicData;
  d.out(`Onboarding ${input.name} (${slug}) from ${a.url}${pd?.enabled ? `; public data on (onboarding's own reads up to $${ONBOARDING_QUOTE_USD.toFixed(3)})` : "; public data off (no APIFY_TOKEN)"}`);
  const result = await d.onboardFn(input, (e) => { const l = progressLine(e, t0, now(), a.verbose); if (l) d.out(l); }, d.deps);
  if (!result.ok) return { result };
  if (!a.extras) return { result, extras: { skipped: "--no-extras" } };
  if (!pd?.enabled) return { result, extras: { skipped: "public data is off (no APIFY_TOKEN)" } };
  if (!d.tools) return { result, extras: { skipped: "the public-data tools are not loaded" } };
  const g = await d.openGraph(slug);
  const instagram = a.instagram?.replace(/^@/, "").toLowerCase() ?? await instagramHandle(g);
  let domain: string | undefined;
  try { domain = new URL(/^https?:/i.test(a.url) ? a.url : `https://${a.url}`).hostname.replace(/^www\./, ""); } catch { domain = undefined; }
  const plan = planExtras({ name: input.name, ...(domain ? { domain } : {}), ...(instagram ? { instagram } : {}), rivals: a.rivals.filter((r) => slugify(r.name) !== slugify(input.name)) });
  const total = Math.round((plan.quoteUsd + ONBOARDING_QUOTE_USD) * 1000) / 1000;
  if (total > a.maxUsd) {
    const why = `the public reads would cost up to $${plan.quoteUsd.toFixed(3)} (with onboarding's own, $${total.toFixed(3)}), over --max-usd ${a.maxUsd}`;
    d.out(`Public reads skipped: ${why}`);
    return { result, extras: { skipped: why } };
  }
  d.out(`Public reads (up to $${plan.quoteUsd.toFixed(3)}):`);
  for (const l of plan.lines) d.out(l);
  const r = await runExtras(g, pd, plan, { tenant: slug, now: now(), tools: d.tools, out: d.out });
  const b = pd.budget(slug);
  d.out(`Public data spent this month for ${slug}: $${b.spentThisMonth.toFixed(3)} of $${b.monthly.toFixed(2)}`);
  return { result, extras: { ...r, quoteUsd: plan.quoteUsd } };
}
