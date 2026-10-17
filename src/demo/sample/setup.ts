// `seed-sample`'s whole run on one business, after the sample layer is written: the steps the product itself runs, in order.
//   1. the label: the registry's industry says "public data plus sample numbers", which the business switcher shows;
//   2. enrol: the growth plan's goals (onboarding made them; a business with none is enrolled now), then settleGoals as when new
//      numbers arrive. Goals count real numbers only (src/program/measure.ts skips sample ones), so a demo's goals keep waiting
//      for real numbers: sample numbers never move a goal;
//   3. insights: the deterministic detectors find the error, the checkout step and the campaign, and write their cards;
//   4. the stand-up: what the team noticed, drafted for the owner's OK, and Today's note;
//   5. so the demo always has one of each, the three kinds of draft the story needs (a reply to the enquiry with three free times,
//      a reply to a Google review, a post) are drafted through the stand-up's own drafting when the stand-up did not pick them.
// Nothing is posted, sent or paid for: no paid pictures (paidPerDay 0), and approving stays a dry run unless ALLEVIA_ACTIONS_LIVE=1.
import type { GraphHandle } from "../../graph/client.js";
import { ensureTenant, getTenant, type TenantOpts } from "../../graph/tenants.js";
import type { LlmRunner } from "../../ingest/llm.js";
import { runInsights } from "../../insights/recommend.js";
import { onboard } from "../../onboard/onboard.js";
import { settleGoals } from "../../program/late.js";
import { currentProgram } from "../../program/program.js";
import { loadHistory, screen } from "../../proactive/choose.js";
import { draftPick, type DraftedItem, type Drafters } from "../../proactive/draft.js";
import { opportunitiesFrom, type Opportunity, type OpportunityKind } from "../../proactive/opportunities.js";
import { gatherSignals } from "../../proactive/signals.js";
import { isoDate } from "../../util/time.js";
import { seedCoffeeSample, type CoffeeSeedResult } from "./coffee.js";

export const SAMPLE_LABEL = "public data plus sample numbers";
export const PROFILES = ["coffee"] as const;
export type Profile = (typeof PROFILES)[number];

export interface SetupOptions {
  tenant: string;
  profile: Profile;
  name?: string;               // the business's name in the registry (default: what it is registered as)
  industry?: string;           // the plain industry before the label (default: the registered one, else "specialty coffee roaster")
  vertical?: string;           // the template the growth plan uses when the business is enrolled here (default "online shop")
  country?: string;
  now?: number;
  weeks?: number;
  standup?: boolean;           // default true
  drafters?: Drafters;         // default: the production drafters (the words are written on the subscription)
  runner?: LlmRunner | null;   // Meera's choice in the stand-up; null: the rule order picks
  skills?: (agent: string, id: string) => { name: string; guidance: string } | undefined;
  embed?: (text: string) => number[];
  tenantOpts?: TenantOpts;
  log?: (line: string) => void;
}

export interface SetupResult {
  seed: CoffeeSeedResult;
  enrolled: boolean;
  goals: { locked: number; readings: number };
  insights: { findings: number; cards: number };
  standup: { by: string; drafted: string[] } | null;
  filled: Array<{ kind: string; title: string; approvalId?: string; status: string }>;
  waiting: Array<{ id: string; title: string; kind: string; sample: boolean }>;
}

const WANTED: Array<{ want: string; kinds: OpportunityKind[] }> = [
  { want: "sales_reply", kinds: ["sales_reply"] },
  { want: "reply", kinds: ["reply"] },
  { want: "post", kinds: ["post", "poster"] },
];

/** The label the switcher shows: "<industry> (public data plus sample numbers)", never doubled. */
export function labelled(industry: string): string {
  const plain = industry.replace(/\s*\((?:public data plus sample numbers|synthetic demo data|sample[^)]*)\)\s*$/i, "").trim() || "specialty coffee roaster";
  return `${plain} (${SAMPLE_LABEL})`;
}

export async function setupSample(g: GraphHandle, o: SetupOptions): Promise<SetupResult> {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? Date.now();
  if (o.profile !== "coffee") throw new Error(`unknown sample profile "${o.profile}" (known: ${PROFILES.join(", ")})`);

  // 1. the sample layer, then the label
  const seed = await seedCoffeeSample(g, { tenant: o.tenant, now, ...(o.weeks ? { weeks: o.weeks } : {}), ...(o.embed ? { embed: o.embed } : {}), log });
  log(`seeded: ${seed.nodes} nodes, ${seed.edges} edges, ${seed.observations} readings; products ${seed.products.filter((p) => p.crawled).length} from the website, ${seed.products.filter((p) => !p.crawled).length} sample`);
  const reg = await getTenant(o.tenant, o.tenantOpts);
  const name = o.name ?? reg?.name;
  if (!name) throw new Error(`"${o.tenant}" is not in the tenant registry: onboard it first`);
  await ensureTenant({ slug: o.tenant, name, industry: labelled(o.industry ?? reg?.industry ?? "specialty coffee roaster") }, o.tenantOpts);

  // 2. enrol, then where each goal starts and its first reading
  const businessId = seed.businessId;
  let enrolled = false;
  if (!(await currentProgram(g, businessId))) {
    const r = await onboard({ name, slug: o.tenant, website: false, vertical: o.vertical ?? "online shop", industry: labelled(o.industry ?? reg?.industry ?? "specialty coffee roaster"), ...(o.country ? { country: o.country } : {}) },
      (e) => { if (e.type === "stage") log(`enrol: [${e.stage}] ${e.text}`); }, { now: () => now, ...(o.tenantOpts ? { tenantOpts: o.tenantOpts } : {}) });
    if (r.errors.length) log(`enrol: ${r.errors.join("; ")}`);
    enrolled = true;
  }
  const settled = await settleGoals(g, { now, businessId });
  log(`goals: ${settled.locked.length} starting points locked, ${settled.readings.length} readings`);

  // 3. insights: deterministic, numbers from the graph only
  const ins = await runInsights(o.tenant, { graph: g, now, llm: false, log });
  const cards = ins.recommendations.filter((x) => x.approvalId).length;
  log(`insights: ${ins.candidates.length} findings, ${cards} with a card`);

  // 4. the stand-up, with no paid pictures
  let standup: SetupResult["standup"] = null;
  const drafters = o.drafters ?? (await import("../../proactive/wiring.js")).productionDrafters(g, o.tenant, businessId);
  const skills = o.skills ?? (await (await import("../../proactive/wiring.js")).skillsFor(g));
  if (o.standup !== false) {
    const { runDaily } = await import("../../proactive/wiring.js");
    const { standup: s } = await runDaily(o.tenant, g, businessId, {
      now, force: true, paid: false, drafters, ...(o.runner === undefined ? {} : { runner: o.runner }), log,
    });
    standup = { by: s.by, drafted: s.items.filter((i) => i.status === "drafted").map((i) => `${i.kind}: ${i.title}`) };
    log(`stand-up: ${standup.drafted.length} drafted (${s.by})`);
  }

  // 5. one of each kind of draft the story needs, through the stand-up's own drafting, when nothing of that kind is waiting
  const filled = await fillDrafts(g, { tenant: o.tenant, businessId, now, drafters, skills, log });

  const waiting = await g.roQuery<{ id: string; title: string | null; kind: string | null; sim: boolean | null; ev: boolean }>(
    `MATCH (a:Approval) WHERE coalesce(a.status, 'pending') = 'pending'
     OPTIONAL MATCH (r:Recommendation)-[p:PROPOSES]->(a) WHERE p.until IS NULL
     OPTIONAL MATCH (r)-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL AND x.simulated = true
     WITH a, count(x) > 0 AS ev
     RETURN a.id AS id, a.title AS title, a.kind AS kind, a.simulated AS sim, ev ORDER BY id`);
  return {
    seed, enrolled, goals: { locked: settled.locked.length, readings: settled.readings.length },
    insights: { findings: ins.candidates.length, cards }, standup, filled,
    waiting: waiting.map((w) => ({ id: w.id, title: w.title ?? w.id, kind: w.kind ?? "?", sample: w.sim === true || w.ev })),
  };
}

async function fillDrafts(g: GraphHandle, c: { tenant: string; businessId: string; now: number; drafters: Drafters; skills?: SetupOptions["skills"]; log: (l: string) => void }): Promise<SetupResult["filled"]> {
  const history = await loadHistory(g, c.now);
  const pendingKinds = new Set(history.filter((h) => h.status === "pending").map((h) => h.kind));
  const signals = await gatherSignals(g, { now: c.now, tenant: c.tenant, businessId: c.businessId, log: c.log });
  const { kept } = screen(opportunitiesFrom(signals), history, c.now);
  const out: SetupResult["filled"] = [];
  for (const w of WANTED) {
    if (w.kinds.some((k) => pendingKinds.has(k))) continue;
    // the goal-movers first, a festival or season only when nothing else of the kind is there
    const op: Opportunity | undefined = kept.filter((k) => w.kinds.includes(k.kind)).sort((a, b) => Number(!!a.filler) - Number(!!b.filler) || b.score - a.score || a.key.localeCompare(b.key))[0];
    if (!op) { c.log(`drafts: nothing to draft a ${w.want} from (no ${w.want === "reply" ? "Google review without a reply" : w.want === "post" ? "post idea" : "enquiry waiting"})`); continue; }
    // a poster idea is drafted as the post on its own: no picture is made, nothing is paid for
    const pick = { ...op, kind: op.kind === "poster" ? ("post" as const) : op.kind, why: op.reason, purpose: op.brief };
    const d: DraftedItem = await draftPick(g, pick, {
      tenant: c.tenant, businessId: c.businessId, businessName: signals.business.name, ...(signals.business.domain ? { domain: signals.business.domain } : {}),
      now: c.now, turnId: `standup-${c.tenant}-${isoDate(c.now)}`, drafters: c.drafters, paidLeft: 0, ...(c.skills ? { skills: c.skills } : {}), log: c.log,
    });
    out.push({ kind: d.kind, title: d.title, status: d.status, ...(d.approvalId ? { approvalId: d.approvalId } : {}) });
    c.log(`drafts: ${d.status === "drafted" ? "drafted" : "could not draft"} "${d.title}"${d.approvalId ? ` (${d.approvalId})` : ""}`);
  }
  return out;
}

/** Only these may be seeded: the listed demo businesses and throwaway ones (demo_*, *_seed). A real customer never is. */
export function seedable(tenant: string, allowed: (t: string) => boolean): boolean {
  return allowed(tenant) || /^demo_|_seed$/.test(tenant);
}
