// Graph audit G11c: a post is a fact in the business's graph from the moment it is scheduled. It ADVANCES the goals of the card behind
// it, every change of its status leaves a Version (the claim that takes a post to publishing is one atomic statement that writes its
// own Version), it is PUBLISHED_ON its channel with a state from the start, the account it goes from is a Channel of its own (PART_OF
// the platform's), and a dry run keeps a planned post. Each write is read back with Cypher; the platforms are fakes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApproval, type ExecutorDeps } from "../../src/actions/executors.js";
import type { Payload } from "../../src/actions/shared.js";
import { closeAll } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { cancelScheduled, retryPost } from "../../src/publish/executor.js";
import { accountChannelId, claim, contentIdFor, readPost } from "../../src/publish/record.js";
import { runDue } from "../../src/publish/scheduler.js";
import { ACCOUNTS, addAsset, addCard, NOW, publishHarness, scriptFacebook, scriptInstagram, TENANT, type PublishHarness } from "./harness.js";

let h: PublishHarness;
let n = 0;
const nextId = () => `approval:g11-${++n}`;
const DAY = new Date(NOW).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime(), ...over });
const env = () => ({ tenant: TENANT, connections: h.svc.port(TENANT), dryRun: false, publish: h.runtime() });
const run = (id: string, payload: Record<string, unknown>, over: Partial<ExecutorDeps> = {}, now = NOW) =>
  executeApproval(h.g, { approvalId: id, kind: "publish_post", payload: payload as Payload, agent: "content-strategist", now }, deps(over));
const rows = <T>(q: string, p: Record<string, unknown> = {}) => h.g.roQuery<T>(q, p);
const count = async (q: string, p: Record<string, unknown> = {}) => (await rows<{ c: number }>(q, p))[0]?.c ?? 0;
const statusVersions = async (id: string): Promise<string[]> => (await rows<{ props: string }>(
  "MATCH (:Content {id:$id})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props, v.since AS since, v.id AS vid ORDER BY since, vid", { id })).map((v) => (JSON.parse(v.props) as { status: string }).status);

// A card as the product makes it: a Recommendation that advances a goal PROPOSES the Approval.
async function recommend(approval: string, goal = "goal:g11-enquiries"): Promise<void> {
  const rec = `recommendation:${approval.replace(/^approval:/, "")}`;
  await upsertNode(h.g, { type: "Recommendation", id: rec, name: "Post the Diwali sale", props: { status: "proposed" } }, NOW);
  await upsertEdge(h.g, { from: rec, type: "PROPOSES", to: approval }, NOW);
  await upsertEdge(h.g, { from: rec, type: "ADVANCES", to: goal }, NOW);
}

beforeAll(async () => {
  h = await publishHarness();
  await h.connect("instagram");
  await h.connect("facebook");
  await addAsset(h.g, "asset:poster-a");
  await upsertNode(h.g, { type: "Goal", id: "goal:g11-enquiries", name: "More enquiries", props: { status: "active" } }, NOW);
}, 90_000);
afterAll(async () => { await h.cleanup(); await closeAll(); });

describe("the post advances what the card advanced", () => {
  it("Content -ADVANCES-> Goal, through Approval <-PROPOSES- Recommendation -ADVANCES-> Goal, from the moment it is scheduled", async () => {
    scriptInstagram(h);
    const id = nextId();
    const at = NOW + 2 * DAY_MS;
    const payload = await addCard(h.g, { id, at });
    await recommend(id);
    const a = await run(id, payload);
    expect(a.status).toBe("done"); // scheduled
    const post = contentIdFor(id);
    expect(await rows(
      "MATCH (:Recommendation)-[:PROPOSES]->(:Approval {id:$a}) MATCH (c:Content {id:$c})-[e:ADVANCES]->(g:Goal) RETURN g.id AS goal, e.src AS src, e.asOf AS asOf", { a: id, c: post }))
      .toEqual([{ goal: "goal:g11-enquiries", src: id, asOf: DAY }]);
    // it still advances it once the post has gone out, and the edge is not doubled
    await runDue(TENANT, h.g, env(), at + 60_000);
    expect(await readPost(h.g, post)).toMatchObject({ status: "published" });
    expect(await count("MATCH (:Content {id:$c})-[e:ADVANCES]->(:Goal {id:'goal:g11-enquiries'}) WHERE e.until IS NULL RETURN count(e) AS c", { c: post })).toBe(1);
  });

  it("a card with no recommendation advances nothing, and posts all the same", async () => {
    scriptInstagram(h);
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }));
    expect(a.status).toBe("done");
    expect(await count("MATCH (:Content {id:$c})-[e:ADVANCES]->() RETURN count(e) AS c", { c: contentIdFor(id) })).toBe(0);
  });
});

describe("every change of status leaves a Version", () => {
  it("scheduled, then publishing (the claim), then published: the states it left are kept, oldest first", async () => {
    scriptInstagram(h);
    const id = nextId();
    const at = NOW + DAY_MS;
    await run(id, await addCard(h.g, { id, at }));
    const post = contentIdFor(id);
    expect(await statusVersions(post)).toEqual([]);                 // created as scheduled: nothing before it
    await runDue(TENANT, h.g, env(), at + 60_000);
    expect((await readPost(h.g, post))?.status).toBe("published");
    expect(await statusVersions(post)).toEqual(["scheduled", "publishing"]);
    // the Version the claim wrote says when that state began and ended
    const [v] = await rows<{ since: number; until: number }>(
      "MATCH (:Content {id:$id})-[:HAD_VERSION]->(v:Version) WHERE v.props CONTAINS '\"status\":\"scheduled\"' RETURN v.since AS since, v.until AS until", { id: post });
    expect(v!.until).toBe(at + 60_000);
    expect(v!.since).toBeLessThanOrEqual(v!.until);
  });

  it("cancel is a Version too, and the claim cannot be taken twice: one of two racing claims wins and writes one Version", async () => {
    scriptInstagram(h);
    const id = nextId();
    await run(id, await addCard(h.g, { id, at: NOW + 3 * DAY_MS }));
    const post = contentIdFor(id);
    const [one, two] = await Promise.all([claim(h.g, post, ["scheduled"], NOW + 1), claim(h.g, post, ["scheduled"], NOW + 1)]);
    expect([one, two].filter((t) => t !== null)).toHaveLength(1);
    expect(await statusVersions(post)).toEqual(["scheduled"]);
    expect((await readPost(h.g, post))).toMatchObject({ status: "publishing", attempts: 1 });
    // a post that is being posted cannot be cancelled; one that is waiting can, and that is kept as a Version
    expect((await cancelScheduled(h.g, post, { now: NOW + 2 })).ok).toBe(false);
    const waiting = nextId();
    await run(waiting, await addCard(h.g, { id: waiting, at: NOW + 3 * DAY_MS }));
    const cancelled = await cancelScheduled(h.g, contentIdFor(waiting), { now: NOW + 5 });
    expect(cancelled.ok).toBe(true);
    expect(await statusVersions(contentIdFor(waiting))).toEqual(["scheduled"]);
    expect(await rows("MATCH (c:Content {id:$id}) RETURN c.status AS status, c.cancelledAt AS at", { id: contentIdFor(waiting) })).toEqual([{ status: "cancelled", at: NOW + 5 }]);
    // a write after the claim still sees the claim's changes (rev moved): the post's own flow carries on
    expect(await count("MATCH (c:Content {id:$id}) WHERE c.rev >= 2 RETURN count(c) AS c", { id: post })).toBe(1);
  });

  it("failed, tried again, published: scheduled, publishing, failed, publishing are each a Version; the card's Action and Approval follow with their source", async () => {
    scriptInstagram(h);
    h.composio.handlers.set("INSTAGRAM_CREATE_MEDIA_CONTAINER", (_a, k) => (k === 1 ? { fail: "(#9004) The media could not be fetched from this URI" } : { id: "C2" }));
    const id = nextId();
    const a = await run(id, await addCard(h.g, { id }));
    expect(a.status).toBe("failed");
    const post = contentIdFor(id);
    expect((await statusVersions(post)).sort()).toEqual(["publishing", "scheduled"]); // one instant: the order inside it is not meaningful
    const r = await retryPost(h.g, post, deps(), { now: NOW + 60_000 });
    expect(r.ok).toBe(true);
    expect((await statusVersions(post)).sort()).toEqual(["failed", "publishing", "publishing", "scheduled"]);
    // the Action says which approval it came from, and the Approval's states are Versions made by the Action
    expect(await rows("MATCH (:Approval {id:$a})-[:RESULTED_IN]->(x:Action) RETURN x.status AS status, x.src AS src, x.asOf AS asOf", { a: id })).toEqual([{ status: "done", src: id, asOf: DAY }]);
    expect(await rows("MATCH (a:Approval {id:$a}) RETURN a.status AS status, a.src AS src, a.asOf AS asOf", { a: id })).toEqual([{ status: "executed", src: `action:${id.replace(/^approval:/, "")}`, asOf: DAY }]);
    const seen = (await rows<{ props: string }>("MATCH (:Approval {id:$a})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props, v.since AS since, v.id AS vid ORDER BY since, vid", { a: id })).map((v) => (JSON.parse(v.props) as { status: string }).status);
    expect(seen).toEqual(["approved"]); // the card was approved, then executed by the retry
    h.composio.handlers.delete("INSTAGRAM_CREATE_MEDIA_CONTAINER");
    scriptInstagram(h);
  });
});

describe("PUBLISHED_ON from the start, and the account as a node", () => {
  it("scheduled is already on its channel (state scheduled); published moves the state; both the platform's channel and the account's channel carry it", async () => {
    scriptInstagram(h);
    const id = nextId();
    const at = NOW + 2 * DAY_MS;
    await run(id, await addCard(h.g, { id, at }));
    const post = contentIdFor(id);
    const on = () => rows<{ ch: string; state: string; src: string }>(
      "MATCH (:Content {id:$c})-[e:PUBLISHED_ON]->(ch:Channel) WHERE e.until IS NULL RETURN ch.id AS ch, e.state AS state, e.src AS src ORDER BY ch", { c: post });
    expect(await on()).toEqual([
      { ch: "channel:instagram", state: "scheduled", src: id },
      { ch: "channel:instagram:cafe", state: "scheduled", src: id },
    ]);
    await runDue(TENANT, h.g, env(), at + 60_000);
    expect(await on()).toEqual([
      { ch: "channel:instagram", state: "published", src: id },
      { ch: "channel:instagram:cafe", state: "published", src: id },
    ]);
    // the account is a Channel of its own, PART_OF the platform's channel, so the platform's numbers stay on one node
    expect(await rows(
      "MATCH (a:Channel {id:'channel:instagram:cafe'})-[e:PART_OF]->(g:Channel {id:'channel:instagram'}) RETURN a.name AS name, a.kind AS kind, a.handle AS handle, a.platform AS platform, g.name AS generic",
    )).toEqual([{ name: "Instagram @cafe", kind: "account", handle: "@cafe", platform: "instagram", generic: "Instagram" }]);
    expect(accountChannelId("instagram", { accountId: "1784", accountHandle: "@cafe" })).toBe("channel:instagram:cafe");
  });

  it("two accounts on one platform are two nodes, and a cancelled post says so on its edges", async () => {
    scriptInstagram(h);
    const first = nextId(), second = nextId();
    const shop = { id: "2222", name: "shop", handle: "@shop" };
    await run(first, await addCard(h.g, { id: first, at: NOW + 4 * DAY_MS }));
    await run(second, await addCard(h.g, { id: second, at: NOW + 4 * DAY_MS, account: shop }));
    const accounts = await rows<{ id: string }>(
      "MATCH (a:Channel)-[:PART_OF]->(:Channel {id:'channel:instagram'}) WHERE a.kind = 'account' RETURN DISTINCT a.id AS id ORDER BY id");
    expect(accounts.map((a) => a.id)).toEqual(["channel:instagram:cafe", "channel:instagram:shop"]);
    expect(await count("MATCH (:Content {id:$c})-[:PUBLISHED_ON]->(:Channel {id:'channel:instagram:shop'}) RETURN count(*) AS c", { c: contentIdFor(second) })).toBe(1);
    expect(await count("MATCH (:Content {id:$c})-[:PUBLISHED_ON]->(:Channel {id:'channel:instagram:shop'}) RETURN count(*) AS c", { c: contentIdFor(first) })).toBe(0);
    await cancelScheduled(h.g, contentIdFor(second), { now: NOW + 9 });
    expect(await rows("MATCH (:Content {id:$c})-[e:PUBLISHED_ON]->(ch:Channel) RETURN ch.id AS ch, e.state AS state ORDER BY ch", { c: contentIdFor(second) })).toEqual([
      { ch: "channel:instagram", state: "cancelled" }, { ch: "channel:instagram:shop", state: "cancelled" },
    ]);
  });

  it("Facebook's Page has no handle, so its channel is named by the Page's id", async () => {
    scriptFacebook(h);
    const id = nextId();
    await run(id, await addCard(h.g, { id, platform: "facebook", at: NOW + 5 * DAY_MS }));
    expect(await rows("MATCH (:Content {id:$c})-[e:PUBLISHED_ON]->(ch:Channel) RETURN ch.id AS ch, e.state AS state ORDER BY ch", { c: contentIdFor(id) })).toEqual([
      { ch: "channel:facebook", state: "scheduled" }, { ch: "channel:facebook:555", state: "scheduled" },
    ]);
    expect(ACCOUNTS.facebook.id).toBe("555");
  });
});

describe("a dry run keeps a planned post", () => {
  it("Content with status dry_run, on its channels (state dry_run) and advancing the goal, made by the agent; the platform is not called", async () => {
    scriptInstagram(h);
    const before = h.composio.executed().length;
    const id = nextId();
    const payload = await addCard(h.g, { id });
    await recommend(id);
    const a = await run(id, payload, { dryRun: true });
    expect(a).toMatchObject({ status: "dry_run", produced: [contentIdFor(id)] });
    expect(h.composio.executed().length).toBe(before); // not even a look at the account
    const post = contentIdFor(id);
    expect(await readPost(h.g, post)).toMatchObject({ status: "dry_run", platform: "instagram", retryable: false, attempts: 0 });
    expect(await rows("MATCH (:Content {id:$c})-[e:PUBLISHED_ON]->(ch:Channel) RETURN ch.id AS ch, e.state AS state ORDER BY ch", { c: post })).toEqual([
      { ch: "channel:instagram", state: "dry_run" }, { ch: "channel:instagram:cafe", state: "dry_run" },
    ]);
    expect(await count("MATCH (:Content {id:$c})-[:ADVANCES]->(:Goal {id:'goal:g11-enquiries'}) RETURN count(*) AS c", { c: post })).toBe(1);
    expect(await count("MATCH (:Content {id:$c})-[:USES_ASSET]->(:Asset {id:'asset:poster-a'}) RETURN count(*) AS c", { c: post })).toBe(1);
    expect(await count("MATCH (:Agent)-[e:PRODUCED]->(:Content {id:$c}) WHERE e.src = $a RETURN count(*) AS c", { c: post, a: id })).toBe(1);
    expect(await count("MATCH (:Approval {id:$a})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(:Content {id:$c}) RETURN count(*) AS c", { a: id, c: post })).toBe(1);
    // nothing for the scheduler to take, and no post counted against the day's limit
    expect((await runDue(TENANT, h.g, env(), NOW + 10 * DAY_MS)).map((r) => r.id)).not.toContain(post);
    expect((await readPost(h.g, post))?.counted).toBeUndefined();
  });
});
