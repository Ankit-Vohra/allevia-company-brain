// Onboarding v2's program stages (product design §2.1, §3.3): after the website stages (or without them, for a business
// already in the graph), the business gets its country defaults and industry template (profile), its Allevia 90
// program and two or three goals (goals), Day-0 baselines from the data it already has and the Day-0 checkpoint
// (baseline), and the capability ladder (capabilities). onboard() runs them in order; `enroll <tenant>` runs only these.
import type { CapabilityState, OnboardEvent, OnboardStage } from "../../shared/contracts.js";
import { agentById } from "../../shared/roster.js";
import type { GraphHandle } from "../graph/client.js";
import { ensureTenant, type TenantOpts } from "../graph/tenants.js";
import type { GraphWrite } from "../ingest/types.js";
import { syncCapabilities } from "../capabilities/ladder.js";
import { ensureAgentNode } from "../actions/shared.js";
import { fmt, shortDate } from "../insights/text.js";
import {
  baselinesWrite, checkpointWrite, goalOwners, programAndGoalsWrite, programGoals, type BaselineResult,
} from "../program/program.js";
import { localDate, resolveRegion, type ResolvedRegion } from "./region.js";
import { templateByKey, templateFor, type IndustryTemplate } from "./templates.js";

export interface ProgramStageCtx {
  g: GraphHandle;
  slug: string;
  name: string;
  businessId: string;
  now: () => number;
  write: (stage: OnboardStage, w: GraphWrite) => Promise<void>;
  stage: (s: OnboardStage, text: string) => void;
  send: (e: OnboardEvent) => void;
  tenantOpts?: TenantOpts;
  retry: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface ProfileInput { industry?: string; vertical?: string; country?: string; currency?: string; locale?: string; timeZone?: string; domain?: string }

export interface ProfileResult { region: ResolvedRegion; template: IndustryTemplate; today: string }

interface StoredBusiness {
  country: string | null; currency: string | null; locale: string | null; timeZone: string | null; industry: string | null;
  templateKey: string | null; vertical: string | null; domain: string | null; city: string | null;
}

// ---------- profile ----------

export async function profileStage(c: ProgramStageCtx, input: ProfileInput): Promise<ProfileResult> {
  c.stage("profile", "Setting your country, currency, time zone and industry template");
  const [b] = await c.retry(() => c.g.roQuery<StoredBusiness>(
    `MATCH (b:Business {id:$id}) RETURN b.country AS country, b.currency AS currency, b.locale AS locale, b.timeZone AS timeZone,
       b.industry AS industry, b.templateKey AS templateKey, b.vertical AS vertical, b.domain AS domain, b.city AS city`, { id: c.businessId }));
  const stored: Partial<StoredBusiness> = b ?? {};
  const region = resolveRegion({ ...input, domain: input.domain ?? stored.domain ?? undefined }, stored);
  const told = input.vertical ?? input.industry;
  const template = (!told && templateByKey(stored.templateKey)) || templateFor(told ?? stored.industry);
  const props: Record<string, string> = { templateKey: template.key, vertical: input.vertical ?? stored.vertical ?? template.name };
  for (const k of ["country", "countryCode", "currency", "locale", "timeZone", "privacyRegime", "weekStart"] as const) {
    const v = region[k];
    if (v) props[k] = v;
  }
  await c.write("profile", { nodes: [{ type: "Business", id: c.businessId, name: c.name, props }], edges: [], observations: [] });
  await c.retry(() => ensureTenant({
    slug: c.slug, name: c.name, ...(region.country ? { country: region.country } : {}), ...(region.currency ? { currency: region.currency } : {}),
    ...(region.locale ? { locale: region.locale } : {}), ...(region.timeZone ? { timeZone: region.timeZone } : {}), templateKey: template.key,
  }, c.tenantOpts));
  return { region, template, today: localDate(c.now(), region.timeZone) };
}

// ---------- goals ----------

export interface GoalsResult { program: string; created: boolean; goals: string[]; startDate: string }

export async function goalsStage(c: ProgramStageCtx, p: ProfileResult): Promise<GoalsResult> {
  const owners = goalOwners(p.template);
  c.stage("goals", `Setting ${p.template.goals.length} goals from the ${p.template.name.toLowerCase()} template: ${p.template.goals
    .map((t) => `${t.name} (${agentById(t.owner)?.name ?? t.owner})`).join(", ")}`);
  for (const o of owners) await c.retry(() => ensureAgentNode(c.g, o, c.now()));
  const r = await c.retry(() => programAndGoalsWrite(c.g, {
    slug: c.slug, businessId: c.businessId, businessName: c.name, template: p.template, now: c.now(), startDate: p.today,
    ...(p.region.timeZone ? { timeZone: p.region.timeZone } : {}),
  }));
  await c.write("goals", r.write);
  return { program: r.program, created: r.created, goals: r.goals, startDate: r.startDate };
}

// ---------- baseline ----------

export async function baselineStage(c: ProgramStageCtx, p: ProfileResult, goals: GoalsResult): Promise<BaselineResult[]> {
  c.stage("baseline", "Locking Day-0 baselines from the numbers already in the graph (none are made up)");
  const rows = await c.retry(() => programGoals(c.g, goals.program));
  const { write, results } = await baselinesWrite(c.g, { goals: rows, businessId: c.businessId, today: p.today });
  await c.write("baseline", write);
  const locked = await c.retry(() => programGoals(c.g, goals.program));
  const cp = await checkpointWrite(c.g, { program: goals.program, day: 0, date: goals.startDate, now: c.now(), goals: locked });
  await c.write("baseline", cp);
  return results;
}

export function baselineLine(r: BaselineResult): string {
  if (r.baseline === null) return `${r.name}: baseline unknown (no data yet); target ${fmt(r.target)} (template)`;
  const at = r.reading ? ` (${shortDate(r.reading.windowStart)} to ${shortDate(r.reading.windowEnd)}${r.conf === "reported" ? ", reported" : ""})` : "";
  return `${r.name}: baseline ${fmt(r.baseline)}${at}; target ${fmt(r.target)}${r.targetBasis === "template" ? " (template)" : ""}`;
}

// ---------- capabilities ----------

export async function capabilitiesStage(c: ProgramStageCtx): Promise<CapabilityState[]> {
  c.stage("capabilities", "Checking what each source lets the team do: live, uploaded, public, benchmark or not connected");
  const { capabilities, errors } = await c.retry(() => syncCapabilities(c.g, { now: c.now(), businessId: c.businessId }));
  if (errors.length) throw new Error(errors.join("; "));
  // the ladder wrote its nodes itself; this tells the graph view they are there
  c.send({
    type: "nodes", nodes: capabilities.map((x) => ({ id: x.id, label: "Capability", name: `${x.name}: ${x.accessMode}` })),
    edges: capabilities.flatMap((x) => [{ from: x.id, type: "PART_OF", to: c.businessId }, ...x.dependsOn.map((to) => ({ from: x.id, type: "DEPENDS_ON", to }))]),
  });
  return capabilities;
}
