// The Brain map's logic (web/src/lib/brain-map.ts) and its kinds (web/src/lib/labels.ts): decoding the light map, what
// gets drawn (filters, crowded kinds, what must stay), the order "Watch it grow" replays, what the team is reading right
// now, the side panel's facts, "What breaks" drawn as a chain, and every word the owner reads (docs/owner-words.md).
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { ownerJargon } from "../../src/agent/style.js";
import {
  HIDDEN_AT_FIRST, askAbout, centreOf, decodeMap, factsOf, growFrames, growOrder, impactLine, impactLinks, kindTotals, knowsLine,
  labelFloor, mapHeadline, mergeReading, namesWords, oneLine, pickForMap, rankRadius, readingNow, readingWords, type BrainMapDto, type MapNode,
} from "../../web/src/lib/brain-map.js";
import { MAP_KINDS, chromaFor, hueFor, kindOf } from "../../web/src/lib/labels.js";

const node = (id: string, label: string, rank: number, over: Partial<MapNode> = {}): MapNode => ({ id, label, name: id.split(":")[1] ?? id, rank, ...over });

describe("the kinds and their colours", () => {
  it("every kind an owner would name, each with its own hue, none of them gold", () => {
    expect(MAP_KINDS.map((k) => k.name)).toEqual([
      "What you sell", "Customers", "People and teams", "Numbers", "Decisions and plans", "Posts and channels", "Website", "Documents and notes", "Tools",
    ]);
    const hues = MAP_KINDS.map((k) => k.hue);
    expect(new Set(hues).size).toBe(hues.length);
    for (const h of hues) expect(h < 55 || h > 115).toBe(true); // gold (85) is the lit path and what is being read
    for (const k of MAP_KINDS) expect(ownerJargon(k.name)).toEqual([]);
  });
  it("a label belongs to one kind, and its dot takes that kind's colour everywhere", () => {
    expect(kindOf("Observation").id).toBe("numbers");
    expect(kindOf("System").name).toBe("Tools");
    expect(kindOf("Agent").id).toBe("people");
    expect(hueFor("Product")).toBe(hueFor("Feature"));
    expect(chromaFor("Document")).toBeLessThan(chromaFor("Decision"));
    expect(kindOf("SomethingNew").id).toBe("other");
  });
});

describe("decoding the light map", () => {
  const dto: BrainMapDto = {
    nodes: [node("business:a", "Business", 1), node("channel:ig", "Channel", 0.4), node("system:db", "System", 0.2)],
    types: ["USES", "DEPENDS_ON"],
    links: [[0, 1, 0], [1, 2, 1], [2, 9, 0], [0, 1, 7]],
    counts: { Business: 1, Channel: 1, System: 1, Observation: 40, Chunk: 12 },
    totals: { things: 43, links: 2 },
    capped: false,
  };
  it("turns index triples back into links and drops any that point outside the lists", () => {
    const m = decodeMap(dto);
    expect(m.edges).toEqual([{ from: "business:a", type: "USES", to: "channel:ig" }, { from: "channel:ig", type: "DEPENDS_ON", to: "system:db" }]);
    expect(centreOf(m.nodes)).toBe("business:a");
  });
  it("counts the chips per kind for the whole brain, biggest first, passages left out", () => {
    expect(kindTotals(dto.counts)).toEqual([
      { id: "numbers", name: "Numbers", hue: kindOf("Observation").hue, count: 40 },
      { id: "people", name: "People and teams", hue: kindOf("Business").hue, count: 1 },
      { id: "posts", name: "Posts and channels", hue: kindOf("Channel").hue, count: 1 },
      { id: "tools", name: "Tools", hue: kindOf("System").hue, count: 1 },
    ]);
    expect(HIDDEN_AT_FIRST.has("numbers")).toBe(true);
  });
});

describe("what gets drawn", () => {
  const rules = Array.from({ length: 60 }, (_, i) => node(`rule:r${i}`, "Rule", 0.5 - i / 1000));
  const rest = Array.from({ length: 20 }, (_, i) => node(`task:t${i}`, "Task", 0.3 - i / 1000));
  const metric = node("metric:reach", "Metric", 0.9);
  const all = [...rules, ...rest, metric, node("business:a", "Business", 1)];
  const edges = [{ from: "business:a", type: "OWNS", to: "task:t0" }, { from: "metric:reach", type: "MEASURES", to: "business:a" }];

  it("the most important first, hidden kinds out, no kind over its share, and the cap kept", () => {
    const p = pickForMap(all, edges, { cap: 50, hidden: HIDDEN_AT_FIRST });
    expect(p.nodes[0]!.id).toBe("business:a");
    expect(p.nodes.some((n) => n.id === "metric:reach")).toBe(false);
    expect(p.nodes.filter((n) => n.label === "Rule")).toHaveLength(24); // max(24, 25% of 50)
    expect(p.nodes.length).toBeLessThanOrEqual(50);
    expect(p.edges).toEqual([edges[0]]);
    expect(p.trimmed).toBeGreaterThan(0);
  });
  it("what is open or being read is always drawn, even of a hidden kind", () => {
    const p = pickForMap(all, edges, { cap: 10, hidden: HIDDEN_AT_FIRST, keep: new Set(["metric:reach"]) });
    expect(p.nodes[0]!.id).toBe("metric:reach");
    expect(p.edges).toContainEqual(edges[1]);
  });
});

describe("Watch it grow", () => {
  it("replays in the order the team learned things; without a learned time, by its own date, then by importance", () => {
    const order = growOrder([
      node("a:late", "Task", 0.1, { learnedAt: 3000 }),
      node("a:undated", "Task", 0.9),
      node("a:early", "Task", 0.1, { learnedAt: 1000 }),
      node("a:dated", "Task", 0.5, { asOf: "1970-01-01T00:00:02Z" }),
      node("a:tie", "Task", 0.8, { learnedAt: 1000 }),
    ]);
    expect(order.map((n) => n.id)).toEqual(["a:tie", "a:early", "a:dated", "a:late", "a:undated"]);
  });
  it("starts slow, ends on everything, and takes few steps with reduced motion", () => {
    const f = growFrames(400);
    expect(f.at(-1)).toBe(400);
    expect(f[0]).toBeLessThan(5);
    for (let i = 1; i < f.length; i++) expect(f[i]!).toBeGreaterThan(f[i - 1]!);
    expect(growFrames(400, true).length).toBeLessThanOrEqual(6);
    expect(growFrames(0)).toEqual([]);
    expect(growFrames(1)).toEqual([1]);
  });
});

describe("size and labels", () => {
  it("sizes by importance on a square root, within the range", () => {
    expect(rankRadius(0, 2, 12)).toBe(2);
    expect(rankRadius(1, 2, 12)).toBe(12);
    expect(rankRadius(0.25, 2, 12)).toBe(7);
    expect(rankRadius(5, 2, 12)).toBe(12);
  });
  it("labels the top few at first", () => {
    const ns = [0.9, 0.5, 0.3, 0.2, 0.01].map((rank) => ({ rank }));
    expect(labelFloor(ns, 3)).toBe(0.3);
    expect(labelFloor(ns, 10)).toBe(0.05);
  });
});

describe("what the team is reading right now", () => {
  const look = (agent: string, ids: string[]): AgentEvent => ({
    type: "tool_result", agent: agent as never, id: `c-${agent}-${ids[0]}`, name: "search", summary: "",
    nodes: ids.map((id) => ({ id, label: "Channel", name: id })), edges: ids.length > 1 ? [{ from: ids[0]!, type: "USES", to: ids[1]! }] : [], sources: [],
  });
  it("each person's latest look-up, the most recent people first", () => {
    const r = readingNow([look("librarian", ["a:old"]), look("data-analyst", ["a:x", "a:y"]), look("librarian", ["a:new"])]);
    expect(r.who).toEqual(["librarian", "data-analyst"]);
    expect(r.ids).toEqual(["a:new", "a:x", "a:y"]);
    expect(r.edges).toEqual([{ from: "a:x", type: "USES", to: "a:y" }]);
  });
  it("nothing once the answer is in, and two runs read together", () => {
    const done = readingNow([look("librarian", ["a:x"]), { type: "final" } as AgentEvent]);
    expect(done.ids).toEqual([]);
    const both = mergeReading([readingNow([look("librarian", ["a:x"])]), readingNow([look("data-analyst", ["a:x", "a:z"])])]);
    expect(both.ids).toEqual(["a:x", "a:z"]);
    expect(both.who).toEqual(["librarian", "data-analyst"]);
  });
  it("says who is reading, in plain words", () => {
    expect(readingWords(["Memory Keeper"], 5)).toBe("Memory Keeper is reading 5 things");
    expect(readingWords(["Memory Keeper", "Data Detective", "The Chief"], 1)).toBe("Memory Keeper, Data Detective and The Chief are reading 1 thing");
    expect(readingWords([], 3)).toBe("");
    expect(namesWords(["Memory Keeper", "Data Detective"])).toBe("Memory Keeper and Data Detective");
  });
});

describe("the side panel", () => {
  it("keeps short facts and leaves bookkeeping out", () => {
    const props = {
      id: "channel:instagram", name: "Instagram", createdAt: 1792025937372, src: "document:x", embedKey: "2b3a", aliases: ["IG"], rank: 0.01,
      platform: "instagram", handle: "aamdani.ai", followers: 1840, verified: false, note: "x".repeat(200), owner: "person:founder",
    };
    expect(factsOf(props)).toEqual([["platform", "instagram"], ["handle", "aamdani.ai"], ["followers", 1840], ["verified", false]]);
    expect(factsOf(props, 2)).toHaveLength(2);
  });
  it("says what a thing is in one line", () => {
    expect(oneLine("The app database. Also auth and storage.")).toBe("The app database.");
    expect(oneLine(undefined)).toBeUndefined();
    const long = oneLine("word ".repeat(80));
    expect(long!.length).toBeLessThanOrEqual(150);
    expect(long!.endsWith("…")).toBe(true);
    expect(askAbout("Instagram")).toBe("What should I know about Instagram?");
  });
  it("draws what breaks as the real chain back to the thing that stopped", () => {
    const g = impactLinks({ id: "system:ig", name: "IG connector", type: "System" }, [
      { id: "system:pub", name: "Reel publisher", type: "System", hop: 1, path: [{ id: "system:pub", name: "Reel publisher", rel: "DEPENDS_ON", dir: "out" }] },
      { id: "task:launch", name: "Launch", type: "Task", hop: 2, path: [
        { id: "system:pub", name: "Reel publisher", rel: "DEPENDS_ON", dir: "out" },
        { id: "task:launch", name: "Launch", rel: "BLOCKS", dir: "in" },
      ] },
    ]);
    expect(g.ids).toEqual(["system:ig", "system:pub", "task:launch"]);
    expect(g.edges).toEqual([
      { from: "system:pub", type: "DEPENDS_ON", to: "system:ig" },
      { from: "system:pub", type: "BLOCKS", to: "task:launch" },
    ]);
    expect(g.nodes.find((n) => n.id === "task:launch")!.label).toBe("Task");
  });
});

describe("the words around the map", () => {
  it("the line above the map, with the real numbers", () => {
    expect(mapHeadline({ things: 3529, links: 10899, sources: 12 }).join(" · ")).toBe("3,529 things · 10,899 links · learned from 12 sources");
    expect(mapHeadline({ things: 1, links: 1, sources: 1 }).join(" · ")).toBe("1 thing · 1 link · learned from 1 source");
    expect(mapHeadline({ things: 9 })).toEqual(["9 things"]);
    expect(knowsLine(3529)).toBe("3,529 things your team knows");
  });
  it("what breaks, in one sentence", () => {
    expect(impactLine("Instagram", "impact", 3, 9)).toBe("If Instagram stops, 3 things stop straight away, 9 in all.");
    expect(impactLine("Instagram", "impact", 1, 1)).toBe("If Instagram stops, 1 thing stops straight away.");
    expect(impactLine("Payroll", "not_mapped", 0, 0)).toBe("Nothing is recorded as depending on Payroll yet.");
    expect(impactLine("Payroll", "nothing_depends", 0, 0)).toBe("Nothing depends on Payroll.");
  });
  it("no word the owner should not read", () => {
    const words = [
      ...mapHeadline({ things: 2, links: 3, sources: 4 }), knowsLine(5), readingWords(["Memory Keeper", "Data Detective"], 4), askAbout("Instagram"),
      impactLine("X", "impact", 2, 5), impactLine("X", "not_mapped", 0, 0), impactLine("X", "nothing_depends", 0, 0),
      ...kindTotals({ Product: 1, Audience: 1, Person: 1, Metric: 1, Decision: 1, Content: 1, Page: 1, Document: 1, System: 1 }).map((k) => k.name),
    ];
    for (const w of words) expect(ownerJargon(w), w).toEqual([]);
  });
});
