import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EMBED_MODEL, MODELS_DIR, embedPassages, embedQuery, entityText, prepare } from "../../src/ingest/embed.js";

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const modelPresent = existsSync(join(MODELS_DIR, EMBED_MODEL));

describe("embedding inputs", () => {
  it("prefixes and truncates", () => {
    expect(prepare("passage", "  55 new users  ")).toBe("passage: 55 new users");
    expect(prepare("query", "x".repeat(5000))).toHaveLength("query: ".length + 2000);
    expect(prepare("passage", `${"a".repeat(1999)}😀b`)).toBe(`passage: ${"a".repeat(1999)}`); // never half an emoji
  });

  it("describes an entity by name, type and summary", () => {
    expect(entityText({ name: "Google Search Console", type: "System", summary: "Google's search analytics tool." }))
      .toBe("Google Search Console (system). Google's search analytics tool.");
    expect(entityText({ name: "No jargon", type: "BrandRule" })).toBe("No jargon (brand rule).");
  });

  it("embeds nothing without loading the model", async () => {
    expect(await embedPassages([])).toEqual([]);
  });
});

describe.skipIf(!modelPresent)("e5-small embeddings (slow, needs models/)", () => {
  it("returns 384-dim unit vectors and finds the Hindi query's passage", { timeout: 120_000 }, async () => {
    const [signups, token] = await embedPassages(["55 new users signed up this week", "the Instagram token expires every 60 days"]);
    const q = await embedQuery("kitne naye users aaye is hafte");
    for (const v of [signups!, token!, q]) {
      expect(v).toHaveLength(384);
      expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-3);
    }
    expect(cos(q, signups!)).toBeGreaterThan(cos(q, token!));
  });

  it("batches more than 32 passages in input order", { timeout: 120_000 }, async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `passage number ${i}`);
    const vs = await embedPassages(texts);
    expect(vs).toHaveLength(40);
    const [again] = await embedPassages([texts[37]!]);
    expect(cos(vs[37]!, again!)).toBeGreaterThan(0.999);
  });
});
