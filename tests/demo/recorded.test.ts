// The recorded copy of the synthetic business (src/demo/recorded/shiftly-hero.jsonl): a db:export file of Shiftly after four
// live runs on the Claude subscription, loaded by `seed-demo --recorded` so the public read-only mode has answers to replay.
// It must stay the same business `seedGrowth` builds, hold showcase turns whose logs replay, and carry nothing private.
import { describe, it, expect, afterAll } from "vitest";
import { loadConfig } from "../../src/config.js";
import { openGraphByName } from "../../src/graph/client.js";
import { importDump, readDump } from "../../src/graph/transfer.js";
import { findSensitive } from "../../src/ingest/redact.js";
import { seedGrowth } from "../../src/demo/growth.js";
import { RECORDED_HERO_FILE } from "../../src/cli/demo.js";
import { testGraph, testGraphName } from "../helpers/graph.js";

const dump = readDump(RECORDED_HERO_FILE); // refuses a file whose counts or digest do not match its lines
const turns = dump.nodes.filter((n) => n.l.includes("Turn"));
const showcase = turns.filter((n) => n.p.showcase === true);

describe("the recorded Shiftly copy", () => {
  it("holds showcase turns that public mode can replay: the hero question first, each with a log, an answer and passing checks", () => {
    expect(showcase.length).toBeGreaterThanOrEqual(4);
    expect(showcase.some((t) => /why did sign-?ups drop this week/i.test(String(t.p.question)))).toBe(true);
    // the README links straight to this thread (/ask/session%3A2026-10-16-ec0314ed?tenant=demo_growth)
    const heroThread = dump.nodes.find((n) => n.l.includes("Session") && n.p.id === "session:2026-10-16-ec0314ed");
    expect(heroThread?.p.name).toMatch(/why did sign-?ups drop this week/i);
    for (const t of showcase) {
      const events = JSON.parse(String(t.p.events)) as Array<{ type: string }>;
      expect(events.length, String(t.p.question)).toBeGreaterThan(10);
      expect(events.at(-1)?.type).toBe("final");
      expect(String(t.p.answer).length).toBeGreaterThan(200);
      expect(t.p.status).toBe("ok");
      const checks = JSON.parse(String(t.p.checks)) as Record<string, unknown>;
      expect(checks.citationsValid, String(t.p.question)).toBe(true);
      expect(checks.numbersGrounded, String(t.p.question)).toBe(true);
    }
    // nothing else is hidden in the file except the business's own earlier thread, which the plain seed writes too
    expect(turns.filter((t) => t.p.showcase !== true).map((t) => t.p.id)).toEqual(["turn:growth-001"]);
  });

  it("is the business seedGrowth builds: every entity of the plain seed is in the copy with the same name", async () => {
    const { g, cleanup } = await testGraph();
    try {
      await seedGrowth(g);
      const seeded = await g.roQuery<{ id: string; name: string | null }>("MATCH (n:Entity) RETURN n.id AS id, n.name AS name ORDER BY id");
      const recorded = new Map(dump.nodes.filter((n) => n.l.includes("Entity")).map((n) => [String(n.p.id), n.p.name]));
      expect(seeded.length).toBeGreaterThan(40);
      const missing = seeded.filter((s) => !recorded.has(s.id) || recorded.get(s.id) !== s.name).map((s) => s.id);
      expect(missing).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("carries nothing the redaction detectors would remove", () => {
    const hits: string[] = [];
    for (const n of dump.nodes) {
      for (const [k, v] of Object.entries(n.p)) {
        if (typeof v !== "string") continue;
        // the Sales demo's made-up people use a reserved .example address and a patterned number (as the hygiene test allows)
        const madeUp = (h: { kind: string; match: string }) => (h.kind === "email" && /\.example$/i.test(h.match)) || (h.kind === "phone" && /(\d)\1{4,}/.test(h.match.replace(/\D/g, "")));
        for (const h of findSensitive(v)) if (!madeUp(h)) hits.push(`${String(n.p.id)}.${k}: ${h.kind}`);
      }
    }
    expect(hits).toEqual([]);
  });

  const name = testGraphName();
  afterAll(async () => { await (await openGraphByName(name)).drop(); });
  it("loads into a graph and verifies (what `seed-demo --recorded` does)", async () => {
    const r = await importDump(dump, loadConfig().falkordbUrl, { graph: name, replace: true });
    expect(r.verify.ok, r.verify.problems.join("; ")).toBe(true);
    expect(r.schema.problems).toEqual([]);
    const g = await openGraphByName(name);
    const [row] = await g.roQuery<{ n: number }>("MATCH (t:Turn) WHERE t.showcase = true RETURN count(t) AS n");
    expect(row?.n).toBe(showcase.length);
  });
});
