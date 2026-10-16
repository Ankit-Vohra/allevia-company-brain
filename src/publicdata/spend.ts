// What public-data lookups cost, as the business's own graph remembers it (graph audit G6). Every spend is an `apify_spend_usd`
// Observation on the Business with a spend Document (kind 'spend') as its source, the way the graph ledger of the paid keyword
// layer (src/checkup/dataforseo.ts) does it. So "what did watching rivals cost this business this month" is a query on its own
// graph, the same on every machine that writes to it, and a spend has a date, an actor and a source like every other number.
// The file ledger (ledger.ts) stays for what only a lock can do: the cap across every business in a day, and a reservation held
// while a run is in flight.
import type { GraphHandle } from "../graph/client.js";
import { businessId as businessIdOf } from "../graph/tenants.js";
import { writeBatch } from "../graph/upsert.js";
import type { GraphWrite } from "../ingest/types.js";
import { entityId } from "../util/ids.js";
import { usdWords } from "./actors.js";

export const SPEND_METRIC = "apify_spend_usd";

export interface SpendRecord {
  tenant: string;
  id: string;           // the ledger's reservation id: one per run
  actor: string;
  usd: number;          // what the run is counted at: the higher of the estimate and what Apify reported
  at: number;           // when it finished, epoch ms
  ok: boolean;          // false: it started and failed, and is still charged
}

export const spendDocId = (id: string): string => entityId("Document", `apify spend ${id}`);

/** The spend Document and the Observation on the Business that it sources. One Observation per run (the id carries the time). */
export function spendWrite(r: SpendRecord, businessId: string = businessIdOf(r.tenant)): GraphWrite {
  const asOf = new Date(r.at).toISOString();
  const doc = spendDocId(r.id);
  return {
    nodes: [{
      type: "Document", id: doc, name: `Public data lookup: ${r.actor}, ${asOf.slice(0, 10)}`, asOf,
      summary: `A public-data lookup through Apify (${r.actor}) counted at ${usdWords(r.usd)}${r.ok ? "" : ", which started and did not finish"}.`,
      props: { kind: "spend", title: `Apify ${r.actor}`, via: "apify", actor: r.actor, costUsd: r.usd, ok: r.ok, reservation: r.id },
    }],
    edges: [],
    observations: [{ subject: businessId, metric: SPEND_METRIC, value: r.usd, unit: "USD", asOf, src: doc, evidence: `Apify ${r.actor} lookup${r.ok ? "" : " (started, then failed)"}` }],
  };
}

type Read = Pick<GraphHandle, "roQuery">;

/** Dollars this business has spent on public-data lookups in a UTC month (YYYY-MM), from its Observations. */
export async function graphSpentThisMonth(g: Read, businessId: string, month: string): Promise<number> {
  const [r] = await g.roQuery<{ s: number | null }>(
    `MATCH (o:Observation)-[m:MEASURES]->(b:Entity {id:$b}) WHERE ID(m) >= 0 AND o.metric = $metric AND o.asOf STARTS WITH $month RETURN sum(o.value) AS s`,
    { b: businessId, metric: SPEND_METRIC, month });
  return Math.round((r?.s ?? 0) * 1000) / 1000;
}

/**
 * The two things the door (service.ts) needs from a business's graph: to record each spend, and to read what the business has
 * spent this month (the cap across machines: the server on one host and a script on another see the same graph).
 * `open` is how a tenant's graph is reached (openGraph in production, a test graph in tests).
 */
export function graphSpend(open: (tenant: string) => Promise<GraphHandle>): {
  onSpend: (r: SpendRecord) => Promise<void>;
  monthSpent: (tenant: string, at: number) => Promise<number>;
} {
  return {
    async onSpend(r) {
      const s = await writeBatch(await open(r.tenant), spendWrite(r), r.at);
      if (s.errors.length) throw new Error(`${s.errors.length} graph write(s) failed, first: ${s.errors[0]!.error}`);
    },
    async monthSpent(tenant, at) {
      return graphSpentThisMonth(await open(tenant), businessIdOf(tenant), new Date(at).toISOString().slice(0, 7));
    },
  };
}
