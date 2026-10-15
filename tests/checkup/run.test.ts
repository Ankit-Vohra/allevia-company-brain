// The check-up end to end on the synthetic fixture site (real crawl, real browser for the conversion reading, a fake
// Lighthouse that returns a recorded result), stored in a throwaway graph twice: the second run reports progress and
// closes the fix that went away.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { blockedAiCrawlers, lighthousePages, runCheckup, saveCheckup, storedCheckups, type CheckupResult } from "../../src/checkup/run.js";
import { checkupRuleId } from "../../src/checkup/store.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";
import { testGraph } from "../helpers/graph.js";

const lhr = (name: string, perf: number) => {
  const j = JSON.parse(readFileSync(new URL(`../fixtures/checkup/${name}`, import.meta.url), "utf8")) as { categories: Record<string, { score: number }> };
  j.categories.performance!.score = perf / 100;
  return j;
};

describe("runCheckup and saveCheckup", () => {
  let site: SiteServer;
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let first: CheckupResult;
  let lhCalls: string[] = [];
  const run = (perf: number, robots: string | null) => runCheckup(`${site.origin}/`, { businessName: "Kestrel & Oak Studio", maxPages: 8 }, {
    crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 2 },
    lighthouse: async (url, s) => { lhCalls.push(`${s} ${url}`); return lhr(s === "mobile" ? "lhr-mobile-poor.json" : "lhr-desktop-poor.json", s === "mobile" ? perf : 95); },
    robotsText: async () => robots,
    now: () => Date.parse(perf < 60 ? "2026-10-01T10:00:00Z" : "2026-10-15T10:00:00Z"),
  });

  beforeAll(async () => {
    site = await startSite();
    ({ g, cleanup } = await testGraph());
    first = await run(41, "User-agent: OAI-SearchBot\nDisallow: /\n");
  }, 180_000);
  afterAll(async () => {
    await site.close();
    await cleanup();
  });

  it("reads the site, runs the speed test on the home and key pages at both sizes, and ranks five fixes", () => {
    expect(first.pagesChecked.length).toBeGreaterThan(2);
    expect(first.conversionPages[0]).toBe(`${site.origin}/`);
    expect(lhCalls.filter((c) => c.startsWith("mobile")).length).toBe(lhCalls.filter((c) => c.startsWith("desktop")).length);
    expect(lhCalls[0]).toBe(`mobile ${site.origin}/`);
    expect(first.verdict.top).toHaveLength(5);
    expect(first.verdict.all.map((f) => f.key)).toEqual(expect.arrayContaining(["mobile-speed", "ai-crawlers", "titles"]));
    for (const f of first.verdict.top) {
      expect(f.what.length).toBeGreaterThan(10);
      expect(f.effort).toMatch(/minutes|hour|day/);
    }
  });

  it("stores the fixes and numbers with the report as their source, then shows progress on the next run", async () => {
    const s1 = await saveCheckup(g, first, Date.parse("2026-10-01T10:00:00Z"));
    expect(s1.progress.lines).toEqual([]);
    const [rule] = await g.roQuery<{ n: number }>(
      "MATCH (x:Entity)-[e:FAILS]->(r:Entity {id:$r}) WHERE e.until IS NULL AND e.src = $doc RETURN count(e) AS n", { r: checkupRuleId("ai-crawlers"), doc: s1.docId });
    expect(rule!.n).toBe(1);
    const [obs] = await g.roQuery<{ v: number; src: string }>(
      "MATCH (o:Observation)-[m:MEASURES]->(c:Channel) WHERE o.metric = 'checkup_mobile_speed' AND m.until IS NULL RETURN o.value AS v, o.src AS src LIMIT 1");
    expect(obs).toEqual({ v: 41, src: s1.docId });

    lhCalls = [];
    const second = await run(78, null); // faster now, and robots.txt no longer blocks the AI crawlers
    const s2 = await saveCheckup(g, second, Date.parse("2026-10-15T10:00:00Z"));
    expect(s2.progress.lines).toContain("Your mobile speed went from 41 to 78.");
    expect(s2.progress.fixed).toContain("Let AI assistants read your site");
    expect(s2.closed).toBeGreaterThanOrEqual(1);
    const [open] = await g.roQuery<{ n: number }>(
      "MATCH (x:Entity)-[e:FAILS]->(r:Entity {id:$r}) WHERE e.until IS NULL RETURN count(e) AS n", { r: checkupRuleId("ai-crawlers") });
    expect(open!.n).toBe(0);
    const stored = await storedCheckups(g, 2);
    expect(stored.map((s) => s.docId)).toEqual([s2.docId, s1.docId]);
    expect(stored[0]!.top).toHaveLength(5);
  }, 180_000);
});

describe("helpers", () => {
  it("reads which AI search crawlers robots.txt blocks", () => {
    expect(blockedAiCrawlers("User-agent: *\nDisallow: /private\n")).toEqual([]);
    expect(blockedAiCrawlers("User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n")).toEqual(["PerplexityBot"]);
    expect(blockedAiCrawlers(null)).toEqual([]);
  });
  it("picks the home page and one key page per section for the speed test", () => {
    const p = (path: string) => ({ finalUrl: `https://x.example${path}`, status: 200 }) as Parameters<typeof lighthousePages>[0][number];
    const out = lighthousePages([p("/"), p("/projects/a"), p("/projects/b"), p("/contact"), p("/blog/x")], 4);
    expect(out[0]).toBe("https://x.example/");
    expect(out).toContain("https://x.example/contact");
    expect(out.filter((u) => u.includes("/projects/")).length).toBeLessThanOrEqual(1);
  });
});
