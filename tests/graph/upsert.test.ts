import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import {
  upsertNode, upsertEdge, closeEdge, addObservation, writeBatch, MissingEndpoint, DisallowedRelationship, InvalidWrite,
} from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const T0 = 1_760_000_000_000;

describe("temporal upsert (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Person", id: "person:founder", name: "Founder" }, T0);
    await upsertNode(g, { type: "Agent", id: "agent:jarvis", name: "Jarvis" }, T0);
    await upsertNode(g, { type: "Document", id: "document:pending", name: "PENDING.md", props: { kind: "vault" } }, T0);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const count = async (cypher: string, params?: Record<string, unknown>) =>
    (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;

  it("1. upserting the same node twice makes one node, created only the first time, no Version", async () => {
    const n = { type: "Task" as const, id: "task:sitemap", name: "Fix sitemap", props: { status: "open", title: "Fix sitemap" }, src: "document:pending", asOf: "2026-10-14" };
    expect(await upsertNode(g, n, T0)).toEqual({ created: true, versioned: false, updated: false });
    expect(await upsertNode(g, n, T0 + 10)).toEqual({ created: false, versioned: false, updated: false });
    expect(await count("MATCH (n:Entity {id:'task:sitemap'}) RETURN count(n) AS c")).toBe(1);
    expect(await count("MATCH (:Entity {id:'task:sitemap'})-[:HAD_VERSION]->(v) RETURN count(v) AS c")).toBe(0);
    const [row] = await g.roQuery<Record<string, unknown>>("MATCH (n:Entity:Task {id:'task:sitemap'}) RETURN n.createdAt AS c, n.updatedAt AS u, n.src AS src, n.asOf AS asOf, n.status AS status");
    expect(row).toEqual({ c: T0, u: T0, src: "document:pending", asOf: "2026-10-14", status: "open" });
  });

  it("2. a tracked prop change writes a Version with the old props and updates the node", async () => {
    const r = await upsertNode(g, { type: "Task", id: "task:sitemap", name: "Fix sitemap", props: { status: "done" }, src: "document:pending", asOf: "2026-10-15" }, T0 + 100);
    expect(r).toEqual({ created: false, versioned: true, updated: true });
    const [v] = await g.roQuery<{ props: string; since: number; until: number; labels: string[]; of: string }>(
      "MATCH (:Entity {id:'task:sitemap'})-[:HAD_VERSION]->(v) RETURN v.props AS props, v.since AS since, v.until AS until, labels(v) AS labels, v.of AS of");
    expect(v!.labels).toEqual(expect.arrayContaining(["Entity", "Version"]));
    expect(v!.of).toBe("task:sitemap");
    // source time: the old state held from its source's date to the new source's date
    expect(v!.since).toBe(Date.parse("2026-10-14"));
    expect(v!.until).toBe(Date.parse("2026-10-15"));
    expect(JSON.parse(v!.props)).toMatchObject({ status: "open", title: "Fix sitemap", asOf: "2026-10-14" });
    const [cur] = await g.roQuery<Record<string, unknown>>("MATCH (n:Entity {id:'task:sitemap'}) RETURN n.status AS status, n.updatedAt AS u, n.asOf AS asOf");
    expect(cur).toEqual({ status: "done", u: T0 + 100, asOf: "2026-10-15" });
    // a second change: the new Version's since is when the previous state began
    await upsertNode(g, { type: "Task", id: "task:sitemap", name: "Fix sitemap", props: { status: "reopened" }, asOf: "2026-10-16" }, T0 + 200);
    const vs = await g.roQuery<{ since: number; until: number }>("MATCH (:Entity {id:'task:sitemap'})-[:HAD_VERSION]->(v) RETURN v.since AS since, v.until AS until ORDER BY v.until");
    expect(vs).toEqual([
      { since: Date.parse("2026-10-14"), until: Date.parse("2026-10-15") },
      { since: Date.parse("2026-10-15"), until: Date.parse("2026-10-16") },
    ]);
  });

  it("2d. Versions use record time (now) where the source has no date", async () => {
    const id = "task:undated";
    await upsertNode(g, { type: "Task", id, name: "U", props: { status: "open" } }, T0);
    await upsertNode(g, { type: "Task", id, name: "U", props: { status: "doing" } }, T0 + 10);
    // a dated source next: the undated state ran until that source's date
    const dated = Date.parse("2026-10-20");
    await upsertNode(g, { type: "Task", id, name: "U", props: { status: "done" }, asOf: "2026-10-20" }, dated + 99);
    const vs = await g.roQuery<{ since: number; until: number; props: string }>(
      "MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v) RETURN v.since AS since, v.until AS until, v.props AS props ORDER BY since", { id });
    expect(vs.map((v) => ({ since: v.since, until: v.until, status: JSON.parse(v.props).status }))).toEqual([
      { since: T0, until: T0 + 10, status: "open" },
      { since: T0 + 10, until: dated, status: "doing" },
    ]);
    expect((await g.roQuery("MATCH (n:Entity {id:$id}) RETURN n.stateSince AS s", { id }))[0]).toEqual({ s: dated });
  });

  it("2b. an untracked change updates in place without a Version; a first-time tracked value is not a change", async () => {
    await upsertNode(g, { type: "Task", id: "task:untracked", name: "X" }, T0);
    expect(await upsertNode(g, { type: "Task", id: "task:untracked", name: "X", summary: "new summary", props: { status: "open" } }, T0 + 5))
      .toEqual({ created: false, versioned: false, updated: true });
    expect(await count("MATCH (:Entity {id:'task:untracked'})-[:HAD_VERSION]->(v) RETURN count(v) AS c")).toBe(0);
  });

  it("2c. renaming a Decision (its display title is `name`) writes a Version", async () => {
    await upsertNode(g, { type: "Decision", id: "decision:rename-me", name: "Discord brain", props: { status: "accepted" } }, T0);
    expect(await upsertNode(g, { type: "Decision", id: "decision:rename-me", name: "Discord agent brain" }, T0 + 7))
      .toEqual({ created: false, versioned: true, updated: true });
    const [v] = await g.roQuery<{ props: string; changed: string[]; name: string }>(
      "MATCH (:Entity {id:'decision:rename-me'})-[:HAD_VERSION]->(v) RETURN v.props AS props, v.changed AS changed, v.name AS name");
    expect(JSON.parse(v!.props).name).toBe("Discord brain");
    expect(v!.changed).toEqual(["name"]);
    expect(v!.name).toBe(""); // a Version never shows up as an entity-search hit
  });

  it("3. upserting the same edge twice leaves exactly one current edge", async () => {
    await upsertNode(g, { type: "System", id: "system:gsc", name: "Search Console" }, T0);
    await upsertNode(g, { type: "System", id: "system:ops-mcp", name: "Ops MCP" }, T0);
    const e = { from: "system:gsc", type: "DEPENDS_ON" as const, to: "system:ops-mcp", src: "document:pending", asOf: "2026-10-14", conf: 0.9, props: { note: "pull" } };
    expect(await upsertEdge(g, e, T0)).toEqual({ created: true, closed: 0 });
    expect(await upsertEdge(g, { ...e, conf: 0.95 }, T0 + 50)).toEqual({ created: false, closed: 0 });
    const rows = await g.roQuery<Record<string, unknown>>(
      "MATCH (:Entity {id:'system:gsc'})-[r:DEPENDS_ON]->(:Entity {id:'system:ops-mcp'}) RETURN r.since AS since, r.until AS until, r.recordedAt AS rec, r.src AS src, r.asOf AS asOf, r.conf AS conf, r.note AS note");
    expect(rows).toEqual([{ since: T0, until: null, rec: T0, src: "document:pending", asOf: "2026-10-14", conf: 0.95, note: "pull" }]);
  });

  it("4. a functional edge with a new target closes the old one and keeps both", async () => {
    expect(await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:sitemap" }, T0)).toEqual({ created: true, closed: 0 });
    expect(await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:sitemap" }, T0 + 300)).toEqual({ created: true, closed: 1 });
    const rows = await g.roQuery<{ owner: string; until: number | null; retiredAt: number | null }>(
      "MATCH (o)-[r:OWNS]->(:Entity {id:'task:sitemap'}) RETURN o.id AS owner, r.until AS until, r.retiredAt AS retiredAt ORDER BY r.recordedAt");
    expect(rows).toEqual([
      { owner: "person:founder", until: T0 + 300, retiredAt: T0 + 300 },
      { owner: "agent:jarvis", until: null, retiredAt: null },
    ]);
    // OWNS is not functional for non-Task targets: two current owners of a System is fine
    await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "system:gsc" }, T0);
    expect(await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "system:gsc" }, T0)).toEqual({ created: true, closed: 0 });
  });

  it("4b. SUPERSEDES is functional on the target; functional:true makes the source the slot", async () => {
    for (const d of ["decision:d1", "decision:d2", "decision:d3"]) await upsertNode(g, { type: "Decision", id: d, name: d }, T0);
    await upsertEdge(g, { from: "decision:d2", type: "SUPERSEDES", to: "decision:d1" }, T0);
    expect((await upsertEdge(g, { from: "decision:d3", type: "SUPERSEDES", to: "decision:d1" }, T0 + 1)).closed).toBe(1);
    await upsertNode(g, { type: "Channel", id: "channel:instagram", name: "Instagram" }, T0);
    await upsertEdge(g, { from: "channel:instagram", type: "DEPENDS_ON", to: "system:gsc", functional: true }, T0);
    expect((await upsertEdge(g, { from: "channel:instagram", type: "DEPENDS_ON", to: "system:ops-mcp", functional: true }, T0 + 1)).closed).toBe(1);
    expect(await count("MATCH (:Entity {id:'channel:instagram'})-[r:DEPENDS_ON]->() WHERE r.until IS NULL RETURN count(r) AS c")).toBe(1);
  });

  it("5. closeEdge sets until and retiredAt and never deletes", async () => {
    await upsertEdge(g, { from: "person:founder", type: "KNOWS_ABOUT", to: "system:gsc", props: { weight: 3 } }, T0);
    const before = await count("MATCH ()-[r]->() RETURN count(r) AS c");
    expect(await closeEdge(g, "person:founder", "KNOWS_ABOUT", "system:gsc", T0 + 400, "left the project")).toBe(1);
    expect(await closeEdge(g, "person:founder", "KNOWS_ABOUT", "system:gsc", T0 + 500)).toBe(0);
    expect(await count("MATCH ()-[r]->() RETURN count(r) AS c")).toBe(before);
    const [r] = await g.roQuery<Record<string, unknown>>(
      "MATCH (:Entity {id:'person:founder'})-[r:KNOWS_ABOUT]->(:Entity {id:'system:gsc'}) RETURN r.until AS until, r.retiredAt AS ret, r.closeReason AS why, r.weight AS w");
    expect(r).toEqual({ until: T0 + 400, ret: T0 + 400, why: "left the project", w: 3 });
    // re-asserting a closed fact opens a new current edge; history stays
    expect((await upsertEdge(g, { from: "person:founder", type: "KNOWS_ABOUT", to: "system:gsc" }, T0 + 600)).created).toBe(true);
    expect(await count("MATCH (:Entity {id:'person:founder'})-[r:KNOWS_ABOUT]->(:Entity {id:'system:gsc'}) RETURN count(r) AS c")).toBe(2);
  });

  it("6. a missing endpoint throws MissingEndpoint", async () => {
    const p = upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:nope" });
    await expect(p).rejects.toBeInstanceOf(MissingEndpoint);
    await expect(upsertEdge(g, { from: "person:ghost", type: "OWNS", to: "task:nope" })).rejects.toThrow(/person:ghost.*task:nope/);
  });

  it("7. a disallowed pattern throws DisallowedRelationship", async () => {
    await upsertNode(g, { type: "Page", id: "page:www.aamdani.ai/jobs", name: "Jobs" }, T0);
    await expect(upsertEdge(g, { from: "page:www.aamdani.ai/jobs", type: "DECIDED", to: "person:founder" }))
      .rejects.toBeInstanceOf(DisallowedRelationship);
    await expect(upsertEdge(g, { from: "person:founder", type: "NOT_A_REL" as never, to: "task:sitemap" })).rejects.toBeInstanceOf(InvalidWrite);
  });

  it("an older source never overwrites newer state: it lands as a backdated Version", async () => {
    const id = "task:late-source";
    await upsertNode(g, { type: "Task", id, name: "Late", props: { status: "done" }, src: "document:pending", asOf: "2026-10-14" }, T0);
    const old = { type: "Task" as const, id, name: "Late", props: { status: "open" }, src: "document:old", asOf: "2026-09-01" };
    expect(await upsertNode(g, old, T0 + 10)).toEqual({ created: false, versioned: true, updated: false });
    const [cur] = await g.roQuery<Record<string, unknown>>("MATCH (n:Entity {id:$id}) RETURN n.status AS status, n.asOf AS asOf, n.src AS src", { id });
    expect(cur).toEqual({ status: "done", asOf: "2026-10-14", src: "document:pending" });
    const versions = async () => g.roQuery<{ props: string; since: number; until: number; backdated: boolean }>(
      "MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v) RETURN v.props AS props, v.since AS since, v.until AS until, v.backdated AS backdated", { id });
    const [v] = await versions();
    expect(JSON.parse(v!.props)).toMatchObject({ status: "open", asOf: "2026-09-01", src: "document:old" });
    expect(v).toMatchObject({ since: Date.parse("2026-09-01"), until: Date.parse("2026-10-14"), backdated: true });
    // replaying the same old source is a no-op; an old source that agrees with the current state adds nothing
    expect(await upsertNode(g, old, T0 + 20)).toEqual({ created: false, versioned: false, updated: false });
    expect(await upsertNode(g, { ...old, props: { status: "done" } }, T0 + 30)).toEqual({ created: false, versioned: false, updated: false });
    expect(await versions()).toHaveLength(1);
    // a newer source still moves the state on
    expect(await upsertNode(g, { ...old, props: { status: "archived" }, asOf: "2026-10-20" }, T0 + 40)).toEqual({ created: false, versioned: true, updated: true });
    expect(await versions()).toHaveLength(2);
  });

  it("an older source still adds what the node lacks, without overwriting anything", async () => {
    const id = "task:backfill";
    await upsertNode(g, { type: "Task", id, name: "Backfill", props: { status: "done", owner_note: "current" }, src: "document:new", asOf: "2026-10-14" }, T0);
    const old = { type: "Task" as const, id, name: "Backfill", summary: "From the old doc", src: "document:old", asOf: "2026-09-01",
      props: { status: "open", owner_note: "old note", priority: "high" } };
    expect(await upsertNode(g, old, T0 + 1)).toEqual({ created: false, versioned: true, updated: true });
    const [n] = await g.roQuery<Record<string, unknown>>(
      "MATCH (n:Entity {id:$id}) RETURN n.status AS status, n.owner_note AS note, n.priority AS priority, n.summary AS summary, n.src AS src, n.asOf AS asOf", { id });
    expect(n).toEqual({ status: "done", note: "current", priority: "high", summary: "From the old doc", src: "document:new", asOf: "2026-10-14" });
    // replaying it changes nothing
    expect(await upsertNode(g, old, T0 + 2)).toEqual({ created: false, versioned: false, updated: false });
    expect(await count("MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v) RETURN count(v) AS c", { id })).toBe(1);
  });

  it("a functional close sets until to the new edge's since and retiredAt to now", async () => {
    await upsertNode(g, { type: "Task", id: "task:handover", name: "Handover" }, T0);
    await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:handover", since: T0 + 10 }, T0 + 10);
    expect(await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:handover", since: T0 + 20 }, T0 + 30)).toEqual({ created: true, closed: 1 });
    const rows = await g.roQuery<Record<string, unknown>>(
      "MATCH (o)-[r:OWNS]->(:Entity {id:'task:handover'}) RETURN o.id AS o, r.since AS since, r.until AS until, r.retiredAt AS ret ORDER BY r.since");
    expect(rows).toEqual([
      { o: "person:founder", since: T0 + 10, until: T0 + 20, ret: T0 + 30 },
      { o: "agent:jarvis", since: T0 + 20, until: null, ret: null },
    ]);
  });

  it("a late-arriving older owner does not displace the current one", async () => {
    await upsertNode(g, { type: "Task", id: "task:late-owner", name: "Late owner" }, T0);
    await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:late-owner", since: T0 + 100 }, T0 + 100);
    expect(await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:late-owner", since: T0 + 50 }, T0 + 200))
      .toEqual({ created: true, closed: 0 });
    const rows = await g.roQuery<Record<string, unknown>>(
      "MATCH (o)-[r:OWNS]->(:Entity {id:'task:late-owner'}) RETURN o.id AS o, r.since AS since, r.until AS until, r.retiredAt AS ret ORDER BY r.since");
    expect(rows).toEqual([
      { o: "person:founder", since: T0 + 50, until: T0 + 100, ret: T0 + 200 }, // created already closed
      { o: "agent:jarvis", since: T0 + 100, until: null, ret: null },
    ]);
  });

  it("re-asserting an edge keeps the stronger fact (missing conf = 1, deterministic)", async () => {
    await upsertNode(g, { type: "System", id: "system:conf-a", name: "A" }, T0);
    await upsertNode(g, { type: "System", id: "system:conf-b", name: "B" }, T0);
    await upsertNode(g, { type: "System", id: "system:conf-c", name: "C" }, T0);
    const edge = async (to: string) => (await g.roQuery<Record<string, unknown>>(
      "MATCH (:Entity {id:'system:conf-a'})-[r:DEPENDS_ON]->(:Entity {id:$to}) WHERE r.until IS NULL RETURN r.conf AS conf, r.src AS src, r.asOf AS asOf, r.note AS note", { to }))[0];
    // deterministic edge, then a weaker LLM re-assert: nothing changes
    await upsertEdge(g, { from: "system:conf-a", type: "DEPENDS_ON", to: "system:conf-b", src: "document:pending", asOf: "2026-10-14", props: { note: "registry" } }, T0);
    await upsertEdge(g, { from: "system:conf-a", type: "DEPENDS_ON", to: "system:conf-b", src: "document:llm", asOf: "2026-10-15", conf: 0.6, props: { note: "guess" } }, T0 + 1);
    expect(await edge("system:conf-b")).toEqual({ conf: null, src: "document:pending", asOf: "2026-10-14", note: "registry" });
    // LLM edge at 0.7: a weaker re-assert keeps it, an equal or stronger one takes over, a deterministic one wins outright
    await upsertEdge(g, { from: "system:conf-a", type: "DEPENDS_ON", to: "system:conf-c", src: "document:x", asOf: "2026-10-10", conf: 0.7 }, T0);
    await upsertEdge(g, { from: "system:conf-a", type: "DEPENDS_ON", to: "system:conf-c", src: "document:y", asOf: "2026-10-11", conf: 0.5 }, T0 + 1);
    expect(await edge("system:conf-c")).toMatchObject({ conf: 0.7, src: "document:x", asOf: "2026-10-10" });
    await upsertEdge(g, { from: "system:conf-a", type: "DEPENDS_ON", to: "system:conf-c", src: "document:z", asOf: "2026-10-12", conf: 0.7 }, T0 + 2);
    expect(await edge("system:conf-c")).toMatchObject({ conf: 0.7, src: "document:z", asOf: "2026-10-12" });
    await upsertEdge(g, { from: "system:conf-a", type: "DEPENDS_ON", to: "system:conf-c", src: "document:pending", asOf: "2026-10-13" }, T0 + 3);
    expect(await edge("system:conf-c")).toMatchObject({ conf: null, src: "document:pending", asOf: "2026-10-13" });
  });

  it("a weaker observation never overwrites a stronger one with the same id", async () => {
    await upsertNode(g, { type: "Channel", id: "channel:conf-ig", name: "IG" }, T0);
    const measured = { subject: "channel:conf-ig", metric: "followers", value: 1200, asOf: "2026-10-14", src: "document:pending" };
    const id = await addObservation(g, measured, T0);
    const value = async () => (await g.roQuery<{ v: number; conf: number | null }>("MATCH (o:Entity {id:$id}) RETURN o.value AS v, o.conf AS conf", { id }))[0];
    const stats = await writeBatch(g, { observations: [{ ...measured, value: 1500, conf: 0.6, evidence: "about 1.5k followers" }] }, T0 + 1);
    expect(stats).toMatchObject({ observations: 0, skippedWeaker: 1, versions: 0 });
    expect(await value()).toEqual({ v: 1200, conf: null });
    // reported first, then measured: the measurement wins and the report stays as a Version
    const rid = await addObservation(g, { ...measured, metric: "reach", value: 90, conf: 0.6 }, T0);
    expect((await g.roQuery("MATCH (o:Entity {id:$rid}) RETURN o.conf AS conf", { rid }))[0]).toEqual({ conf: 0.6 });
    const s2 = await writeBatch(g, { observations: [{ ...measured, metric: "reach", value: 95 }] }, T0 + 2);
    expect(s2).toMatchObject({ observations: 1, skippedWeaker: 0, versions: 1 });
    expect((await g.roQuery("MATCH (o:Entity {id:$rid}) RETURN o.value AS v, o.conf AS conf", { rid }))[0]).toEqual({ v: 95, conf: null });
    // equal conf behaves as before: update and version
    await addObservation(g, { ...measured, metric: "reach", value: 96 }, T0 + 3);
    expect((await g.roQuery("MATCH (:Entity {id:$rid})-[:HAD_VERSION]->(v) RETURN count(v) AS c", { rid }))[0]).toEqual({ c: 2 });
  });

  it("concurrent creates of one node report created exactly once", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => upsertNode(g, { type: "Task", id: "task:race", name: "Race" }, T0)));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(await count("MATCH (n:Entity {id:'task:race'}) RETURN count(n) AS c")).toBe(1);
  });

  it("concurrent tracked updates never version the same state twice", async () => {
    await upsertNode(g, { type: "Task", id: "task:race2", name: "R", props: { status: "open" } }, T0);
    const rs = await Promise.all([
      upsertNode(g, { type: "Task", id: "task:race2", name: "R", props: { status: "done" } }, T0 + 1),
      upsertNode(g, { type: "Task", id: "task:race2", name: "R", props: { status: "blocked" } }, T0 + 2),
    ]);
    expect(rs.map((r) => r.versioned)).toEqual([true, true]);
    const vs = await g.roQuery<{ props: string }>("MATCH (:Entity {id:'task:race2'})-[:HAD_VERSION]->(v) RETURN v.props AS props");
    expect(vs.map((v) => JSON.parse(v.props).status).sort()).toEqual(["done", "open"]);
  });

  it("concurrent functional edges leave exactly one current owner", async () => {
    await upsertNode(g, { type: "Task", id: "task:race3", name: "R3" }, T0);
    const rs = await Promise.all([
      upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:race3" }, T0 + 1),
      upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:race3" }, T0 + 2),
      upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:race3" }, T0 + 3),
    ]);
    expect(rs.filter((r) => r.created)).toHaveLength(2);
    expect(await count("MATCH ()-[r:OWNS]->(:Entity {id:'task:race3'}) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(1);
    expect(await count("MATCH ()-[r:OWNS]->(:Entity {id:'task:race3'}) RETURN count(r) AS c")).toBe(2);
  });

  it("closes a functional slot only when the new edge is created; duplicate current edges get closed", async () => {
    await upsertNode(g, { type: "Task", id: "task:slot", name: "Slot" }, T0);
    await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:slot" }, T0);
    // simulate legacy inconsistency: a second current owner and a duplicate current jarvis edge written behind our back
    await g.query("MATCH (a:Entity {id:'person:founder'}), (t:Entity {id:'task:slot'}) CREATE (a)-[:OWNS {since:1, recordedAt:1}]->(t)");
    await g.query("MATCH (a:Entity {id:'agent:jarvis'}), (t:Entity {id:'task:slot'}) CREATE (a)-[:OWNS {since:2, recordedAt:$rec}]->(t)", { rec: T0 + 1 });
    expect(await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:slot" }, T0 + 5)).toEqual({ created: false, closed: 1 });
    const cur = await g.roQuery<{ o: string }>("MATCH (o)-[r:OWNS]->(:Entity {id:'task:slot'}) WHERE r.until IS NULL RETURN o.id AS o ORDER BY o");
    expect(cur.map((r) => r.o)).toEqual(["agent:jarvis", "person:founder"]); // re-assert leaves the slot alone
  });

  it("validates node input", async () => {
    await expect(upsertNode(g, { type: "Decision", id: "task:sitemap", name: "wrong type" })).rejects.toThrow(/Task/);
    await expect(upsertNode(g, { type: "Task", id: "decision:x", name: "x" })).rejects.toBeInstanceOf(InvalidWrite);
    await expect(upsertNode(g, { type: "Task", id: "nocolon", name: "x" })).rejects.toThrow(/prefix/);
    await expect(upsertNode(g, { type: "Observation", id: "task:x", name: "x" })).rejects.toBeInstanceOf(InvalidWrite);
    expect((await upsertNode(g, { type: "BrandRule", id: "brand-rule:no-jargon", name: "No jargon" })).created).toBe(true);
    await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "x", props: { "bad-key": 1 } })).rejects.toBeInstanceOf(InvalidWrite);
    await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "x", props: { createdAt: 1 } })).rejects.toThrow(/reserved/);
    await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "x", props: { rev: 9 } })).rejects.toThrow(/reserved/);
    await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "x", embedding: [1, 2, 3] })).rejects.toThrow(/384/);
    await expect(upsertNode(g, { type: "Nope" as never, id: "x:y", name: "x" })).rejects.toBeInstanceOf(InvalidWrite);
    await expect(upsertEdge(g, { from: "task:sitemap", type: "BLOCKS", to: "task:sitemap" })).rejects.toThrow(/itself/);
  });

  it("stores an Observation with MEASURES, SOURCED_FROM and versioned corrections", async () => {
    await upsertNode(g, { type: "Document", id: "document:snapshot-2026-10-14", name: "ops snapshot" }, T0);
    const o = { subject: "channel:instagram", metric: "followers", value: 1200, unit: "count", windowEnd: "2026-10-14", asOf: "2026-10-14", src: "document:snapshot-2026-10-14" };
    const id = await addObservation(g, o, T0);
    expect(id).toBe("obs:followers:channel:instagram:2026-10-14");
    expect(await addObservation(g, o, T0 + 1)).toBe(id);
    const rows = await g.roQuery<Record<string, unknown>>(
      "MATCH (o:Entity:Observation {id:$id})-[:MEASURES]->(s) OPTIONAL MATCH (o)-[:SOURCED_FROM]->(d) RETURN s.id AS s, d.id AS d, o.value AS v, o.metric AS m, o.unit AS u", { id });
    expect(rows).toEqual([{ s: "channel:instagram", d: "document:snapshot-2026-10-14", v: 1200, m: "followers", u: "count" }]);
    await addObservation(g, { ...o, value: 1250 }, T0 + 2);
    const [v] = await g.roQuery<{ props: string }>("MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v) RETURN v.props AS props", { id });
    expect(JSON.parse(v!.props).value).toBe(1200);
    expect(await count("MATCH (o:Entity {id:$id}) WHERE o.value = 1250 RETURN count(o) AS c", { id })).toBe(1);
  });

  it("keeps an Observation whose source document is not ingested yet, and passes simulated through", async () => {
    const id = await addObservation(g, { subject: "channel:instagram", metric: "ad_spend", value: 500.5, asOf: "2026-10-13", src: "document:later", simulated: true }, T0);
    expect(id).toBe("obs:ad_spend:channel:instagram:2026-10-13");
    const [r] = await g.roQuery<Record<string, unknown>>(
      "MATCH (o:Entity {id:$id}) OPTIONAL MATCH (o)-[s:SOURCED_FROM]->() RETURN o.src AS src, o.simulated AS sim, count(s) AS links", { id });
    expect(r).toEqual({ src: "document:later", sim: true, links: 0 });
    await expect(addObservation(g, { subject: "channel:none", metric: "x", value: 1, asOf: "2026-10-13", src: "document:later" })).rejects.toBeInstanceOf(MissingEndpoint);
  });

  it("writeBatch writes nodes, then observations, then edges and collects per-item errors", async () => {
    // own fixtures (beyond the beforeAll people and document): a task with a status and a current owner
    await upsertNode(g, { type: "Task", id: "task:batch", name: "Batch task", props: { status: "open" } }, T0);
    await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:batch" }, T0);
    const stats = await writeBatch(g, {
      nodes: [
        { type: "Product", id: "product:batch-app", name: "Aamdani app" },
        { type: "Feature", id: "feature:batch-jobs", name: "Jobs" },
        { type: "Task", id: "task:batch", name: "Batch task", props: { status: "blocked" } },
        { type: "Task", id: "task:batch-bad", name: "bad", props: { "x-y": 1 } },
      ],
      edges: [
        { from: "feature:batch-jobs", type: "PART_OF", to: "product:batch-app" },
        { from: "feature:batch-jobs", type: "PART_OF", to: "product:missing" },
        { from: "person:founder", type: "OWNS", to: "task:batch" },
      ],
      observations: [{ subject: "feature:batch-jobs", metric: "signups", value: 42, asOf: "2026-10-14", src: "document:pending" }],
    }, T0 + 1000);
    expect(stats).toMatchObject({ nodesCreated: 2, nodesUpdated: 1, versions: 1, edgesCreated: 2, edgesClosed: 1, observations: 1, skippedWeaker: 0 });
    expect(stats.errors.map((e) => e.kind)).toEqual(["node", "edge"]);
    expect(stats.errors[1]!.error).toMatch(/product:missing/);
  });

  it("writeBatch lets an edge point at an observation from the same batch, and keeps its evidence quote", async () => {
    await upsertNode(g, { type: "Channel", id: "channel:batch-ig", name: "Instagram" }, T0);
    const o = { subject: "channel:batch-ig", metric: "share_of_reach", value: 90, unit: "%", asOf: "2026-09-28", src: "document:pending", evidence: "Reels drove 90% of reach" };
    const obsId = "obs:share_of_reach:channel:batch-ig:2026-09-28";
    const stats = await writeBatch(g, {
      nodes: [{ type: "Decision", id: "decision:pause-facebook", name: "Pause Facebook posts" }],
      edges: [{ from: "decision:pause-facebook", type: "BASED_ON", to: obsId }],
      observations: [o],
    }, T0 + 2000);
    expect(stats.errors).toEqual([]);
    expect(stats).toMatchObject({ edgesCreated: 1, observations: 1 });
    const [r] = await g.roQuery<Record<string, unknown>>(
      "MATCH (:Entity {id:'decision:pause-facebook'})-[:BASED_ON]->(o:Observation) RETURN o.id AS id, o.evidence AS ev");
    expect(r).toEqual({ id: obsId, ev: "Reels drove 90% of reach" });
  });
});
