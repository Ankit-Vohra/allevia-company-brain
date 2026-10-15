// The eval runner in --fake mode: the scripted FakeRuntime and fake tools through the real ask() (sessions, checks, Turn
// persistence) on a throwaway graph, scored and written as the markdown report. No model is called.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, listGraphs, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { fakeAskDeps, parseEvalArgs, rescore, runEval, type FakeAnswer } from "../../evals/runner.js";
import { parseSet, type EvalItem } from "../../evals/set.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

const set = parseSet(`
tenant: test
items:
  - id: why-stories
    question: Why did we pause daily stories?
    tags: [why]
    expect:
      mustCite: ["decision:*paus*"]
      mustMatch: ["poor|effort"]
      mustUseTools: [search]
  - id: ads-cpa
    question: Which campaign has the worst cost per signup?
    tags: [ads]
    expect:
      mustMatch: [youtube]
      simulated: true
  - id: trap
    question: What is our NPS?
    tags: [trap]
    expect:
      mustMatch: ["not recorded"]
`);

const answers: Record<string, FakeAnswer> = {
  "why-stories": {
    text: "We paused daily stories because the output stayed poor after much effort [[decision:pause-daily-stories]].",
    nodes: [{ id: "decision:pause-daily-stories", label: "Decision", name: "Pause daily stories" }],
  },
  "ads-cpa": {
    text: "Employers lead form costs ₹118 per signup [[campaign:employers]].",
    nodes: [{ id: "campaign:employers", label: "Campaign", name: "Employers", simulated: true }],
    data: { cpa: 118.07 },
  },
};

describe("eval runner (fake mode)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let clock = NOW;
  const items = (ids: string[]): EvalItem[] => ids.map((id) => set.items.find((i) => i.id === id)!);
  const opts = (ids: string[]) => ({
    tenant: "test", set, setPath: "evals/test.yaml", items: items(ids), mode: "fake" as const,
    depsFor: (it: EvalItem) => fakeAskDeps(g, answers[it.id] ?? { text: `No record of that [[fake:eval-node]].` }, { now: () => (clock += 60_000) }),
    reportDir: join(dir, "docs"), resultsDir: join(dir, "data"), date: "2026-10-15", log: () => {},
  });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    dir = mkdtempSync(join(tmpdir(), "allevia-evals-"));
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await cleanup();
    await closeAll();
  });

  it("runs each question through ask(), scores it, and writes the report and the results", async () => {
    const r = await runEval(opts(["why-stories", "ads-cpa", "trap"]));
    expect(r.scores.map((s) => [s.id, s.pass])).toEqual([["why-stories", true], ["ads-cpa", false], ["trap", false]]);
    const ads = r.scores[1]!;
    expect(ads.checks.simulatedDisclosed).toBe(false); // touched a simulated campaign and never said so
    expect(ads.expectations.map((e) => [e.kind, e.ok])).toEqual([["match", false], ["simulated", false]]);
    expect(r.scores[0]!.tools).toEqual(["search", "show_path"]); // the orchestrator draws the path from the citations
    expect(r.scores[0]!.turnId).toMatch(/^turn:/);
    expect(r.summary).toMatchObject({ n: 3, turnsOk: 3, passed: 1, hits: 3, total: 6 });

    // the turns were saved like any other
    const saved = await g.roQuery<{ c: number }>("MATCH (t:Turn) WHERE t.id IN $ids RETURN count(t) AS c", { ids: r.scores.map((s) => s.turnId) });
    expect(saved[0]!.c).toBe(3);

    expect(r.reportPath).toBe(join(dir, "docs", "2026-10-15-test-fake.md"));
    const md = readFileSync(r.reportPath, "utf8");
    expect(md).toContain("# Eval: test, 2026-10-15");
    expect(md).toContain("FAKE run");
    expect(md).toMatch(/\| Passed \(every check and expectation\) \| 1 of 3 \(33%\) \|/);
    expect(md).toMatch(/\| Expectations hit \| 3 of 6 \(50%\) \|/);
    expect(md).toMatch(/\| simulated disclosed \| 67% \|/);
    expect(md).toMatch(/\| 1 \| why-stories \| why \| PASS \| ok \| 3\/3 \|/);
    expect(md).toMatch(/\| 2 \| ads-cpa \| ads \| FAIL \| simulated \| 0\/2 \|/);
    expect(md).toContain("> We paused daily stories because the output stayed poor after much effort.");
    expect(md).toContain("- Missed match `youtube`");
    expect(md).toContain("- Missed simulated: says the data is simulated");
    expect(md).toContain("- Check failed: simulated");
    expect(md).not.toContain("[[decision:pause-daily-stories]]");

    const results = JSON.parse(readFileSync(r.resultsPath, "utf8")) as { items: Record<string, unknown[]> };
    expect(Object.keys(results.items)).toEqual(["why-stories", "ads-cpa", "trap"]);
  });

  it("a re-run of one question adds an attempt; the report keeps the first run, shows the latest, and keeps hand-written notes", async () => {
    const path = join(dir, "docs", "2026-10-15-test-fake.md");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before.replace("<!-- notes -->\n", "<!-- notes -->\nFixed: the ads desk now says simulated.\n"));

    answers["ads-cpa"] = { ...answers["ads-cpa"]!, text: "YouTube Shorts costs the most, simulated data: ₹118 per signup [[campaign:employers]]." };
    const r = await runEval(opts(["ads-cpa"]));
    expect(r.scores.map((s) => [s.id, s.pass])).toEqual([["ads-cpa", true]]);

    const md = readFileSync(path, "utf8");
    expect(md).toContain("Fixed: the ads desk now says simulated.");
    expect(md).toMatch(/\| Passed \(every check and expectation\) \| 1 of 3 \(33%\) \| 2 of 3 \(67%\) \|/);
    expect(md).toMatch(/\| 2 \| ads-cpa \| ads \| PASS \(re-run\) \| ok \| 2\/2 \|/);
    expect(md).toContain("Attempt 1: FAIL");
    // the other questions are still in the report
    expect(md).toContain("| 1 | why-stories |");
    expect(md).toContain("| 3 | trap |");
  });

  it("rescore applies the current expectations to the stored turns of every attempt, without calling a model", async () => {
    const edited = parseSet(`
tenant: test
items:
  - id: why-stories
    question: Why did we pause daily stories?
    tags: [why]
    expect:
      mustMatch: ["reels"]
  - id: ads-cpa
    question: Which campaign has the worst cost per signup?
    tags: [ads]
    expect:
      mustMatch: [youtube]
      simulated: true
  - id: trap
    question: What is our NPS?
    tags: [trap]
    expect:
      mustMatch: ["no record"]
`);
    const r = await rescore({ tenant: "test", set: edited, graph: g, mode: "fake", reportDir: join(dir, "docs"), resultsDir: join(dir, "data"), date: "2026-10-15" });
    expect(r.changed).toEqual([
      { id: "why-stories", attempt: 1, was: true, now: false },
      { id: "trap", attempt: 1, was: false, now: true },
    ]);
    const md = readFileSync(r.reportPath, "utf8");
    expect(md).toMatch(/\| 1 \| why-stories \| why \| FAIL \| ok \| 0\/1 \|/);
    expect(md).toMatch(/\| 3 \| trap \| trap \| PASS \| ok \| 1\/1 \|/);
    expect(md).toContain("Fixed: the ads desk now says simulated."); // notes survive
    expect(md).toContain("Attempt 1: FAIL"); // ads-cpa keeps both attempts, each re-scored
  });

  it("without injected deps, fake mode runs on its own throwaway graph and drops it afterwards", async () => {
    const r = await runEval({ ...opts(["trap"]), depsFor: undefined, reportDir: join(dir, "docs2"), resultsDir: join(dir, "data2") });
    expect(r.scores[0]!.ok).toBe(true);
    expect(r.scores[0]!.excerpt).toMatch(/^Fake answer \(no model was called\)/);
    expect(r.scratchGraph).toMatch(/^allevia_test_eval_/);
    expect(await listGraphs()).not.toContain(r.scratchGraph);
    expect(existsSync(join(dir, "docs2", "2026-10-15-test-fake.md"))).toBe(true);
  });
});

describe("eval CLI arguments", () => {
  it("parses tenant, filters, mode and model", () => {
    expect(parseEvalArgs(["aamdani", "--limit", "3", "--tags", "why,ads", "--only", "a,b", "--fake", "--model", "haiku"])).toEqual({
      tenant: "aamdani", limit: 3, tags: ["why", "ads"], only: ["a", "b"], fake: true, model: "haiku", verbose: false,
    });
    expect(parseEvalArgs(["avs"])).toEqual({ tenant: "avs", fake: false, verbose: false });
    expect(parseEvalArgs(["avs", "--rescore"])).toEqual({ tenant: "avs", fake: false, verbose: false, rescore: true });
    expect(() => parseEvalArgs([])).toThrow(/Usage/);
    expect(() => parseEvalArgs(["aamdani", "--limit", "x"])).toThrow(/--limit/);
  });
});
