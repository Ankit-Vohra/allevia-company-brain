// What Meera reads at the daily stand-up: everything that changed in the business's own graph since the last one, plus
// the dates coming up in its country. Read-only, numbers straight from the graph (never from a model):
//   numbers      new readings and the two biggest like-for-like moves (the brief's own changesSince)
//   uploads      spreadsheets the owner added
//   goals        each goal's state now, and what it was at the last note (a move is news)
//   decisions    cards the owner said OK or No to, or edited
//   learned      things the team learned from the owner's edits
//   reviews      Google reviews of the business with no reply yet (only when public data was looked up)
//   competitors  new public numbers on a competitor, with the reading before (only when public data was looked up)
//   website      the website check-up: failing checks, how many pages, and which started failing since
//   dates        festivals, shopping days and seasons in the next weeks (calendar.ts)
//   findings     open ideas from the existing rule checks (src/insights/detectors.ts), with their card if any
import type { GraphHandle } from "../graph/client.js";
import { changesSince, goalPulse, type Change, type GoalPulse } from "../insights/brief.js";
import { DAY_MS } from "../insights/text.js";
import { localDate, regionOf, regionOfDomain } from "../onboard/region.js";
import { upcomingDates, type Upcoming } from "./calendar.js";

type Read = Pick<GraphHandle, "roQuery">;

export interface BusinessInfo {
  id: string | null; name: string; industry?: string; city?: string; country?: string; countryCode?: string; timeZone?: string; domain?: string;
}

export interface ReviewSignal { id: string; stars: number | null; text: string; author: string | null; publishedAt: string | null }
export interface CompetitorSignal { id: string; name: string; metric: string; value: number; prev: number | null; obsId: string }
export interface WebsiteFail { ruleId: string; name: string; severity: string; fix: string | null; issueType: string | null; pages: number; newPages: number; page: string | null; pageName: string | null; pageUrl: string | null; evidence: string | null }
export interface FindingSignal {
  id: string; key: string; title: string; why: string; area: string; by: string | null; score: number; detector: string | null;
  cardId: string | null; cardKind: string | null; evidence: string[];
}
export interface DecisionSignal { id: string; title: string; kind: string; status: string; standupKind: string | null }

export interface Signals {
  tenant: string;
  business: BusinessInfo;
  now: number;
  since: number;
  today: string;             // the business's own date
  numbers: { count: number; changes: Change[] };
  uploads: Array<{ id: string; name: string }>;
  goals: Array<GoalPulse & { was: string | null }>;
  decisions: DecisionSignal[];
  learned: number;
  publicData: boolean;
  reviews: ReviewSignal[];
  competitors: CompetitorSignal[];
  website: { checked: boolean; fails: WebsiteFail[] };
  dates: Upcoming[];
  findings: FindingSignal[];
}

const READ_MS = 20_000;
const ro = <T>(g: Read, q: string, p: Record<string, unknown> = {}): Promise<T[]> => g.roQuery<T>(q, p, { timeoutMs: READ_MS });
const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function businessInfo(g: Read, businessId: string | null, tenant: string): Promise<BusinessInfo> {
  const [b] = businessId ? await ro<Record<string, unknown>>(g,
    `MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name, b.industry AS industry, b.city AS city, b.country AS country, b.timeZone AS timeZone,
       b.domain AS domain, b.description AS description LIMIT 1`, { id: businessId }) : [];
  const country = s(b?.country);
  const domain = s(b?.domain);
  const region = regionOf(country) ?? regionOfDomain(domain);
  return {
    id: businessId, name: s(b?.name) ?? tenant, ...(s(b?.industry) ? { industry: s(b?.industry)! } : {}), ...(s(b?.city) ? { city: s(b?.city)! } : {}),
    ...(country ? { country } : {}), ...(region ? { countryCode: region.countryCode } : {}),
    ...(s(b?.timeZone) ?? region?.timeZone ? { timeZone: (s(b?.timeZone) ?? region?.timeZone)! } : {}), ...(domain ? { domain } : {}),
  };
}

export interface SignalOpts { now: number; since?: number; tenant: string; businessId: string | null; horizonDays?: number }

export async function gatherSignals(g: Read, o: SignalOpts): Promise<Signals> {
  const { now } = o;
  const business = await businessInfo(g, o.businessId, o.tenant);
  let since = o.since;
  if (since === undefined) {
    const [last] = await ro<{ at: number }>(g,
      "MATCH (d:Document) WHERE d.kind = 'standup' AND d.generatedAt < $now RETURN d.generatedAt AS at ORDER BY at DESC, d.id LIMIT 1", { now });
    since = last?.at && now - last.at < 7 * DAY_MS ? last.at : now - DAY_MS;
  }
  const today = localDate(now, business.timeZone);

  // goals: the state now, against the state the last note wrote back on each Goal
  const stored = await ro<{ id: string; status: string | null }>(g, "MATCH (gl:Goal) RETURN gl.id AS id, gl.status AS status ORDER BY id LIMIT 50");
  const goals = (await goalPulse(g, now, o.businessId)).map((p) => ({ ...p, was: stored.find((x) => x.id === p.id)?.status ?? null }));

  const numbers = await changesSince(g, since, now);
  const uploads = await ro<{ id: string; name: string }>(g,
    "MATCH (d:Document) WHERE d.kind = 'upload' AND coalesce(d.uploadedAt, 0) >= $since RETURN d.id AS id, d.name AS name ORDER BY d.uploadedAt DESC, id LIMIT 5", { since });
  const decisions = await ro<DecisionSignal>(g,
    `MATCH (a:Approval) WHERE coalesce(a.decidedAt, 0) >= $since
     RETURN a.id AS id, coalesce(a.title, a.name) AS title, a.kind AS kind, a.status AS status, a.standupKind AS standupKind
     ORDER BY a.decidedAt DESC, id LIMIT 20`, { since });
  const [lr] = await ro<{ n: number }>(g, "MATCH (r:Rule) WHERE r.kind = 'learned' AND coalesce(r.createdAt, 0) >= $since RETURN count(r) AS n", { since });

  // public data: only what an earlier lookup left in the graph (the stand-up never pays for a lookup by itself)
  const [pub] = await ro<{ n: number }>(g, "MATCH (d:Document) WHERE d.kind IN ['public', 'review'] RETURN count(d) AS n");
  const publicData = (pub?.n ?? 0) > 0;
  const reviews = publicData ? await ro<ReviewSignal>(g,
    `MATCH (d:Document) WHERE d.kind = 'review' AND coalesce(d.ownerReplied, false) = false AND coalesce(d.publishedAt, d.asOf, '') >= $from
     RETURN d.id AS id, d.stars AS stars, coalesce(d.summary, '') AS text, d.author AS author, coalesce(d.publishedAt, d.asOf) AS publishedAt
     ORDER BY coalesce(d.stars, 5), coalesce(d.publishedAt, d.asOf, '') DESC, id LIMIT 5`, { from: new Date(now - 45 * DAY_MS).toISOString().slice(0, 10) }) : [];
  const competitors = publicData ? await ro<CompetitorSignal>(g,
    `MATCH (o:Observation)-[m:MEASURES]->(c:Competitor) WHERE m.until IS NULL AND o.createdAt >= $since
     OPTIONAL MATCH (p:Observation)-[pm:MEASURES]->(c) WHERE pm.until IS NULL AND p.metric = o.metric AND coalesce(p.windowEnd, p.asOf) < coalesce(o.windowEnd, o.asOf)
     WITH o, c, p ORDER BY coalesce(p.windowEnd, p.asOf) DESC, p.id
     WITH o, c, collect(p)[0] AS p
     RETURN c.id AS id, coalesce(c.name, c.id) AS name, o.metric AS metric, o.value AS value, p.value AS prev, o.id AS obsId
     ORDER BY obsId LIMIT 20`, { since }) : [];

  // the website check-up (onboarding's crawl, or a later one)
  const [checked] = await ro<{ n: number }>(g, "MATCH (p:Page)-[f]->(r:Rule) WHERE f.until IS NULL AND type(f) IN ['FAILS', 'PASSES'] AND r.kind = 'seo-check' RETURN count(f) AS n");
  const fails = (checked?.n ?? 0) > 0 ? await ro<WebsiteFail>(g,
    `MATCH (p:Page)-[f:FAILS]->(r:Rule) WHERE f.until IS NULL AND r.kind = 'seo-check'
     WITH r, p, f ORDER BY coalesce(p.priority, 0) DESC, p.id
     WITH r, collect(p)[0] AS page, collect(f.evidence)[0] AS evidence, count(f) AS pages, sum(CASE WHEN coalesce(f.since, 0) >= $since THEN 1 ELSE 0 END) AS newPages
     RETURN r.id AS ruleId, coalesce(r.name, r.id) AS name, coalesce(r.severity, 'info') AS severity, coalesce(r.howToFix, r.text) AS fix, r.issueType AS issueType,
            pages, newPages, page.id AS page, page.name AS pageName, page.url AS pageUrl, evidence
     ORDER BY pages DESC, ruleId LIMIT 25`, { since }) : [];

  const findings = await ro<FindingSignal>(g,
    `MATCH (r:Recommendation) WHERE r.status = 'open' AND r.source = 'insights'
     OPTIONAL MATCH (r)-[pp:PROPOSES]->(a:Approval) WHERE pp.until IS NULL AND a.status = 'pending'
     OPTIONAL MATCH (r)-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL
     WITH r, a, collect(x.id) AS evidence
     WITH r, collect(a)[0] AS a, evidence
     RETURN r.id AS id, r.key AS key, r.name AS title, coalesce(r.summary, '') AS why, coalesce(r.area, '') AS area, r.by AS by, coalesce(r.score, 0) AS score,
            r.detector AS detector, a.id AS cardId, a.kind AS cardKind, evidence
     ORDER BY score DESC, id LIMIT 30`);

  return {
    tenant: o.tenant, business, now, since, today, numbers, uploads, goals, decisions, learned: lr?.n ?? 0, publicData, reviews, competitors,
    website: { checked: (checked?.n ?? 0) > 0, fails }, dates: upcomingDates(business.countryCode, today, o.horizonDays ?? 30), findings,
  };
}
