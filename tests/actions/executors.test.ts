import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { executeApproval, ISSUE_LABEL, type ExecutorDeps, type GhRunner, type HttpFn } from "../../src/actions/executors.js";
import type { Payload } from "../../src/actions/shared.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;
let dataDir: string;
const REPO = "Example-Org/example-repo";

beforeAll(async () => {
  ({ g, cleanup } = await seededGraph());
  dataDir = mkdtempSync(join(tmpdir(), "allevia-exec-"));
});
afterAll(async () => {
  await cleanup?.();
  rmSync(dataDir, { recursive: true, force: true });
});

let n = 0;
async function card(kind: string, payload: Record<string, unknown>): Promise<string> {
  const id = `approval:exec-${++n}`;
  await upsertNode(g, { type: "Approval", id, name: `${kind}: ${String(payload.title)}`, props: { status: "approved", kind, payload: JSON.stringify(payload) } }, SEED_NOW);
  return id;
}

function fakeGh(responses: Array<string | Error>): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => {
    calls.push(args);
    const r = responses.shift() ?? new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  }) as GhRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ tenant: "test", config: { githubActionRepo: REPO, dataDir, discord: {} }, ...over });
const count = async (q: string, p: Record<string, unknown> = {}) => (await g.roQuery<{ c: number }>(q, p))[0]?.c ?? 0;

describe("github_issue", () => {
  it("opens the issue with the label, records the Action, the Task it made and what it affects", async () => {
    const payload = { title: "SEO: fix meta description on /jobs", body: "- [ ] Add it", targetId: "page:www.aamdani.ai/jobs" };
    const id = await card("github_issue", payload);
    const gh = fakeGh([`https://github.com/${REPO}/issues/42\n`]);
    const a = await executeApproval(g, { approvalId: id, kind: "github_issue", payload, agent: "tech-lead", now: SEED_NOW }, deps({ gh }));
    expect(a).toMatchObject({ id: "action:exec-1", status: "done", url: `https://github.com/${REPO}/issues/42`, affects: ["page:www.aamdani.ai/jobs"] });
    expect(gh.calls).toHaveLength(1);
    const args = gh.calls[0]!;
    expect(args.slice(0, 4)).toEqual(["issue", "create", "--repo", REPO]);
    expect(args).toEqual(expect.arrayContaining(["--label", ISSUE_LABEL, "--title", payload.title]));
    expect(args[args.indexOf("--body") + 1]).toContain(`Proposed by Allevia (Arjun) and approved by the owner. Approval: ${id}.`);
    expect(await count(`MATCH (:Approval {id:$id})-[:RESULTED_IN]->(a:Action {id:'action:exec-1'})-[:RESULTED_IN]->(t:Task) WHERE t.ref = $url AND a.kind = 'github_issue' RETURN count(*) AS c`,
      { id, url: a.url })).toBe(1);
    // exactly once: a second call returns the same Action and never runs gh again
    expect((await executeApproval(g, { approvalId: id, kind: "github_issue", payload, now: SEED_NOW }, deps({ gh }))).id).toBe("action:exec-1");
    expect(gh.calls).toHaveLength(1);
  });

  it("creates the label when the repo lacks it, then retries", async () => {
    const payload = { title: "Fix sitemap", body: "x" };
    const id = await card("github_issue", payload);
    const gh = fakeGh([new Error("could not add label: 'allevia-action' not found"), "", `https://github.com/${REPO}/issues/43`]);
    const a = await executeApproval(g, { approvalId: id, kind: "github_issue", payload, now: SEED_NOW }, deps({ gh }));
    expect(a.status).toBe("done");
    expect(gh.calls.map((c) => c.slice(0, 2))).toEqual([["issue", "create"], ["label", "create"], ["issue", "create"]]);
  });

  it("records a failure, and refuses the real gh CLI inside tests", async () => {
    const payload = { title: "Will fail", body: "x" };
    const failed = await executeApproval(g, { approvalId: await card("github_issue", payload), kind: "github_issue", payload, now: SEED_NOW }, deps({ gh: fakeGh([new Error("HTTP 401")]) }));
    expect(failed).toMatchObject({ status: "failed", result: expect.stringContaining("HTTP 401") });
    const real = await executeApproval(g, { approvalId: await card("github_issue", payload), kind: "github_issue", payload, now: SEED_NOW }, deps());
    expect(real).toMatchObject({ status: "failed", result: expect.stringContaining("tests must inject gh") });
  });
});

describe("content_draft", () => {
  it("writes a draft Content PRODUCED by the agent and its markdown, and never publishes", async () => {
    const payload = { title: "Reel draft: salary reveal", body: "Hook: I asked 10 riders what they earn.", format: "reel", channelId: "channel:instagram", hookRuleId: "rule:hook-curiosity-gap" };
    const id = await card("content_draft", payload);
    const a = await executeApproval(g, { approvalId: id, kind: "content_draft", payload, agent: "content-strategist", now: SEED_NOW }, deps());
    expect(a).toMatchObject({ status: "done", affects: ["channel:instagram"] });
    expect(a.result).toMatch(/^Draft saved to drafts\/test\/exec-\d+\.md\. Not published\.$/);
    const contentId = a.produced[0]!;
    const [c] = await g.roQuery<{ status: string; format: string; path: string; published: number }>(
      `MATCH (:Agent {id:'agent:allevia-content-strategist'})-[:PRODUCED]->(c:Content {id:$id})
       OPTIONAL MATCH (c)-[p:PUBLISHED_ON]->() RETURN c.status AS status, c.format AS format, c.draftPath AS path, count(p) AS published`, { id: contentId });
    expect(c).toMatchObject({ status: "draft", format: "reel", published: 0 });
    expect(readFileSync(join(dataDir, c!.path), "utf8")).toContain("Hook: I asked 10 riders what they earn.");
    expect(await count("MATCH (:Content {id:$id})-[:USES_RULE]->(:Rule {id:'rule:hook-curiosity-gap'}) RETURN count(*) AS c", { id: contentId })).toBe(1);
  });

  it("applies an active learned rule to a card written without it (USES_RULE, appliedCount)", async () => {
    await upsertNode(g, { type: "Rule", id: "rule:learned-say-reel-not-video", name: 'Say "reel", not "video".',
      props: { kind: "learned", text: 'Say "reel", not "video".', op: "replace", find: "video", replace: "reel", status: "active", confidence: 0.6, appliedCount: 0 } }, SEED_NOW);
    const payload = { title: "Video idea", body: "A short video on interview tips.", format: "reel" };
    const id = await card("content_draft", payload);
    const a = await executeApproval(g, { approvalId: id, kind: "content_draft", payload, agent: "content-strategist", now: SEED_NOW }, deps());
    expect(a.rulesApplied).toContain("rule:learned-say-reel-not-video");
    const [c] = await g.roQuery<{ title: string; caption: string; n: number }>(
      "MATCH (c:Content {id:$id})-[:USES_RULE]->(r:Rule {id:'rule:learned-say-reel-not-video'}) RETURN c.title AS title, c.caption AS caption, r.appliedCount AS n", { id: a.produced[0] });
    expect(c).toEqual({ title: "Reel idea", caption: "A short reel on interview tips.", n: 1 });
  });

  it("re-applies deterministic rules to what an injected drafter writes", async () => {
    const payload = { title: "Office tour", body: "Brief: show the office.", format: "reel" };
    const a = await executeApproval(g, { approvalId: await card("content_draft", payload), kind: "content_draft", payload, agent: "content-strategist", now: SEED_NOW },
      deps({ drafter: async (d) => `${d.body}\n\nA video tour of the office.` }));
    const [c] = await g.roQuery<{ caption: string }>("MATCH (c:Content {id:$id}) RETURN c.caption AS caption", { id: a.produced[0] });
    expect(c!.caption).toBe("Brief: show the office.\n\nA reel tour of the office.");
  });

  // Content trial 2026-10-15: a card with no text was approved into an empty draft file.
  it("fails closed on a card with no text: no empty draft file, no Content, and the Action says why", async () => {
    const payload = { title: "Reel plan 16-22 Oct", items: ["Fri: Applied, then silence?"], script: "Not yet written" } as unknown as Payload;
    const id = await card("content_draft", payload);
    const a = await executeApproval(g, { approvalId: id, kind: "content_draft", payload, agent: "content-strategist", now: SEED_NOW }, deps());
    expect(a.status).toBe("failed");
    expect(a.result).toMatch(/no text/i);
    expect(a.produced).toEqual([]);
  });
});

describe("pause_ad (simulated)", () => {
  it("pauses a simulated campaign: status paused with a Version of 'active', result says simulated", async () => {
    const payload = { title: "Pause Employers", body: "CPA 2×", campaignId: "campaign:meta-employers" };
    const a = await executeApproval(g, { approvalId: await card("pause_ad", payload), kind: "pause_ad", payload, now: SEED_NOW }, deps());
    expect(a).toMatchObject({ status: "done", simulated: true, affects: ["campaign:meta-employers"], produced: ["campaign:meta-employers"] });
    expect(a.result).toMatch(/^Simulated: "Employers: hire in 24h" paused/);
    const [c] = await g.roQuery<{ status: string; old: string }>(
      "MATCH (c:Campaign {id:'campaign:meta-employers'})-[:HAD_VERSION]->(v:Version) RETURN c.status AS status, v.props AS old");
    expect(c!.status).toBe("paused");
    expect(JSON.parse(c!.old).status).toBe("active");
  });

  it("never touches a real campaign", async () => {
    await upsertNode(g, { type: "Campaign", id: "campaign:real-one", name: "Real campaign", props: { status: "active" } }, SEED_NOW);
    const payload = { title: "Pause real", body: "x", campaignId: "campaign:real-one" };
    const a = await executeApproval(g, { approvalId: await card("pause_ad", payload), kind: "pause_ad", payload, now: SEED_NOW }, deps());
    expect(a.status).toBe("skipped");
    expect(await count("MATCH (c:Campaign {id:'campaign:real-one'}) WHERE c.status = 'active' RETURN count(c) AS c")).toBe(1);
  });
});

describe("discord_post", () => {
  it("is skipped without a token", async () => {
    const payload = { title: "Stale items", body: "- a" };
    const a = await executeApproval(g, { approvalId: await card("discord_post", payload), kind: "discord_post", payload, now: SEED_NOW }, deps());
    expect(a).toMatchObject({ status: "skipped", result: expect.stringContaining("no Discord bot token") });
  });

  it("posts through the injected HTTP call with the bot token", async () => {
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    const http: HttpFn = async (url, init) => {
      calls.push({ url, auth: init.headers.authorization!, body: init.body });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "999" }) };
    };
    const payload = { title: "Morning brief", body: "All quiet." };
    const a = await executeApproval(g, { approvalId: await card("discord_post", payload), kind: "discord_post", payload, now: SEED_NOW },
      deps({ http, config: { dataDir, githubActionRepo: REPO, discord: { token: "test-token", channelId: "123", guildId: "456" } } }));
    expect(a).toMatchObject({ status: "done", url: "https://discord.com/channels/456/123/999" });
    expect(calls).toEqual([{ url: "https://discord.com/api/v10/channels/123/messages", auth: "Bot test-token", body: JSON.stringify({ content: "**Morning brief**\nAll quiet." }) }]);
  });
});
