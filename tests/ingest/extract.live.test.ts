// LIVE: one real extraction through the Agent SDK on the founder's subscription (haiku). Skipped unless
// ALLEVIA_LIVE_LLM=1; it costs plan usage, so run it by hand when the prompt or schema changes.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSdkRunner, extractDoc, resolveExtraction, type KnownEntity } from "../../src/ingest/extract.js";
import type { RawDoc } from "../../src/ingest/types.js";
import { sha256 } from "../../src/util/ids.js";

const text = readFileSync(new URL("../fixtures/extract/bakery-decision.md", import.meta.url), "utf8");
const doc: RawDoc = {
  id: "document:crumb-co-decision-pause-facebook", kind: "decision", title: "Decision: pause Facebook posts",
  path: "decisions/pause-facebook.md", text, asOf: "2026-09-30", hash: sha256(text),
};
const business: KnownEntity = { id: "business:crumb-co", type: "Business", name: "Crumb & Co." };

describe.skipIf(process.env.ALLEVIA_LIVE_LLM !== "1")("live extraction (Agent SDK, haiku)", () => {
  it("extracts a Decision BASED_ON the reach number, the channels and the follow-up task", { timeout: 300_000 }, async () => {
    const started = Date.now();
    const { extraction, cached } = await extractDoc(doc, { name: "Crumb & Co.", industry: "bakery" }, {
      runner: new AgentSdkRunner(), model: "haiku", cacheDir: mkdtempSync(join(tmpdir(), "allevia-live-")),
    });
    const { write, dropped } = await resolveExtraction(extraction, {
      docId: doc.id, asOf: doc.asOf, text, existing: new Map([[business.id, business]]), founderNames: ["Meher"],
    });
    console.log(JSON.stringify({ ms: Date.now() - started, cached, extraction, dropped: dropped.map((d) => d.reason) }, null, 1));
    console.log(JSON.stringify({
      nodes: write.nodes.map((n) => `${n.id} | ${n.name}`),
      edges: write.edges.filter((e) => !["MENTIONS", "SOURCED_FROM"].includes(e.type)).map((e) => `${e.from} -${e.type}(${e.conf})-> ${e.to}`),
      observations: write.observations.map((o) => `${o.metric} of ${o.subject} = ${o.value}${o.unit ?? ""} @ ${o.asOf}`),
    }, null, 1));

    expect(cached).toBe(false);
    const types = new Set(extraction.entities.map((e) => e.type));
    expect(types.has("Decision")).toBe(true);
    expect(types.has("Channel")).toBe(true);
    expect(write.nodes.some((n) => n.id === "channel:facebook")).toBe(true);
    const reach = write.observations.find((o) => o.value === 90);
    expect(reach).toBeDefined();
    expect(reach!.asOf).toBe("2026-09-28");
    expect(write.edges.some((e) => e.type === "BASED_ON" && e.from.startsWith("decision:") && e.to.startsWith("obs:"))).toBe(true);
    expect(write.edges.some((e) => e.type === "DECIDED" && e.from === "person:founder")).toBe(true);
    expect([...write.nodes.map((n) => n.id), ...write.edges.flatMap((e) => [e.from, e.to])].some((id) => /^(agent|team):allevia/.test(id))).toBe(false);
  });
});
