// The overview map's fallbacks (no stored rank/community yet) and onboarding's slug rule. Pure, no database.
import { describe, it, expect } from "vitest";
import { localCommunities, localPageRank } from "../../src/server/local-graph.js";
import { slugFor } from "../../src/server/app.js";

const e = (from: string, to: string) => ({ from, to });

describe("local graph algorithms", () => {
  // two triangles joined by one bridge (c-d), plus an isolated node
  const ids = ["a", "b", "c", "d", "e", "f", "z"];
  const edges = [e("a", "b"), e("b", "c"), e("c", "a"), e("d", "e"), e("e", "f"), e("f", "d"), e("c", "d")];

  it("PageRank: scaled 0–1, the bridge ends rank highest, the isolated node lowest", () => {
    const r = localPageRank(ids, edges);
    expect(Math.max(...r.values())).toBe(1);
    for (const v of r.values()) expect(v).toBeGreaterThan(0);
    expect(r.get("c")).toBe(1);
    expect(r.get("d")).toBe(1);
    expect(r.get("z")).toBe(Math.min(...r.values()));
    expect(localPageRank([], [])).toEqual(new Map());
  });

  it("communities: each triangle is one community, numbered by size, deterministic", () => {
    const c = localCommunities(ids, edges);
    expect(c.get("a")).toBe(c.get("b"));
    expect(c.get("b")).toBe(c.get("c"));
    expect(c.get("d")).toBe(c.get("e"));
    expect(c.get("e")).toBe(c.get("f"));
    expect(c.get("a")).not.toBe(c.get("d"));
    expect(c.get("z")).toBe(2); // the singleton comes after the two triangles
    expect(localCommunities([...ids].reverse(), [...edges].reverse())).toEqual(c);
  });
});

describe("slugFor", () => {
  it("makes a tenant slug from the name, else from the website host", () => {
    expect(slugFor("Kestrel & Oak", "kestrel.example")).toBe("kestrel_oak");
    expect(slugFor("  Café Rouge — Leeds ", "x.example")).toBe("cafe_rouge_leeds");
    expect(slugFor("आमदनी", "https://www.aamdani.example/jobs")).toBe("aamdani");
    expect(slugFor("!!!", "not a url")).toBe("not_a_url");
  });
});
