import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_PATTERNS, REL_TYPES, SEARCHABLE, type EntityType } from "../../src/graph/schema.js";
import {
  EXTRACTABLE_RELS, EXTRACTABLE_TYPES, LIMITS, cacheKey, extractDoc, extractionPrompt, extractionSchema, parseExtraction,
  type LlmRunner,
} from "../../src/ingest/extract.js";
import type { RawDoc } from "../../src/ingest/types.js";
import { sha256 } from "../../src/util/ids.js";

const text = "As of 28 Sep, reels drove 90% of our reach. We decided to pause Facebook posts.";
const doc: RawDoc = { id: "document:note-1", kind: "decision", title: "Pause Facebook", text, asOf: "2026-09-30", hash: sha256(text) };
const biz = { name: "Crumb & Co.", industry: "bakery" };

type Obj = Record<string, any>;
const schema = extractionSchema() as Obj;
const items = (k: string): Obj => schema.properties[k].items;

describe("extraction ontology", () => {
  it("extracts searchable business types only, never bookkeeping or derived types", () => {
    for (const t of EXTRACTABLE_TYPES) expect(SEARCHABLE).toContain(t);
    for (const t of ["Document", "Chunk", "Observation", "Version", "Session", "Turn", "Approval", "Action", "Finding",
      "Recommendation", "Memory", "Metric", "Page", "Playbook", "Rule"] as EntityType[]) {
      expect(EXTRACTABLE_TYPES).not.toContain(t);
    }
    for (const t of ["Decision", "Channel", "Person", "Audience", "Need", "Feature", "BrandRule", "System", "Task", "Event"] as EntityType[]) {
      expect(EXTRACTABLE_TYPES).toContain(t);
    }
  });

  it("every extractable relationship has an allowed pattern between extractable types, and provenance is left to the pipeline", () => {
    const ends = new Set<string>([...EXTRACTABLE_TYPES, "Observation", "*"]);
    for (const r of EXTRACTABLE_RELS) {
      expect(REL_TYPES).toContain(r);
      expect(ALLOWED_PATTERNS.some(([f, rel, t]) => rel === r && ends.has(f) && f !== "*" && ends.has(t))).toBe(true);
    }
    for (const r of ["MENTIONS", "SOURCED_FROM", "KNOWS_ABOUT", "AUTHORED", "MEASURES", "HAS_CHUNK", "CITED", "CONTRADICTS"]) {
      expect(EXTRACTABLE_RELS).not.toContain(r);
    }
    expect(EXTRACTABLE_RELS).toEqual(expect.arrayContaining(["BASED_ON", "AFFECTS", "OWNS", "DECIDED", "TARGETS", "HAS_NEED", "SOLVES", "PUBLISHED_ON"]));
  });
});

describe("extractionSchema", () => {
  it("pins entity types, relationship types and endpoints to the ontology with enums", () => {
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["entities", "relations", "observations"]);
    expect(items("entities").properties.type.enum).toEqual(EXTRACTABLE_TYPES);
    expect(items("relations").properties.type.enum).toEqual(EXTRACTABLE_RELS);
    expect(items("relations").properties.fromType.enum).toEqual(EXTRACTABLE_TYPES);
    expect(items("relations").properties.toType.enum).toEqual([...EXTRACTABLE_TYPES, "Observation"]);
    expect(items("observations").properties.subjectType.enum).toEqual(EXTRACTABLE_TYPES);
    for (const r of items("relations").properties.type.enum as string[]) expect(REL_TYPES).toContain(r);
  });

  it("caps list sizes and requires evidence and confidence", () => {
    expect(schema.properties.entities.maxItems).toBe(LIMITS.entities);
    expect(schema.properties.relations.maxItems).toBe(LIMITS.relations);
    expect(schema.properties.observations.maxItems).toBe(LIMITS.observations);
    expect(items("entities").required).toEqual(expect.arrayContaining(["type", "name", "summary"]));
    expect(items("relations").required).toEqual(expect.arrayContaining(["from", "fromType", "type", "to", "toType", "evidence", "conf"]));
    expect(items("observations").required).toEqual(expect.arrayContaining(["ref", "metric", "subject", "subjectType", "value", "evidence"]));
    expect(items("relations").properties.conf).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
  });
});

describe("extractionPrompt", () => {
  it("gives the business, the document and every allowed type and relationship", () => {
    const { system, prompt } = extractionPrompt(doc, biz);
    expect(system).toContain("Crumb & Co.");
    expect(system).toContain("bakery");
    for (const t of EXTRACTABLE_TYPES) expect(system).toMatch(new RegExp(`^- ${t}: `, "m"));
    for (const r of EXTRACTABLE_RELS) expect(system).toMatch(new RegExp(`^  - ${r} `, "m"));
    expect(system).toMatch(/verbatim/i);
    expect(system).toMatch(/fewer/i);
    expect(prompt).toContain("Pause Facebook");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("2026-09-30");
    expect(prompt).toContain(text);
  });

  it("truncates very long documents", () => {
    const long = { ...doc, text: "x".repeat(LIMITS.docChars + 500) };
    const { prompt } = extractionPrompt(long, biz);
    expect(prompt).not.toContain("x".repeat(LIMITS.docChars + 1));
    expect(prompt).toMatch(/truncated/);
  });
});

describe("parseExtraction", () => {
  it("rejects a non-object and keeps only well-formed items", () => {
    expect(() => parseExtraction("nope")).toThrow();
    const ex = parseExtraction({
      entities: [{ type: "Channel", name: "Instagram", summary: "s", aliases: ["IG", 3] }, { type: "Channel" }],
      relations: [{ from: "a", fromType: "Decision", type: "AFFECTS", to: "b", toType: "Channel", evidence: "q", conf: "0.8" }, { from: "a" }],
      observations: [{ ref: "o1", metric: "reach", subject: "Instagram", subjectType: "Channel", value: "1,200", evidence: "q" }, { metric: "x" }],
    });
    expect(ex.entities).toEqual([{ type: "Channel", name: "Instagram", summary: "s", aliases: ["IG"] }]);
    expect(ex.relations).toHaveLength(1);
    expect(ex.relations[0]!.conf).toBe(0.8);
    expect(ex.observations).toHaveLength(1);
    expect(ex.observations[0]!.value).toBe(1200);
    expect(parseExtraction({})).toEqual({ entities: [], relations: [], observations: [] });
  });
});

describe("extractDoc cache", () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "allevia-extract-"));
  });

  const fakeRunner = () => {
    const calls: Array<{ system: string; prompt: string; schema: object; model: string }> = [];
    const runner: LlmRunner = {
      async structured(input) {
        calls.push(input);
        return { entities: [{ type: "Channel", name: "Facebook", summary: "Paused." }], relations: [], observations: [] };
      },
    };
    return { runner, calls };
  };

  it("calls the runner once with the schema and model, then serves the cache", async () => {
    const { runner, calls } = fakeRunner();
    const a = await extractDoc(doc, biz, { runner, model: "haiku", cacheDir });
    expect(a.cached).toBe(false);
    expect(a.extraction.entities[0]!.name).toBe("Facebook");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("haiku");
    expect(calls[0]!.schema).toEqual(extractionSchema());
    const b = await extractDoc(doc, biz, { runner, model: "haiku", cacheDir });
    expect(b).toEqual({ extraction: a.extraction, cached: true });
    expect(calls).toHaveLength(1);
    expect(readdirSync(cacheDir)).toEqual([`${cacheKey(doc, "haiku")}.json`]);
  });

  it("misses when the text, the model, the ontology or the prompt version changes", async () => {
    const { runner, calls } = fakeRunner();
    await extractDoc(doc, biz, { runner, model: "haiku", cacheDir });
    await extractDoc(doc, biz, { runner, model: "sonnet", cacheDir });
    await extractDoc({ ...doc, hash: sha256("other text") }, biz, { runner, model: "haiku", cacheDir });
    expect(calls).toHaveLength(3);
    const base = cacheKey(doc, "haiku");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(doc, "haiku", { ontology: 999, prompt: 1 })).not.toBe(base);
    expect(cacheKey(doc, "haiku", { ontology: 1, prompt: 999 })).not.toBe(base);
  });

  it("treats a corrupt cache file as a miss and does not cache a failed call", async () => {
    const { runner, calls } = fakeRunner();
    writeFileSync(join(cacheDir, `${cacheKey(doc, "haiku")}.json`), "{not json");
    expect((await extractDoc(doc, biz, { runner, model: "haiku", cacheDir })).cached).toBe(false);
    expect(calls).toHaveLength(1);
    const failing: LlmRunner = { structured: async () => { throw new Error("boom"); } };
    const other = { ...doc, hash: sha256("x") };
    await expect(extractDoc(other, biz, { runner: failing, model: "haiku", cacheDir })).rejects.toThrow("boom");
    expect(readdirSync(cacheDir)).not.toContain(`${cacheKey(other, "haiku")}.json`);
  });
});
