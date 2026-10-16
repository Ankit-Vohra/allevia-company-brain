// "Does AI know you?" in the graph (graph audit G7): the firms the answers named instead are Competitor nodes (COMPETES_WITH
// the business) with an ai_named_count reading, each question is a Query node with a 0/1 ai_named reading, and the report
// Document MENTIONS both. Read back with real traversals; two runs build a history on the same nodes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { aiVisibilityDocId, aiVisibilityWrite, customerQuestions, storedAiRuns, type AiAnswer, type AiBusiness, type AiVisibilityRun } from "../../src/checkup/ai-visibility.js";
import { competitorId } from "../../src/publicdata/write.js";
import { testGraph } from "../helpers/graph.js";

const BIZ: AiBusiness = { name: "AV's Atelier", domain: "avsatelier.in", category: "interior architect", city: "Raipur" };
const QUESTIONS = customerQuestions(BIZ, 4);

const answer = (question: string, o: Partial<AiAnswer> = {}): AiAnswer => ({ question, answered: true, answer: "a", named: [], mentioned: false, cited: false, position: null, others: [], ...o });
const runOf = (asOf: string, answers: AiAnswer[]): AiVisibilityRun => {
  const answered = answers.filter((a) => a.answered).length;
  const mentioned = answers.filter((a) => a.mentioned).length;
  return { asOf, model: "sonnet", business: BIZ, answers, asked: answers.length, answered, mentioned, mentionPct: answered ? Math.round((100 * mentioned) / answered) : null };
};

// September: named in nothing; Studio Tara in three answers, Raipur Interiors in one; the last question got no answer
const SEPT = runOf("2026-09-15T09:00:00Z", [
  answer(QUESTIONS[0]!, { others: ["Studio Tara", "Raipur Interiors"] }),
  answer(QUESTIONS[1]!, { others: ["Studio Tara"] }),
  answer(QUESTIONS[2]!, { others: ["studio tara"] }),
  { ...answer(QUESTIONS[3]!), answered: false, error: "timed out" },
]);
// October: named in the first question (#2); Studio Tara still named twice
const OCT = runOf("2026-10-15T09:00:00Z", [
  answer(QUESTIONS[0]!, { mentioned: true, position: 2, others: ["Studio Tara"] }),
  answer(QUESTIONS[1]!, { others: ["Studio Tara"] }),
  answer(QUESTIONS[2]!),
  answer(QUESTIONS[3]!),
]);

describe("AI visibility as nodes and edges", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const q = <T>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:avs", name: BIZ.name }, Date.parse("2026-09-01T00:00:00Z"));
    for (const r of [SEPT, OCT]) {
      const s = await writeBatch(g, aiVisibilityWrite(r, "business:avs"), Date.parse(r.asOf));
      expect(s.errors).toEqual([]);
    }
  });
  afterAll(async () => { await cleanup(); });

  it("keeps the readings the report always had", async () => {
    const rows = await q<{ metric: string; value: number; day: string }>(
      `MATCH (o:Observation)-[m:MEASURES]->(:Business {id:'business:avs'}) WHERE m.until IS NULL AND o.metric STARTS WITH 'ai_'
       RETURN o.metric AS metric, o.value AS value, o.asOf AS day ORDER BY day, metric, o.id`);
    expect(rows).toEqual([
      { metric: "ai_mention_pct", value: 0, day: SEPT.asOf }, { metric: "ai_questions_answered", value: 3, day: SEPT.asOf },
      { metric: "ai_mention_pct", value: 25, day: OCT.asOf }, { metric: "ai_questions_answered", value: 4, day: OCT.asOf },
    ]);
  });

  it("each firm the answers named is a Competitor that COMPETES_WITH the business, once, however the name was cased", async () => {
    const rows = await q<{ id: string; name: string }>(
      "MATCH (c:Competitor)-[r:COMPETES_WITH]->(b:Business {id:'business:avs'}) WHERE r.until IS NULL RETURN c.id AS id, c.name AS name ORDER BY c.id");
    expect(rows).toEqual([
      { id: competitorId("Raipur Interiors"), name: "Raipur Interiors" },
      { id: competitorId("Studio Tara"), name: "Studio Tara" },
    ]);
  });

  it("the times each was named are readings that MEASURE the Competitor, one per run, sourced from that run's report", async () => {
    const rows = await q<{ firm: string; day: string; n: number; doc: string }>(
      `MATCH (o:Observation {metric:'ai_named_count'})-[m:MEASURES]->(c:Competitor), (o)-[s:SOURCED_FROM]->(d:Document)
       WHERE m.until IS NULL AND s.until IS NULL RETURN c.name AS firm, o.asOf AS day, o.value AS n, d.id AS doc ORDER BY firm, day, o.id`);
    expect(rows).toEqual([
      { firm: "Raipur Interiors", day: SEPT.asOf, n: 1, doc: aiVisibilityDocId(BIZ.name, SEPT.asOf) },
      { firm: "Studio Tara", day: SEPT.asOf, n: 3, doc: aiVisibilityDocId(BIZ.name, SEPT.asOf) },
      { firm: "Studio Tara", day: OCT.asOf, n: 2, doc: aiVisibilityDocId(BIZ.name, OCT.asOf) },
    ]);
  });

  it("each question asked is a Query the report MENTIONS, with a 0/1 reading that MEASURES it; no reading when there was no answer", async () => {
    const rows = await q<{ text: string; day: string; v: number }>(
      `MATCH (d:Document {checkup:'ai-visibility'})-[:MENTIONS]->(qn:Query)<-[m:MEASURES]-(o:Observation {metric:'ai_named'}), (o)-[:SOURCED_FROM]->(d)
       WHERE m.until IS NULL RETURN qn.text AS text, o.asOf AS day, o.value AS v ORDER BY text, day, o.id`);
    const by = (text: string) => rows.filter((r) => r.text === text).map((r) => [r.day, r.v]);
    expect(by(QUESTIONS[0]!)).toEqual([[SEPT.asOf, 0], [OCT.asOf, 1]]);
    expect(by(QUESTIONS[1]!)).toEqual([[SEPT.asOf, 0], [OCT.asOf, 0]]);
    expect(by(QUESTIONS[3]!)).toEqual([[OCT.asOf, 0]]); // September's question 4 failed: not counted as "not named"
    // all four questions are nodes either way, and they are marked as asked of an AI
    const nodes = await q<{ text: string; via: string }>("MATCH (qn:Query) RETURN qn.text AS text, qn.via AS via ORDER BY qn.id");
    expect(nodes.map((n) => n.text).sort()).toEqual([...QUESTIONS].sort());
    expect(new Set(nodes.map((n) => n.via))).toEqual(new Set(["ai-assistant"]));
  });

  it("the report MENTIONS every firm and question it names, so one hop from a run reaches what it found", async () => {
    const [r] = await q<{ firms: number; queries: number }>(
      `MATCH (d:Document {id:$doc})-[m:MENTIONS]->(x:Entity) WHERE m.until IS NULL
       WITH d, sum(CASE WHEN x:Competitor THEN 1 ELSE 0 END) AS firms, sum(CASE WHEN x:Query THEN 1 ELSE 0 END) AS queries RETURN firms, queries`,
      { doc: aiVisibilityDocId(BIZ.name, SEPT.asOf) });
    expect(r).toEqual({ firms: 2, queries: 4 });
  });

  it("storedAiRuns reads the firms named instead from the graph, newest run first", async () => {
    const [oct, sept] = await storedAiRuns(g, 2);
    expect(oct!.others).toEqual(["Studio Tara|2"]);
    expect(sept!.others).toEqual(["Studio Tara|3", "Raipur Interiors|1"]);
    expect(oct!.mentionPct).toBe(25);
  });

  it("a run stored before these edges existed still reads from its report's own list", async () => {
    // the old shape: the report Document and the business readings only
    const old = aiVisibilityWrite(runOf("2026-08-15T09:00:00Z", [answer(QUESTIONS[0]!, { others: ["Old Rival"] })]), "business:avs");
    const bare = { nodes: old.nodes, edges: [], observations: old.observations.filter((o) => o.subject === "business:avs") };
    expect((await writeBatch(g, bare, Date.parse("2026-08-15T09:00:00Z"))).errors).toEqual([]);
    const runs = await storedAiRuns(g, 5);
    expect(runs.map((r) => r.asOf.slice(0, 10))).toEqual(["2026-10-15", "2026-09-15", "2026-08-15"]);
    expect(runs[2]!.others).toEqual(["Old Rival|1"]);
  });
});
