// `tenant:import`, the mirror of `tenant:export`: a business moved to another server keeps its graph (counts, digest, typed values),
// its registry entry field by field (the demo and showcase flags too) and every file. The "other server" is a fresh registry graph
// and a fresh data folder on the test database (127.0.0.1:6391); the business's graph is dropped after the export, as if it had
// never been on this server. Never allevia_meta, never the real data folder.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issueToken } from "../../src/auth/tokens.js";
import { loadCommands } from "../../src/cli.js";
import { closeAll, connect, graphName, openGraph, openGraphByName } from "../../src/graph/client.js";
import { ensureTenant, getTenant, setShowcase } from "../../src/graph/tenants.js";
import { readGraph, summarize } from "../../src/graph/transfer.js";
import { GraphHandle } from "../../src/graph/client.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { Refused, exportTenant, importTarget, importTenant, readRegistryRows } from "../../src/tenant/lifecycle.js";
import { slugify } from "../../src/util/ids.js";
import { testGraphName } from "../helpers/graph.js";

const tag = randomBytes(3).toString("hex");
const S = `test_imp_${tag}`;
const RENAMED = `test_imp_as_${tag}`;
const fromMeta = testGraphName();
const toMeta = testGraphName();
const saved = { meta: process.env.ALLEVIA_META_GRAPH, data: process.env.ALLEVIA_DATA_DIR };
let fromData: string;
let toData: string;
let exportFile: string;
let before: { nodes: number; edges: number; digest: string };
const photo = randomBytes(5 * 1024 * 1024); // two chunks

const put = (dir: string, rel: string, body: string | Buffer): void => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

async function digestOf(slug: string): Promise<{ nodes: number; edges: number; digest: string }> {
  const db = await connect();
  const name = graphName(slug);
  const d = await readGraph(new GraphHandle(name, db.selectGraph(name), db), db);
  const s = summarize(d.nodes, d.edges);
  return { nodes: s.nodes, edges: s.edges, digest: s.digest };
}

beforeAll(async () => {
  fromData = mkdtempSync(join(tmpdir(), "allevia-import-from-"));
  toData = mkdtempSync(join(tmpdir(), "allevia-import-to-"));
  process.env.ALLEVIA_META_GRAPH = fromMeta;
  await ensureTenant({ slug: S, name: "Kestrel & Oak", domain: "kestrel.example", city: "Leeds", currency: "GBP" }, { metaGraph: fromMeta });
  expect(await setShowcase(S, true, { metaGraph: fromMeta })).toBe(true);
  await issueToken(S, { label: "owner" }, { metaGraph: fromMeta });
  const meta = await openGraphByName(fromMeta);
  await meta.query("CREATE (:DiscordArea {slug:$slug, status:'ready'}), (:DiscordChannel {channelId:$ch, slug:$slug, kind:'approvals', guildId:'g1', mappedAt:1}), (:DiscordInvite {code:'JOIN', slug:$slug, status:'open', createdAt:1}), (:DiscordPost {key:$post, slug:$slug, kind:'approval', channelId:$ch, closed:false, postedAt:1})",
    { slug: S, ch: `ch-${S}`, post: `post-${S}` });
  const g = await openGraph(S);
  const w = await writeBatch(g, {
    nodes: [
      { type: "Channel", id: "channel:instagram", name: "Instagram" },
      { type: "Person", id: "person:priya-shah", name: "Priya Shah", props: { email: "priya@example.com", role: "lead" } },
      { type: "Lead", id: "lead:priya-example-com", name: "Priya Shah: a quote for oak shelves", props: { stage: "contacted" } },
      { type: "Memory", id: "memory:t-1-1", name: "Weekend note", summary: "Weekends sell best", props: { kind: "fact", text: "Weekends sell best", weight: 3.0 } },
    ],
    edges: [{ from: "lead:priya-example-com", type: "ENQUIRED_BY", to: "person:priya-shah" }, { from: "memory:t-1-1", type: "ABOUT", to: "channel:instagram" }],
  }, Date.now());
  expect(w.errors).toEqual([]);
  put(fromData, `assets/${S}/${"a".repeat(64)}.jpg`, photo);
  put(fromData, `drafts/${slugify(S)}/post.md`, "a draft post");
  put(fromData, `cache/extract/${S}/e.json`, "{}");
  put(fromData, `connectors/${S}/audit.jsonl`, "{}\n");
  before = await digestOf(S);
  exportFile = join(fromData, "out", `${S}.jsonl`);
  await exportTenant(S, exportFile, { metaGraph: fromMeta, dataDir: fromData });
  // the other server: the graph is not there, the registry and the data folder are new
  await g.drop();
  process.env.ALLEVIA_META_GRAPH = toMeta;
  process.env.ALLEVIA_DATA_DIR = toData;
}, 120_000);

afterAll(async () => {
  if (saved.meta === undefined) delete process.env.ALLEVIA_META_GRAPH; else process.env.ALLEVIA_META_GRAPH = saved.meta;
  if (saved.data === undefined) delete process.env.ALLEVIA_DATA_DIR; else process.env.ALLEVIA_DATA_DIR = saved.data;
  for (const s of [S, RENAMED]) await (await openGraph(s)).drop().catch(() => {});
  for (const m of [fromMeta, toMeta]) await (await openGraphByName(m)).drop().catch(() => {});
  await closeAll();
  rmSync(fromData, { recursive: true, force: true });
  rmSync(toData, { recursive: true, force: true });
});

describe("tenant:import", () => {
  it("restores the graph, the registry entry and the files of an export into a fresh registry, and the counts match", async () => {
    const r = await importTenant(exportFile, { metaGraph: toMeta, dataDir: toData });
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ slug: S, from: S, replaced: false, files: 4, graph: { name: graphName(S), nodes: before.nodes, edges: before.edges } });
    expect(await digestOf(S)).toEqual(before); // node for node, edge for edge, a Float still a Float

    const src = await readRegistryRows(S, { metaGraph: fromMeta });
    const dst = await readRegistryRows(S, { metaGraph: toMeta });
    expect(dst.tenant).toEqual(src.tenant); // every field: name, domain, city, currency, businessId, createdAt, demo, showcase
    expect(await getTenant(S, { metaGraph: toMeta })).toMatchObject({ name: "Kestrel & Oak", demo: true, showcase: true });
    expect(dst.discord.channels).toHaveLength(1);
    expect(dst.discord.posts).toHaveLength(1);
    expect(dst.discord.area).not.toBeNull();
    expect(dst.discord.invites).toEqual([]); // no join code in the file: an invite would not work
    expect(dst.tokens).toEqual([]);          // no hash in the file: new owner links are issued here
    expect(r.registry).toMatchObject({ ownerLinksLeftOut: 1, discordLeftOut: 1 });

    expect(readFileSync(join(toData, "assets", S, `${"a".repeat(64)}.jpg`)).equals(photo)).toBe(true);
    expect(readFileSync(join(toData, "drafts", slugify(S), "post.md"), "utf8")).toBe("a draft post");
    expect(existsSync(join(toData, "cache", "extract", S, "e.json"))).toBe(true);
    expect(existsSync(join(toData, "connectors", S, "audit.jsonl"))).toBe(true);
  }, 90_000);

  it("refuses a business that is already here and changes nothing; --replace overwrites it and keeps the sealed tokens", async () => {
    const g = await openGraph(S);
    await writeBatch(g, { nodes: [{ type: "Channel", id: "channel:extra", name: "Extra" }], edges: [] }, Date.now());
    await expect(importTenant(exportFile, { metaGraph: toMeta, dataDir: toData })).rejects.toThrow(/already on this server .*--replace/);
    expect((await digestOf(S)).nodes).toBe(before.nodes + 1); // untouched
    put(toData, `connectors/${S}/gmail.sealed`, "sealed elsewhere"); // the operator copied the connections
    put(toData, `runs/${S}/stale.json`, "{}");                       // something of the old copy that the file does not have
    const r = await importTenant(exportFile, { metaGraph: toMeta, dataDir: toData, replace: true });
    expect(r.problems).toEqual([]);
    expect(r.replaced).toBe(true);
    expect(await digestOf(S)).toEqual(before);
    expect(readFileSync(join(toData, "connectors", S, "gmail.sealed"), "utf8")).toBe("sealed elsewhere");
    expect(existsSync(join(toData, "runs", S, "stale.json"))).toBe(false);
    const meta = await openGraphByName(toMeta);
    const [t] = await meta.roQuery<{ c: number }>("MATCH (t:Tenant {slug:$s}) RETURN count(t) AS c", { s: S });
    expect(t!.c).toBe(1);
  }, 90_000);

  it("--as imports under another id: the graph and folders take the new id, the Business keeps its own, the Discord mapping stays behind", async () => {
    const r = await importTenant(exportFile, { metaGraph: toMeta, dataDir: toData, as: RENAMED });
    expect(r.problems).toEqual([]);
    expect(r.graph?.name).toBe(graphName(RENAMED));
    expect(await digestOf(RENAMED)).toEqual(before);
    const t = await getTenant(RENAMED, { metaGraph: toMeta });
    expect(t).toMatchObject({ slug: RENAMED, graph: graphName(RENAMED), name: "Kestrel & Oak", businessId: (await getTenant(S, { metaGraph: toMeta }))!.businessId });
    expect(existsSync(join(toData, "assets", RENAMED, `${"a".repeat(64)}.jpg`))).toBe(true);
    expect(existsSync(join(toData, "drafts", slugify(RENAMED), "post.md"))).toBe(true);
    const rows = await readRegistryRows(RENAMED, { metaGraph: toMeta });
    expect(rows.discord.area).toBeNull();
    expect(r.registry.discordLeftOut).toBe(4);
  }, 90_000);

  it("refuses a file that is not whole, and a file that would write outside the business's folders", async () => {
    const lines = readFileSync(exportFile, "utf8").trim().split("\n");
    const cut = join(fromData, "out", "cut.jsonl");
    writeFileSync(cut, lines.slice(0, -2).join("\n"));
    await expect(importTenant(cut, { metaGraph: toMeta, dataDir: toData, replace: true })).rejects.toBeInstanceOf(Refused);
    expect(importTarget(`assets/${S}/x.jpg`, S, S)).toBe(`assets/${S}/x.jpg`);
    expect(importTarget(`assets/other_co/x.jpg`, S, S)).toBeUndefined();
    expect(importTarget(`studio/credit-ledger.json`, S, S)).toBeUndefined();
    expect(importTarget(`assets/${S}/../../etc/passwd`, S, S)).toBeUndefined();
    expect(importTarget(`cache/extract/${S}/e.json`, S, RENAMED)).toBe(`cache/extract/${RENAMED}/e.json`);
    expect(importTarget(`drafts/${slugify(S)}/p.md`, S, RENAMED)).toBe(`drafts/${slugify(RENAMED)}/p.md`);
  });

  it("the command says what it did and what is left for a person to do", async () => {
    const cmd = (await loadCommands()).find((c) => c.name === "tenant:import")!;
    let out = "", err = "";
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { out += `${a.join(" ")}\n`; });
    const error = vi.spyOn(console, "error").mockImplementation((...a) => { err += `${a.join(" ")}\n`; });
    try {
      expect(await cmd.run([])).toBe(2);
      expect(await cmd.run([exportFile])).toBe(1);
      expect(err).toMatch(/already on this server/);
      expect(await cmd.run([exportFile, "--replace"])).toBe(0);
    } finally { log.mockRestore(); error.mockRestore(); }
    expect(out).toMatch(/graph: \d+ nodes, \d+ edges, read back against the file/);
    expect(out).toMatch(/counted again/);
    expect(out).toMatch(/issue new ones with auth:issue/);
    expect(out).toMatch(/same ALLEVIA_CONNECTOR_KEY and COMPOSIO_API_KEY/);
  }, 90_000);
});
