// The daily team stand-up, one per business per day. Meera reviews what changed since yesterday (signals.ts), the team
// turns it into what is worth doing (opportunities.ts), Meera picks at most three with a one-line reason each and hands
// them to the right people with a purpose-first brief (choose.ts), and each is drafted and left waiting for the owner's
// OK (draft.ts). Today's note then leads with it ("Your team noticed 2 things and drafted them"), or says "Nothing new
// worth your time today" when nothing cleared the bar.
//
// Saved as Document {kind:'standup', date} PRODUCED by the Chief of Staff, MENTIONS every card, idea and person in it. One a
// day: a second run the same day returns the first unless forced, and a forced run only adds what is new (the same
// dedupe applies), so the scheduler and the CLI can both call it safely.
//
// Budgets: the stand-up never pays for a public-data lookup (it reads what earlier lookups left in the graph). A paid
// picture is allowed at most `paidPerDay` times per business per day (default 1, ALLEVIA_STANDUP_PAID_PER_DAY), and the
// image engine's own caps and quotes still apply on top (src/studio/credits.ts); otherwise posters use the free
// brand-colour ground.
import { AGENTS } from "../../shared/roster.js";
import { ensureAgentNode, existingIds, findBusinessId } from "../actions/shared.js";
import { openGraph, type GraphHandle } from "../graph/client.js";
import { closeEdge, upsertEdge, upsertNode } from "../graph/upsert.js";
import type { LlmRunner } from "../ingest/llm.js";
import { isoDate } from "../util/time.js";
import { choose, loadHistory, screen } from "./choose.js";
import { draftPick, type DraftedItem, type Drafters } from "./draft.js";
import { noteSection, readStandup, standupDocId, QUIET_LINE, type Reviewed, type Standup } from "./note.js";
import { opportunitiesFrom } from "./opportunities.js";
import { gatherSignals, type Signals } from "./signals.js";

export interface StandupOpts {
  graph?: GraphHandle;
  now?: number;
  since?: number;
  runner?: LlmRunner;           // Meera's choice; absent: the rule order chooses
  drafters: Drafters;
  paidPerDay?: number;
  force?: boolean;
  max?: number;
  minScore?: number;
  skills?: (agent: string, id: string) => { name: string; guidance: string } | undefined;
  log?: (line: string) => void;
}


export function paidPerDayFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ALLEVIA_STANDUP_PAID_PER_DAY);
  return Number.isFinite(n) && n >= 0 && env.ALLEVIA_STANDUP_PAID_PER_DAY?.trim() ? Math.floor(n) : 1;
}

function reviewedOf(s: Signals): Reviewed {
  return {
    newNumbers: s.numbers.count, bigMoves: s.numbers.changes.length, uploads: s.uploads.length, goals: s.goals.length,
    goalsMoved: s.goals.filter((x) => x.was && x.was !== x.status && x.status !== "no_data").length, decisions: s.decisions.length,
    saidNo: s.decisions.filter((d) => d.status === "rejected").length, learned: s.learned, publicData: s.publicData, reviews: s.reviews.length,
    competitorMoves: s.competitors.filter((c) => c.prev !== null && c.prev !== c.value).length, websiteChecked: s.website.checked,
    websiteFails: s.website.fails.length, dates: s.dates.slice(0, 3).map((d) => d.name), openIdeas: s.findings.length,
  };
}

export async function runStandup(tenant: string, opts: StandupOpts): Promise<Standup> {
  const g = opts.graph ?? (await openGraph(tenant));
  const now = opts.now ?? Date.now();
  const log = opts.log ?? (() => undefined);
  const date = isoDate(now);
  const id = standupDocId(tenant, date);
  const before = await readStandup(g, date);
  if (before && !opts.force) return { ...before, reused: true };

  const businessId = await findBusinessId(g, tenant);
  const signals = await gatherSignals(g, { now, tenant, businessId, ...(opts.since !== undefined ? { since: opts.since } : {}) });
  const opps = opportunitiesFrom(signals);
  const screened = screen(opps, await loadHistory(g, now), now, opts.minScore !== undefined ? { minScore: opts.minScore } : {});
  const choice = await choose(screened.kept, { ...(opts.runner ? { runner: opts.runner } : {}), business: signals.business, today: signals.today, ...(opts.max ? { max: opts.max } : {}), log });
  log(`stand-up ${tenant}: ${opps.length} opportunities, ${screened.kept.length} cleared the bar, ${choice.picks.length} picked by ${choice.by === "meera" ? "Meera" : "the rule order"}`);

  const paidPerDay = opts.paidPerDay ?? paidPerDayFromEnv();
  let paidUsed = before?.paidUsed ?? 0;
  const items: DraftedItem[] = [];
  for (const p of choice.picks) {
    const d = await draftPick(g, p, {
      tenant, businessId, businessName: signals.business.name, ...(signals.business.domain ? { domain: signals.business.domain } : {}), now, turnId: `standup-${tenant}-${date}`,
      drafters: opts.drafters, paidLeft: Math.max(0, paidPerDay - paidUsed), ...(opts.skills ? { skills: opts.skills } : {}), log,
    });
    if (d.paid) paidUsed++;
    items.push(d);
    log(`stand-up ${tenant}: ${d.status === "drafted" ? "drafted" : "could not draft"} "${d.title}"${d.approvalId ? ` (${d.approvalId})` : ""}${d.notes.length ? ` · ${d.notes.join(" · ")}` : ""}`);
  }

  const all = [...(before?.items ?? []), ...items.filter((i) => !(before?.items ?? []).some((b) => b.key === i.key && b.status === "drafted"))];
  const { heading, lines } = noteSection(all, screened.lessons);
  const attendees = ["chief-of-staff", ...new Set(all.filter((i) => i.status === "drafted").map((i) => i.agent))].filter((a) => AGENTS.some((x) => x.id === a));
  const quiet = !all.some((i) => i.status === "drafted");
  const standup: Standup = {
    id, tenant, date, localDate: signals.today, generatedAt: now, quiet, by: choice.by, items: all, heading, lines, reviewed: reviewedOf(signals),
    considered: opps.length, skipped: screened.skipped.slice(0, 20), lessons: screened.lessons, attendees, paidUsed,
  };

  const chief = await ensureAgentNode(g, "chief-of-staff", now);
  await upsertNode(g, {
    type: "Document", id, name: `Team stand-up, ${date}`, summary: quiet ? QUIET_LINE : heading,
    props: {
      kind: "standup", tenant, date, localDate: signals.today, generatedAt: now, quiet, by: choice.by, heading, lines: JSON.stringify(lines),
      items: JSON.stringify(all), reviewed: JSON.stringify(standup.reviewed), considered: opps.length, skipped: JSON.stringify(standup.skipped),
      lessons: JSON.stringify(screened.lessons), attendees: JSON.stringify(attendees), paidUsed, since: signals.since,
    },
    asOf: date,
  }, now);
  await upsertEdge(g, { from: chief, type: "PRODUCED", to: id }, now);
  const mentions = [...new Set(all.flatMap((i) => [i.approvalId, i.recommendationId].filter((x): x is string => !!x)))];
  for (const a of attendees) mentions.push(await ensureAgentNode(g, a, now));
  const present = await existingIds(g, mentions);
  const had = await g.roQuery<{ id: string }>("MATCH (:Entity:Document {id:$id})-[m:MENTIONS]->(x:Entity) WHERE m.until IS NULL RETURN x.id AS id", { id });
  for (const m of mentions) if (present.has(m)) await upsertEdge(g, { from: id, type: "MENTIONS", to: m }, now);
  for (const h of had) if (!mentions.includes(h.id)) await closeEdge(g, id, "MENTIONS", h.id, now, "not in this stand-up");
  return standup;
}

export { readStandup, noteSection, QUIET_LINE, type Standup } from "./note.js";
