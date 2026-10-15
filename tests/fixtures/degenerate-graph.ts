// A graph built to break what sorts: seedMini (a realistic small company) plus a "swarm", where for every relationship
// the ontology allows, one hub has SWARM neighbours that are identical (same name, summary, dates, status, rank,
// embedding) joined by identical edges (same since, same until), live and closed. Every sort key then ties across
// 21 or more rows, which is what makes FalkorDB 6.0.2's sort panic (docs/notes/falkordb-nan-crash.md). On top of
// that, the numbers are degenerate: zero spend, zero impressions, zero clicks (every ratio is 0 / 0), campaigns and
// pages with no numbers at all, and hubs with nothing attached.
import type { GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { ALLOWED_PATTERNS, ENTITY_TYPES, SEARCHABLE, type EntityType, type RelType } from "../../src/graph/schema.js";
import { writeBatch, type ObservationInput } from "../../src/graph/upsert.js";
import { idPrefix } from "../../src/util/ids.js";
import { fakeEmbed, seedMini, SEED_NOW } from "./seed-graph.js";

export const SWARM = 24; // sorts only check their ordering from 21 rows up
export const hubId = (t: EntityType): string => `${idPrefix(t)}:swarm-hub`;
export const satId = (t: EntityType, i: number): string => `${idPrefix(t)}:swarm-${String(i).padStart(2, "0")}`;

const T0 = SEED_NOW - 40 * 86_400_000;
const CLOSED_AT = T0 + 1_000;
const DAY = "2026-10-10";
const SWARM_TEXT = "swarm item";

// Handled apart from the generic swarm: numbers (Observation), snapshots (Version) and passages (Chunk).
const SPECIAL = new Set<EntityType>(["Observation", "Version", "Chunk"]);
export const SWARM_TYPES: EntityType[] = ENTITY_TYPES.filter((t) => !SPECIAL.has(t));

// What a type needs for its tools to treat a satellite as one of theirs. Identical for every satellite of the type.
const EXTRA: Partial<Record<EntityType, Record<string, unknown>>> = {
  Task: { status: "open", kind: "pending" },
  Decision: { status: "accepted", decidedAt: "2026-09-20" },
  Rule: { kind: "hook", severity: "high", rank: 0.5, text: "Swarm rule text", template: "swarm {n}", howToFix: "swarm fix" },
  Content: { format: "reel", publishedAt: "2026-09-12", caption: "swarm caption" },
  Campaign: { status: "active", objective: "leads" },
  Page: { url: "https://swarm.test/page", path: "/page", title: "Swarm page" },
  Channel: { platform: "instagram", status: "active" },
  System: { kind: "service", status: "running" },
  Document: { kind: "vault", title: "Swarm document" },
  Event: { kind: "outage", at: "2026-10-03" },
  Memory: { kind: "fact", text: "Swarm fact.", at: SEED_NOW },
  Turn: { question: "Swarm question?", answer: "Swarm answer.", at: SEED_NOW, status: "ok", checks: "{}", agents: ["chief-of-staff"] },
  Session: { channel: "web", startedAt: SEED_NOW },
  Recommendation: { status: "open", area: "content", confidence: 0.5, score: 0.5, by: "content-strategist" },
  Approval: { status: "pending", kind: "content_draft", payload: "{}" },
  Person: { role: "member" },
  Agent: { kind: "allevia" },
  Query: { text: "swarm query" },
  Goal: { status: "active" },
};

// A pattern that reaches any type ("*") is built for these only: the swarm is dense already.
const REPRESENTATIVE: EntityType[] = ["Task", "System", "Channel", "Document"];

// Every sort key (dates, status, rank, order) is identical across satellites. What they show of themselves is not:
// FalkorDB 6.0.2 only panicked when rows tied on the key but differed in the other columns, some null and some set
// (`asOf` present or absent, `simulated` true or absent, a summary or none, three names), so the swarm has both.
function props(t: EntityType, id: string, hub: boolean, i = 0): Record<string, unknown> {
  return {
    id, name: hub ? "Swarm hub" : `Swarm item ${i % 3}`,
    ...(i % 2 === 0 ? { summary: "Swarm item, one of many that look the same.", asOf: DAY } : {}),
    ...(i % 3 === 0 ? { simulated: true } : {}),
    src: "document:swarm-hub", createdAt: T0, updatedAt: T0, stateSince: T0, rev: 1, ...EXTRA[t],
  };
}

const chunks = <X>(xs: X[], n: number): X[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

// Vectors: most satellites share one vector (their scores tie exactly); every fourth has another, so a search sees one
// big group of tied scores among a few distinct ones, as the seed graph's did.
async function nodes(g: GraphHandle, label: EntityType, rows: Array<Record<string, unknown>>, vecProp?: string): Promise<void> {
  const same = vecProp ? Array.from(fakeEmbed(SWARM_TEXT)) : undefined;
  const other = vecProp ? Array.from(fakeEmbed("swarm other thing")) : undefined;
  for (const part of chunks(rows, 200)) {
    await g.query(
      `UNWIND $rows AS r CREATE (n:Entity:${label}) SET n = r.props${vecProp ? `, n.${vecProp} = vecf32(CASE WHEN r.alt THEN $other ELSE $same END)` : ""}`,
      { rows: part.map((props, i) => ({ props, alt: i % 4 === 3 })), ...(vecProp ? { same, other } : {}) });
  }
}

async function edges(g: GraphHandle, rel: RelType, rows: Array<{ f: string; t: string; p: Record<string, unknown> }>): Promise<void> {
  for (const part of chunks(rows, 500)) {
    await g.query(`UNWIND $rows AS r MATCH (a:Entity {id: r.f}), (b:Entity {id: r.t}) CREATE (a)-[x:${rel}]->(b) SET x = r.p`, { rows: part });
  }
}

const LIVE = { since: T0, recordedAt: T0 };
const CLOSED = { since: T0, recordedAt: T0, until: CLOSED_AT, retiredAt: CLOSED_AT, closedCost: 1_000_000, closeReason: "swarm" };
// Relationships whose history the tools read: they also get closed edges, all closed at the same instant.
const WITH_HISTORY = new Set<RelType>(["OWNS", "DEPENDS_ON", "BLOCKS", "AFFECTS", "MEMBER_OF", "KNOWS_ABOUT", "PART_OF", "MENTIONS", "DECIDED"]);

export async function seedDegenerate(g: GraphHandle): Promise<void> {
  await seedMini(g); // creates the indexes too
  await ensureIndexes(g);

  // ---- nodes: a hub and SWARM identical satellites of every type ----
  for (const t of SWARM_TYPES) {
    const rows = [props(t, hubId(t), true), ...Array.from({ length: SWARM }, (_, i) => props(t, satId(t, i), false, i))];
    await nodes(g, t, rows, SEARCHABLE.includes(t) ? "embedding" : undefined);
  }
  // Versions of the Task hub, identical; passages of the Document hub, identical.
  await nodes(g, "Version", Array.from({ length: SWARM }, (_, i) => ({
    id: `version:swarm-${i}`, name: "", of: hubId("Task"), props: "{\"status\":\"open\"}", changed: ["status"], since: T0, until: CLOSED_AT, createdAt: T0, updatedAt: T0,
  })));
  await nodes(g, "Chunk", Array.from({ length: SWARM }, (_, i) => ({
    id: `chunk:swarm-${i}`, name: "Swarm document §", text: "Swarm item passage, one of many that look the same.", ord: 0, createdAt: T0, updatedAt: T0, stateSince: T0, rev: 1,
  })), "textEmbedding");

  // ---- edges: every pattern the ontology allows, hub -> satellites and satellites -> hub ----
  const byRel = new Map<RelType, Array<{ f: string; t: string; p: Record<string, unknown> }>>();
  const add = (rel: RelType, f: string, t: string, p: Record<string, unknown>) => byRel.set(rel, [...(byRel.get(rel) ?? []), { f, t, p }]);
  const concrete = (e: EntityType | "*"): EntityType[] => (e === "*" ? REPRESENTATIVE : SPECIAL.has(e) ? [] : [e]);
  for (const [from, rel, to] of ALLOWED_PATTERNS) {
    for (const a of concrete(from)) for (const b of concrete(to)) {
      for (let i = 0; i < SWARM; i++) {
        add(rel, hubId(a), satId(b, i), LIVE);
        add(rel, satId(a, i), hubId(b), LIVE);
        if (WITH_HISTORY.has(rel)) {
          add(rel, hubId(a), satId(b, i), CLOSED);
          add(rel, satId(a, i), hubId(b), CLOSED);
        }
      }
    }
  }
  for (const [rel, rows] of byRel) await edges(g, rel, rows);
  await edges(g, "HAD_VERSION", Array.from({ length: SWARM }, (_, i) => ({ f: hubId("Task"), t: `version:swarm-${i}`, p: { since: T0, recordedAt: T0 } })));
  await edges(g, "HAS_CHUNK", Array.from({ length: SWARM }, (_, i) => ({ f: hubId("Document"), t: `chunk:swarm-${i}`, p: LIVE })));

  // ---- numbers, through the ingestion path: all zero, every ratio 0 / 0, some subjects with none at all ----
  const obs: ObservationInput[] = [];
  const day = (d: number): string => `2026-10-${String(8 + d).padStart(2, "0")}`;
  const meas = (subject: string, metric: string, d: number, unit?: string): ObservationInput =>
    ({ subject, metric, value: 0, ...(unit ? { unit } : {}), windowStart: day(d), windowEnd: day(d), asOf: day(d), src: "document:swarm-hub" });
  for (let i = 0; i < SWARM - 6; i++) { // the last six campaigns, pages and contents have no numbers at all
    for (let d = 0; d < 3; d++) {
      for (const m of ["spend", "impressions", "clicks", "conversions", "signups"]) obs.push(meas(satId("Campaign", i), m, d, m === "spend" ? "INR" : "count"));
    }
    for (const m of ["impressions", "clicks", "ctr"]) obs.push({ ...meas(satId("Page", i), m, 0), windowStart: "2026-09-12", windowEnd: DAY, asOf: DAY });
    obs.push({ ...meas(satId("Content", i), "views", 0, "count"), windowStart: undefined, windowEnd: DAY, asOf: DAY });
  }
  for (const subject of [hubId("Channel"), hubId("Business"), hubId("Campaign"), hubId("Page"), hubId("Content")]) {
    for (let d = 0; d < 3; d++) for (const m of ["followers", "signups", "spend", "impressions", "clicks", "conversions", "views"]) obs.push(meas(subject, m, d, "count"));
  }
  await writeBatch(g, { observations: obs }, T0);
}
