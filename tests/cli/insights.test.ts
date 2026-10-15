import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { commands, readEdit } from "../../src/cli/insights.js";
import { insightApprovalId } from "../../src/insights/recommend.js";
import { seedInsights } from "../fixtures/insights-graph.js";
import { testGraph } from "../helpers/graph.js";
import { whenFree } from "../helpers/tools.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;
let tenant: string;
let dir: string;

beforeAll(async () => {
  ({ g, cleanup } = await whenFree(async () => {
    const t = await testGraph();
    try {
      await seedInsights(t.g);
    } catch (e) {
      await t.cleanup().catch(() => undefined);
      throw e;
    }
    return t;
  }));
  tenant = g.name.replace(/^allevia_/, "");
  dir = mkdtempSync(join(tmpdir(), "allevia-cli-"));
  process.env.ALLEVIA_DATA_DIR = dir; // drafts land in the temp dir, not the repo's data/
});
afterAll(async () => {
  await cleanup?.();
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ALLEVIA_DATA_DIR;
});

async function cli(name: string, args: string[]): Promise<{ code: number | void; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  try {
    const code = await commands.find((c) => c.name === name)!.run(args);
    return { code, out: lines.join("\n") };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("insights, brief and approvals from the terminal", () => {
  it("insights lists findings by area with their cards", async () => {
    const r = await cli("insights", [tenant]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Insights for test_[0-9a-f]+: 16 findings \(16 new\), 12 with a card, 0 resolved/);
    expect(r.out).toContain("ADS (simulated)");
    expect(r.out).toContain(`Rohan  Pause "Employers: hire in 24h" (simulated): CPA ₹300 vs ₹150 median\n         card: ${insightApprovalId("ads.high_cpa:campaign:meta-employers")} (pause_ad)`);
  });

  it("approvals lists what waits, and approve runs the (simulated) executor", async () => {
    const list = await cli("approvals", [tenant]);
    expect(list.out).toContain(insightApprovalId("ads.high_cpa:campaign:meta-employers"));
    const id = insightApprovalId("ads.high_cpa:campaign:meta-employers");
    const r = await cli("approvals", [tenant, "approve", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${id}: executed (first pass)`);
    expect(r.out).toMatch(/Action action:insight-[\w-]+: done\. Simulated: "Employers: hire in 24h" paused/);
    expect(r.out).toContain("First-pass rate (30 days): 100% (1/1)");
    expect((await cli("approvals", [tenant, "approve", id])).out).toContain("Already decided: executed. Nothing done.");
  });

  it("an edit from a file teaches a rule", async () => {
    const id = insightApprovalId("content.posting_gap:channel:instagram");
    const file = join(dir, "edit.json");
    writeFileSync(file, JSON.stringify({ body: "Instagram has been quiet since 26 Sep (19 days). Draft one carousel this week in the format that has worked best here." }));
    const r = await cli("approvals", [tenant, "approve", id, "--edit", file]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Learned: Say "carousel", not "reel". (rule:learned-say-carousel-not-reel)');
    expect(r.out).toContain(`${id}: executed\n`);
    expect(r.out).toContain("First-pass rate (30 days): 50% (1/2)");
  });

  it("brief prints today's brief and where it was saved", async () => {
    const r = await cli("brief", [tenant]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Morning brief, Aamdani, /);
    expect(r.out).toMatch(/\(saved as document:brief-test-[0-9a-f]+-\d{4}-\d{2}-\d{2}\)$/);
  });

  it("refuses a tenant with no graph, and bad usage", async () => {
    expect((await cli("insights", ["no_such_tenant"])).code).toBe(2);
    expect((await cli("approvals", [tenant, "maybe", "x"])).code).toBe(2);
  });

  it("reads an edit file as JSON or as the new body", () => {
    const j = join(dir, "a.json"), t = join(dir, "b.md");
    writeFileSync(j, '{"title":"New title"}');
    writeFileSync(t, "Just the body.\n");
    expect(readEdit(j)).toEqual({ title: "New title" });
    expect(readEdit(t)).toBe("Just the body.");
  });
});
