// Where an approved fix lands, per business. By default it is a task inside the app (and the card the owner already saw,
// on the web or in Discord): no outside system. GitHub is an opt-in a business makes for its own repo. A customer's fix
// must never open an issue in Allevia's own repo, however it got configured.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { executeApproval, type ExecutorDeps, type GhRunner } from "../../src/actions/executors.js";
import { ActionTargetError, getActionTarget, setActionTarget, validRepo } from "../../src/actions/target.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

const ALLEVIA_REPO = "Allevia-Org/allevia-tracker";   // the server's own repo (ALLEVIA_ACTION_REPO)
const CUSTOMER_REPO = "kestrel-dental/website-fixes";

let g: GraphHandle;
let cleanup: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ["ALLEVIA_ACTION_REPO", "ALLEVIA_ACTION_TENANTS"]) saved[k] = process.env[k];
  process.env.ALLEVIA_ACTION_REPO = ALLEVIA_REPO; // the server's own repo, as the env file would give it
  delete process.env.ALLEVIA_ACTION_TENANTS;
  ({ g, cleanup } = await seededGraph());
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await cleanup?.();
});

let n = 0;
async function card(payload: Record<string, unknown>): Promise<string> {
  const id = `approval:tgt-${++n}`;
  await upsertNode(g, { type: "Approval", id, name: `github_issue: ${String(payload.title)}`, props: { status: "approved", kind: "github_issue", payload: JSON.stringify(payload) } }, SEED_NOW);
  return id;
}
function spyGh(): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => { calls.push(args); return `https://github.com/${args[args.indexOf("--repo") + 1]}/issues/${calls.length}\n`; }) as GhRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}
const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ tenant: "test", config: { discord: {} }, ...over });
// back to "chose nothing" (the Business keeps no target property)
const clear = async (now: number) => { await upsertNode(g, { type: "Business", id: "business:aamdani", name: "Aamdani", props: { actionTarget: null, actionRepo: null, actionOperator: null } }, now); };
const payload = { title: "SEO: /services fails 'Has a meta description'", body: "- [ ] Add one\n\nPage: /services", targetId: "page:www.aamdani.ai/jobs" };
const count = async (cypher: string, p: Record<string, unknown> = {}) => (await g.roQuery<{ c: number }>(cypher, p))[0]?.c ?? 0;

describe("the default: tasks inside the app", () => {
  it("a business that chose nothing gets a task, and no outside system is touched (not even in a live run)", async () => {
    expect(await getActionTarget(g, "test")).toEqual({ kind: "app" });
    const gh = spyGh();
    for (const dryRun of [true, false]) {
      const p = { ...payload, title: `${payload.title} (${dryRun ? "dry" : "live"})` };
      const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, agent: "tech-lead", now: SEED_NOW }, deps({ gh, dryRun }));
      expect(a).toMatchObject({ kind: "github_issue", status: "done", affects: ["page:www.aamdani.ai/jobs"] });
      expect(a.result).toMatch(/^Added to your tasks: “SEO: \/services fails/);
      expect(a.result).toMatch(/Nothing was sent to GitHub or anywhere outside Allevia/);
      expect(a.url).toBeUndefined();
      expect(a.produced).toHaveLength(1);
      const [t] = await g.roQuery<{ kind: string; status: string; repo: string | null; ref: string | null; body: string; origin: string }>(
        "MATCH (t:Entity:Task {id:$id}) RETURN t.kind AS kind, t.status AS status, t.repo AS repo, t.ref AS ref, t.body AS body, t.origin AS origin", { id: a.produced[0] });
      expect(t).toMatchObject({ kind: "fix", status: "open", origin: "allevia", repo: null, ref: null });
      expect(t!.body).toContain("Add one");
    }
    expect(gh.calls).toEqual([]);
    expect(await count("MATCH (:Approval)-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(t:Task {kind:'fix'}) RETURN count(t) AS c")).toBe(2);
  });

  it("is exactly once: the same card again returns the same action and makes no second task", async () => {
    const p = { ...payload, title: "Once only" };
    const id = await card(p);
    const first = await executeApproval(g, { approvalId: id, kind: "github_issue", payload: p, now: SEED_NOW }, deps());
    const tasks = await count("MATCH (t:Task {kind:'fix'}) RETURN count(t) AS c");
    const again = await executeApproval(g, { approvalId: id, kind: "github_issue", payload: p, now: SEED_NOW }, deps());
    expect(again.id).toBe(first.id);
    expect(await count("MATCH (t:Task {kind:'fix'}) RETURN count(t) AS c")).toBe(tasks);
  });
});

describe("GitHub, when a business opts in", () => {
  it("opens the issue on the business's own repo and never on Allevia's", async () => {
    const t = await setActionTarget(g, { target: "github", repo: CUSTOMER_REPO }, { now: SEED_NOW, serverRepo: ALLEVIA_REPO });
    expect(t).toEqual({ kind: "github", repo: CUSTOMER_REPO });
    expect(await getActionTarget(g, "test")).toEqual({ kind: "github", repo: CUSTOMER_REPO });
    const gh = spyGh();
    const p = { ...payload, title: "Opted in" };
    const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, now: SEED_NOW }, deps({ gh }));
    expect(a).toMatchObject({ status: "done", url: `https://github.com/${CUSTOMER_REPO}/issues/1` });
    expect(gh.calls.map((c) => c[c.indexOf("--repo") + 1])).toEqual([CUSTOMER_REPO]);
    expect(JSON.stringify(gh.calls)).not.toContain(ALLEVIA_REPO);
  });

  it("is still a dry run unless actions are live", async () => {
    const gh = spyGh();
    const p = { ...payload, title: "Dry opted in" };
    const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, now: SEED_NOW }, deps({ gh, dryRun: true }));
    expect(a.status).toBe("dry_run");
    expect(a.result).toContain(`on ${CUSTOMER_REPO}`);
    expect(gh.calls).toEqual([]);
  });

  it("switching back to the app puts new fixes in tasks again", async () => {
    await setActionTarget(g, { target: "app" }, { now: SEED_NOW + 1000, serverRepo: ALLEVIA_REPO });
    expect(await getActionTarget(g, "test")).toEqual({ kind: "app" });
    const gh = spyGh();
    const p = { ...payload, title: "Back to the app" };
    const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, now: SEED_NOW }, deps({ gh }));
    expect(a.status).toBe("done");
    expect(a.url).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });
});

describe("the founder's own businesses, and a connector given to a call", () => {
  it("a founder's business that chose nothing keeps the founder's tracker, as before; one that chose the app gets tasks", async () => {
    await clear(SEED_NOW + 10_000);
    const gh = spyGh();
    const p = { ...payload, title: "Founder fix" };
    const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, now: SEED_NOW }, deps({ tenant: "aamdani", gh }));
    expect(a).toMatchObject({ status: "done", url: `https://github.com/${ALLEVIA_REPO}/issues/1` });
    await setActionTarget(g, { target: "app" }, { now: SEED_NOW + 11_000 });
    const gh2 = spyGh();
    const q = { ...payload, title: "Founder chose tasks" };
    const b = await executeApproval(g, { approvalId: await card(q), kind: "github_issue", payload: q, now: SEED_NOW }, deps({ tenant: "aamdani", gh: gh2 }));
    expect(b.result).toMatch(/^Added to your tasks/);
    expect(gh2.calls).toEqual([]);
  });

  it("a connector passed to the call is used as given for a business that chose nothing, but never Allevia's own repo for a customer", async () => {
    await clear(SEED_NOW + 12_000);
    const gh = spyGh();
    const p = { ...payload, title: "Own connector" };
    const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, now: SEED_NOW }, deps({ gh, config: { discord: {}, githubActionRepo: CUSTOMER_REPO } }));
    expect(a).toMatchObject({ status: "done", url: `https://github.com/${CUSTOMER_REPO}/issues/1` });
    const gh2 = spyGh();
    const q = { ...payload, title: "Allevia's repo as a connector" };
    const b = await executeApproval(g, { approvalId: await card(q), kind: "github_issue", payload: q, now: SEED_NOW }, deps({ gh: gh2, config: { discord: {}, githubActionRepo: ALLEVIA_REPO } }));
    expect(b.result).toMatch(/^Added to your tasks/);
    expect(gh2.calls).toEqual([]);
  });
});

describe("a customer can never reach Allevia's repo", () => {
  it("refuses to save it, in any spelling, and says why", async () => {
    for (const repo of [ALLEVIA_REPO, ALLEVIA_REPO.toUpperCase(), ` ${ALLEVIA_REPO}/`]) {
      await expect(setActionTarget(g, { target: "github", repo }, { now: SEED_NOW, serverRepo: ALLEVIA_REPO })).rejects.toThrow(ActionTargetError);
    }
    await expect(setActionTarget(g, { target: "github", repo: ALLEVIA_REPO }, { now: SEED_NOW, serverRepo: ALLEVIA_REPO })).rejects.toThrow(/Allevia's own/);
    expect(await getActionTarget(g, "test")).toEqual({ kind: "app" });
  });

  it("refuses anything that is not owner/name", async () => {
    for (const repo of ["", "kestrel", "a/b/c", "https://github.com/kestrel/site", "kes trel/site", "-bad/site", "kestrel/site; rm -rf", "../x"]) {
      expect(validRepo(repo), repo).toBe(false);
      await expect(setActionTarget(g, { target: "github", repo }, { now: SEED_NOW, serverRepo: ALLEVIA_REPO })).rejects.toThrow(/owner\/name/);
    }
    expect(validRepo("kestrel-dental/website-fixes")).toBe(true);
    expect(validRepo("Kestrel_Dental/site.v2")).toBe(false); // underscores are not allowed in owner names
  });

  it("even a graph that was written directly (no setActionTarget) lands in tasks, not in Allevia's repo", async () => {
    const [b] = await g.roQuery<{ id: string; name: string }>("MATCH (b:Entity:Business {id:'business:aamdani'}) RETURN b.id AS id, b.name AS name");
    await upsertNode(g, { type: "Business", id: b!.id, name: b!.name, props: { actionTarget: "github", actionRepo: ALLEVIA_REPO } }, SEED_NOW + 2000);
    expect(await getActionTarget(g, "test", { serverRepo: ALLEVIA_REPO })).toEqual({ kind: "app", reason: "That repo is Allevia's own, so the fix went to your tasks instead." });
    const gh = spyGh();
    const p = { ...payload, title: "Sneaky" };
    const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, now: SEED_NOW }, deps({ gh }));
    expect(a.status).toBe("done");
    expect(a.result).toMatch(/^Added to your tasks/);
    expect(gh.calls).toEqual([]);
  });

  it("only an operator can point a business at the repo Allevia runs on (its own tracker)", async () => {
    const t = await setActionTarget(g, { target: "github", repo: ALLEVIA_REPO }, { now: SEED_NOW + 3000, serverRepo: ALLEVIA_REPO, operator: true });
    expect(t).toEqual({ kind: "github", repo: ALLEVIA_REPO });
    const gh = spyGh();
    const p = { ...payload, title: "Allevia's own" };
    const a = await executeApproval(g, { approvalId: await card(p), kind: "github_issue", payload: p, now: SEED_NOW }, deps({ gh }));
    expect(a).toMatchObject({ status: "done", url: `https://github.com/${ALLEVIA_REPO}/issues/1` });
  });
});
