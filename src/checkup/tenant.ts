// The check-up for one business: which site and what kind of business (both read from what onboarding stored on the
// Business node), whether it runs every week, and the latest top five in owner words for a button, a slash command or
// the weekly schedule. The run itself is `checkup --tenant <slug>` (jobs.ts starts it in the background).
import { findBusinessId } from "../actions/shared.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import type { BusinessKind } from "./conversion.js";
import type { CheckupVerdict, Fix } from "./fixes.js";
import { checkupHistory, type TrendPoint } from "./history.js";
import { verdictLine } from "./report.js";
import { storedCheckups } from "./run.js";

type Read = Pick<GraphHandle, "roQuery">;

// Onboarding's kind of business (ingest/sources/website/understand.ts BUSINESS_KINDS) as the check-up's two kinds:
// a business people sign up to or buy from online is "online"; a café, clinic, studio or trade is "local".
export function checkupKind(businessKind: string | null | undefined): BusinessKind | undefined {
  if (!businessKind) return undefined;
  return businessKind === "software_product" || businessKind === "online_shop" ? "online" : "local";
}

export interface TenantSite {
  businessId: string;
  name: string;
  url?: string;            // https://<domain> from onboarding
  kind?: BusinessKind;     // from the stored businessKind
  weekly: boolean | null;  // the owner's (or operator's) choice; null: never set, the default applies
}

export async function tenantSite(g: Read, tenant: string, businessId?: string): Promise<TenantSite | null> {
  const id = businessId ?? (await findBusinessId(g, tenant));
  if (!id) return null;
  const [b] = await g.roQuery<{ name: string | null; domain: string | null; kind: string | null; weekly: boolean | null }>(
    "MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name, b.domain AS domain, b.businessKind AS kind, b.checkupWeekly AS weekly LIMIT 1", { id });
  if (!b) return null;
  const domain = (b.domain ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const kind = checkupKind(b.kind);
  return {
    businessId: id, name: b.name ?? tenant,
    ...(domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? { url: `https://${domain}` } : {}),
    ...(kind ? { kind } : {}),
    weekly: typeof b.weekly === "boolean" ? b.weekly : null,
  };
}

// The weekly check-up is on for a real business unless it was switched off, and off for a demo business unless it was
// switched on (a demo's site is not ours to crawl every week).
export const weeklyOn = (site: Pick<TenantSite, "weekly">, demo: boolean): boolean => site.weekly ?? !demo;

export async function setCheckupWeekly(g: GraphHandle, tenant: string, on: boolean, now: number, businessId?: string): Promise<boolean> {
  const site = await tenantSite(g, tenant, businessId);
  if (!site) throw new Error("This business isn't set up yet.");
  await upsertNode(g, { type: "Business", id: site.businessId, name: site.name, props: { checkupWeekly: on } }, now);
  return on;
}

export interface LatestCheckup {
  checkedOn: string;                 // YYYY-MM-DD
  asOf: string;
  site: string;
  verdict: string;
  top: Array<{ title: string; what: string; why: string; effort: string }>;
  fixedSinceLast: string[];          // what the last check-up found and this one no longer does (read from the closed FAILS edges)
  newSinceLast: string[];            // what is wrong now that was not before
  trend: Array<{ checkedOn: string; scores: Record<string, number> }>; // the owner's scores, one point per check-up, oldest first
}

// The findings come from the graph: the open FAILS edges, the ones closed as fixed, the readings on the website channel
// (history.ts). A check-up stored before the edges carried a whole finding falls back to the report Document's own JSON.
export async function latestCheckup(g: Read): Promise<LatestCheckup | null> {
  const [cur, prev] = await storedCheckups(g, 2);
  if (!cur) return null;
  const h = await checkupHistory(g, { asOf: cur.asOf, fixCount: cur.fixTitles.length }, !!prev);
  const top: Array<Partial<Fix>> = h.fromGraph ? h.top : (cur.top as Array<Partial<Fix>>).filter((f) => typeof f.title === "string").slice(0, 5);
  // the top five stand in for the full list: the verdict only counts the fixes that lose enquiries, and those rank first
  const verdict = verdictLine({ all: top } as unknown as CheckupVerdict);
  const trend: TrendPoint[] = h.trend;
  return {
    checkedOn: cur.asOf.slice(0, 10), asOf: cur.asOf, site: cur.url, verdict,
    top: top.map((f) => ({ title: f.title!, what: f.what ?? "", why: f.why ?? "", effort: f.effort ?? "" })),
    fixedSinceLast: h.fromGraph ? h.fixed : [], newSinceLast: h.fromGraph ? h.fresh : [],
    trend: trend.map((t) => ({ checkedOn: t.checkedOn, scores: t.scores })),
  };
}

// The top five as one chat message (Discord), in owner words.
export function topFiveText(c: LatestCheckup): string {
  const lines = [`**Your website check-up** (${c.site.replace(/^https?:\/\//, "")}, ${c.checkedOn})`, c.verdict];
  if (c.fixedSinceLast.length) lines.push(`Fixed since last time: ${c.fixedSinceLast.slice(0, 5).join("; ")}.`);
  c.top.forEach((f, i) => lines.push("", `**${i + 1}. ${f.title}**`, `What to change: ${f.what}`, `Why: ${f.why}${f.effort ? ` · ${f.effort}` : ""}`));
  return lines.join("\n");
}
