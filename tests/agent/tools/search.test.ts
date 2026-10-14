import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { search } from "../../../src/agent/tools/search.js";
import { ftQuery, ftTerms } from "../../../src/agent/tools/common.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("search (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("turns free text into a safe OR query", () => {
    expect(ftTerms("Why did we pause daily stories? (Instagram) -x @foo:bar")).toEqual(["pause", "daily", "stories", "instagram", "foo", "bar"]);
    expect(ftQuery(["pause", "ig"])).toBe("pause|pause*|ig");
    expect(ftTerms("the and of")).toEqual([]);
  });

  it("finds a decision and the document behind it, with a snippet from the matching chunk", async () => {
    const r = await call(search, { query: "why did we pause daily stories" }, makeCtx(g));
    const hitIds = r.data.hits.map((h: { id: string }) => h.id);
    expect(hitIds.slice(0, 3)).toEqual(expect.arrayContaining(["decision:007-pause-daily-stories", "document:adr-007"]));
    const doc = r.data.hits.find((h: { id: string }) => h.id === "document:adr-007");
    expect(doc.snippet).toMatch(/stories/i);
    expect(doc.chunk).toMatch(/^chunk:adr-007:/);
    const dec = r.data.hits.find((h: { id: string }) => h.id === "decision:007-pause-daily-stories");
    expect(dec.via).toEqual(expect.arrayContaining(["text", "vector"]));
    // nodes: the hits plus the snippet chunks; edges: HAS_CHUNK; sources: the decision's document
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["decision:007-pause-daily-stories", "document:adr-007", doc.chunk]));
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "document:adr-007", type: "HAS_CHUNK", to: doc.chunk })]));
    expect(r.sources).toEqual(expect.arrayContaining([{ id: "document:adr-007", title: "ADR 007: Pause daily stories", asOf: "2026-09-20" }]));
  });

  it("leaves bookkeeping (turns, versions, observations) out unless asked", async () => {
    const r = await call(search, { query: "pause daily stories", limit: 25 }, makeCtx(g));
    const types = new Set(r.data.hits.map((h: { type: string }) => h.type));
    for (const t of ["Turn", "Version", "Session", "Observation", "Chunk"]) expect(types.has(t)).toBe(false);
    const turns = await call(search, { query: "pause daily stories", types: ["Turn"] }, makeCtx(g));
    expect(turns.data.hits.map((h: { id: string }) => h.id)).toEqual(["turn:t-001"]);
  });

  it("filters by type and caps the hit count", async () => {
    const r = await call(search, { query: "reel hooks instagram stories", types: ["Rule"], limit: 1 }, makeCtx(g));
    expect(r.data.hits).toHaveLength(1);
    expect(r.data.hits[0].type).toBe("Rule");
  });

  it("works without an embedder (text only) and says when nothing matches", async () => {
    const r = await call(search, { query: "token refresh" }, makeCtx(g, { embedQuery: undefined }));
    expect(r.data.hits.map((h: { id: string }) => h.id)).toEqual(expect.arrayContaining(["document:pending"]));
    for (const h of r.data.hits) expect(h.via.every((v: string) => !v.includes("vector"))).toBe(true);
    const none = await call(search, { query: "zzqx flurb" }, makeCtx(g, { embedQuery: undefined }));
    expect(none.data.hits).toEqual([]);
    expect(none.note).toMatch(/no match/i);
  });
});
