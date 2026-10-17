// One business out of Allevia (issue #23): `tenant:export` writes everything that is theirs to one file that reads back whole, and
// `tenant:erase` exports first, then removes the graph, the registry rows, the Discord mapping, the data folders and the sealed
// connection tokens, and only for the business it was told to. A throwaway registry graph, throwaway data folder and businesses on
// the test database; never allevia_meta, never the real data folder.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issueToken, verifyToken } from "../../src/auth/tokens.js";
import { loadCommands } from "../../src/cli.js";
import { SealedVault } from "../../src/connectors/google/store.js";
import { closeAll, connect, graphName, openGraph, openGraphByName } from "../../src/graph/client.js";
import { ensureTenant, getTenant, linkRegistry, listTenants, setDemo } from "../../src/graph/tenants.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { Refused, eraseTenant, exportTenant, readRegistryRows, sealedConnections, tenantFolders, verifyTenantExport } from "../../src/tenant/lifecycle.js";
import { slugify } from "../../src/util/ids.js";
import { testGraphName } from "../helpers/graph.js";

const metaGraph = testGraphName();
const opts = { metaGraph };
const saved = { meta: process.env.ALLEVIA_META_GRAPH, data: process.env.ALLEVIA_DATA_DIR };
const tag = randomBytes(3).toString("hex");
const A = `test_lc_a_${tag}`;
const B = `test_lc_b_${tag}`;
const DEMO = `test_lc_demo_${tag}`;
const LINKED = `test_lc_link_${tag}`;
const NOGRAPH = `test_lc_nog_${tag}`;
let dataDir: string;
const tokens: Record<string, string> = {};
const KEY = "k".repeat(40);
const SEALED_VALUE = "sealedvalue-should-not-travel";
const JOIN_CODE = "JOINCODE-should-not-travel";
const bigFile = randomBytes(9 * 1024 * 1024); // three chunks

const put = (rel: string, body: string | Buffer): void => {
  const p = join(dataDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

async function business(slug: string, name: string, o: { files?: boolean } = {}): Promise<void> {
  await ensureTenant({ slug, name, domain: `${slug}.example` }, opts);
  const g = await openGraph(slug);
  const s = await writeBatch(g, {
    nodes: [
      { type: "Channel", id: "channel:instagram", name: "Instagram" },
      { type: "Memory", id: "memory:t-1-1", name: `${name} note`, summary: `A note for ${name}`, props: { kind: "fact", text: `A note for ${name}` } },
    ],
    edges: [{ from: "memory:t-1-1", type: "ABOUT", to: "channel:instagram" }],
  }, Date.now());
  expect(s.errors).toEqual([]);
  tokens[slug] = (await issueToken(slug, { label: `${name} owner` }, opts)).token;
  const meta = await openGraphByName(metaGraph);
  await meta.query(
    `CREATE (:DiscordArea {slug:$slug, status:'ready', lockToken:'transient'}), (:DiscordChannel {channelId:$ch, slug:$slug, kind:'approvals', guildId:'g1', mappedAt:1}),
            (:DiscordInvite {code:$code, slug:$slug, status:'open', createdAt:1}), (:DiscordPost {key:$post, slug:$slug, kind:'approval', channelId:$ch, closed:false, postedAt:1})`,
    { slug, ch: `ch-${slug}`, code: JOIN_CODE, post: `post-${slug}` });
  if (o.files === false) return;
  put(`assets/${slug}/${"a".repeat(64)}.jpg`, `${name} photo`);
  put(`assets/${slug}/${"b".repeat(64)}.mp4`, bigFile);
  put(`drafts/${slug}/post.md`, `draft of ${name}`);
  put(`drafts/${slugify(slug)}/second.md`, `second draft of ${name}`);
  put(`cache/extract/${slug}/e.json`, "{}");
  put(`cache/studio/${slug}/s.json`, "{}");
  put(`onboard/${slug}/screenshots/home.png`, "png");
  put(`runs/${slug}/run.json`, "{}");
  put(`snapshots/${slug}/ops.txt`, "snapshot");
  put(`studio-demo/${slug}/rough.jpg`, "demo photo");
  await new SealedVault(dataDir, KEY).put(slug, "gmail", { accessToken: SEALED_VALUE });
  put(`connectors/${slug}/audit.jsonl`, `{"at":1,"tenant":"${slug}","connector":"gmail","op":"read","ok":true}\n`);
}

const graphs = async (): Promise<string[]> => (await connect()).list();
const registryCount = async (slug: string): Promise<number> => {
  const r = await readRegistryRows(slug, opts);
  return (r.tenant ? 1 : 0) + r.tokens.length + (r.discord.area ? 1 : 0) + r.discord.channels.length + r.discord.invites.length + r.discord.posts.length;
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "allevia-lifecycle-"));
  process.env.ALLEVIA_META_GRAPH = metaGraph;
  process.env.ALLEVIA_DATA_DIR = dataDir;
  await business(A, "Alpha Foods");
  await business(B, "Bravo Builders");
  await business(DEMO, "Demo Cafe");
  await business(LINKED, "Link Linen", { files: false });
  await linkRegistry(opts);
  // one thing that belongs to nobody: a shared cache file and the ledgers
  put("cache/extract/legacy-shared.json", "{}");
  put("studio/credit-ledger.json", JSON.stringify({ version: 1, entries: [{ tenant: A, credits: 1 }] }));
}, 120_000);

afterAll(async () => {
  if (saved.meta === undefined) delete process.env.ALLEVIA_META_GRAPH; else process.env.ALLEVIA_META_GRAPH = saved.meta;
  if (saved.data === undefined) delete process.env.ALLEVIA_DATA_DIR; else process.env.ALLEVIA_DATA_DIR = saved.data;
  for (const slug of [A, B, DEMO, LINKED, NOGRAPH]) await (await openGraphByName(graphName(slug))).drop();
  await (await openGraphByName(metaGraph)).drop();
  await closeAll();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("what belongs to a business", () => {
  it("is a short list of folders under the data folder, named by a valid slug and nothing else", () => {
    const folders = tenantFolders(dataDir, A).map((p) => p.slice(dataDir.length + 1));
    expect(folders).toEqual(expect.arrayContaining([
      `assets/${A}`, `drafts/${A}`, `drafts/${slugify(A)}`, `cache/extract/${A}`, `cache/studio/${A}`, `onboard/${A}`, `runs/${A}`, `snapshots/${A}`, `studio-demo/${A}`, `connectors/${A}`,
    ]));
    for (const p of folders) expect(p.split("/").slice(-1)[0]).toMatch(/^[a-z0-9_-]+$/);
    expect(() => tenantFolders(dataDir, "../etc")).toThrow();
    expect(() => tenantFolders(dataDir, "meta")).toThrow();
  });

  it("names the connections that have sealed tokens, and no more than their names", () => {
    expect(sealedConnections(dataDir, A)).toEqual(["gmail"]);
    expect(sealedConnections(dataDir, NOGRAPH)).toEqual([]);
  });
});

describe("tenant:export", () => {
  it("writes the registry rows, the whole graph and every file to one file that reads back whole, and leaves out what only opens on the server", async () => {
    const file = join(dataDir, "out", "alpha.jsonl");
    const r = await exportTenant(A, file, { ...opts, dataDir });
    expect(r.graph).toMatchObject({ name: graphName(A) });
    expect(r.graph!.nodes).toBeGreaterThanOrEqual(3); // the business, the channel, the note
    expect(r.registry).toEqual({ tenants: 1, ownerLinks: 1, discordAreas: 1, discordChannels: 1, discordInvites: 1, discordPosts: 1 });
    expect(r.sealedLeftOut).toEqual(["gmail"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const check = await verifyTenantExport(file);
    expect(check).toMatchObject({ ok: true, slug: A, nodes: r.graph!.nodes, edges: r.graph!.edges, files: r.files, bytes: r.bytes });
    expect(check.paths).toEqual(expect.arrayContaining([`assets/${A}/${"a".repeat(64)}.jpg`, `assets/${A}/${"b".repeat(64)}.mp4`, `drafts/${A}/post.md`, `drafts/${slugify(A)}/second.md`, `runs/${A}/run.json`, `connectors/${A}/audit.jsonl`]));
    expect(check.paths.some((p) => p.endsWith(".sealed"))).toBe(false);
    expect(check.bytes).toBeGreaterThan(bigFile.length);

    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(SEALED_VALUE);
    expect(text).not.toContain(JOIN_CODE);
    expect(text).not.toContain("transient"); // a lock token is bookkeeping
    const meta = await openGraphByName(metaGraph);
    const [row] = await meta.roQuery<{ hash: string }>("MATCH (k:AuthToken {scope:$s}) RETURN k.hash AS hash", { s: A });
    expect(text).not.toContain(row!.hash);
    expect(text).not.toContain(tokens[A]!.slice(tokens[A]!.indexOf(".") + 1));
    expect(text).toContain("Alpha Foods");
    expect(text).not.toContain("Bravo Builders"); // another business's data is not in it
    // the big file came in three chunks
    expect(text.split("\n").filter((l) => l.startsWith('{"kind":"chunk"') && l.includes(`${"b".repeat(64)}.mp4`)).length).toBe(3);
  });

  it("never writes over a file that is there", async () => {
    const file = join(dataDir, "out", "twice.jsonl");
    await exportTenant(B, file, { ...opts, dataDir });
    await expect(exportTenant(B, file, { ...opts, dataDir })).rejects.toBeInstanceOf(Refused);
  });

  it("says plainly when there is nothing to export, and exports a business that has no graph left", async () => {
    await expect(exportTenant(`test_lc_nobody_${tag}`, join(dataDir, "out", "nobody.jsonl"), { ...opts, dataDir })).rejects.toThrow(/nothing for/);
    await (await openGraphByName(graphName(LINKED))).drop(); // registry rows and no graph: what is left of a half-erased business
    const file = join(dataDir, "out", "nograph.jsonl");
    const r = await exportTenant(LINKED, file, { ...opts, dataDir });
    expect(r.graph).toBeNull();
    expect(await verifyTenantExport(file)).toMatchObject({ ok: true, nodes: 0, edges: 0 });
    // restore, so teardown finds what it expects
    await ensureTenant({ slug: LINKED, name: "Link Linen" }, opts);
  });

  it("is checked when it is read back: an edited chunk, a cut-short file and a foreign file are all refused", async () => {
    const file = join(dataDir, "out", "tamper.jsonl");
    await exportTenant(B, file, { ...opts, dataDir });
    const lines = readFileSync(file, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith('{"kind":"chunk"'));
    const o = JSON.parse(lines[i]!) as { b64: string };
    const flipped = o.b64.startsWith("A") ? `B${o.b64.slice(1)}` : `A${o.b64.slice(1)}`;
    const edited = join(dataDir, "out", "edited.jsonl");
    writeFileSync(edited, [...lines.slice(0, i), JSON.stringify({ ...JSON.parse(lines[i]!), b64: flipped }), ...lines.slice(i + 1)].join("\n"));
    expect((await verifyTenantExport(edited)).problems.join(" ")).toMatch(/does not match its hash|bytes read/);
    const cut = join(dataDir, "out", "cut.jsonl");
    writeFileSync(cut, lines.slice(0, -3).join("\n"));
    expect((await verifyTenantExport(cut)).problems.join(" ")).toMatch(/no end line|chunks|out of place/);
    const foreign = join(dataDir, "out", "foreign.jsonl");
    writeFileSync(foreign, '{"kind":"header","format":"allevia-graph-export","version":1}\n');
    expect((await verifyTenantExport(foreign)).ok).toBe(false);
  });
});

describe("tenant:erase", () => {
  it("refuses without the business id repeated, and changes nothing", async () => {
    await expect(eraseTenant(B, { ...opts, dataDir, confirm: "something_else" })).rejects.toThrow(/--confirm must repeat/);
    await expect(eraseTenant(B, { ...opts, dataDir, confirm: "" })).rejects.toBeInstanceOf(Refused);
    expect(await graphs()).toContain(graphName(B));
    expect(await registryCount(B)).toBeGreaterThan(0);
  });

  it("refuses a public demo unless --force, and the founder's own businesses unless --force", async () => {
    expect(await setDemo(DEMO, true, opts)).toBe(true);
    await expect(eraseTenant(DEMO, { ...opts, dataDir, confirm: DEMO })).rejects.toThrow(/public demo/);
    expect(await graphs()).toContain(graphName(DEMO));
    expect(existsSync(join(dataDir, "assets", DEMO))).toBe(true);
    expect(await getTenant(DEMO, opts)).not.toBeNull();
    // the founder's business: something of it is on disk, the guard says no before anything is touched
    put("runs/aamdani/run.json", "{}");
    await expect(eraseTenant("aamdani", { ...opts, dataDir, confirm: "aamdani" })).rejects.toThrow(/founder's own businesses/);
    expect(existsSync(join(dataDir, "runs", "aamdani", "run.json"))).toBe(true);
    expect(existsSync(join(dataDir, "exports"))).toBe(false); // refused before the export too
    rmSync(join(dataDir, "runs", "aamdani"), { recursive: true });
  });

  it("exports first, checks the export, then removes the graph, the registry rows, the folders and the sealed tokens: that business only", async () => {
    const before = await getTenant(A, opts);
    expect(before).not.toBeNull();
    expect(await verifyToken(tokens[A]!, opts)).toMatchObject({ scope: A });
    const r = await eraseTenant(A, { ...opts, dataDir, confirm: A, now: Date.parse("2026-10-17T10:00:00Z") });

    // the export came first, and is whole
    expect(r.exportFile).toBe(join(dataDir, "exports", `${A}-20261017-100000.jsonl`));
    expect(await verifyTenantExport(r.exportFile)).toMatchObject({ ok: true, slug: A, nodes: r.graph!.nodes, edges: r.graph!.edges });
    expect(readFileSync(r.exportFile, "utf8")).toContain("Alpha Foods");

    // gone: the graph, every registry row, every folder, the sealed tokens
    expect(r.leftovers).toEqual([]);
    expect(r.graph).toMatchObject({ name: graphName(A), dropped: true });
    expect(await graphs()).not.toContain(graphName(A));
    expect(await registryCount(A)).toBe(0);
    expect(await getTenant(A, opts)).toBeNull();
    expect((await listTenants(opts)).map((t) => t.slug)).not.toContain(A);
    expect(await verifyToken(tokens[A]!, opts)).toBeNull();
    for (const f of tenantFolders(dataDir, A)) expect(existsSync(f), f).toBe(false);
    expect(sealedConnections(dataDir, A)).toEqual([]);
    expect(r.sealedConnections).toEqual(["gmail"]);
    expect(r.registry).toEqual({ tenants: 1, ownerLinks: 1, discordAreas: 1, discordChannels: 1, discordInvites: 1, discordPosts: 1 });

    // the Discord rows are gone from the registry; nothing here talks to Discord (there is no client in this code path)
    const meta = await openGraphByName(metaGraph);
    const [left] = await meta.roQuery<{ c: number }>("MATCH (n) WHERE n.slug = $s OR n.scope = $s RETURN count(n) AS c", { s: A });
    expect(left!.c).toBe(0);

    // the other business is whole
    expect(await graphs()).toContain(graphName(B));
    expect(await getTenant(B, opts)).not.toBeNull();
    expect(await registryCount(B)).toBe(6); // the business, one owner link, the Discord area, channel, invite and post record
    expect(await verifyToken(tokens[B]!, opts)).toMatchObject({ scope: B });
    for (const f of tenantFolders(dataDir, B).filter((p) => p.includes(`/${B}`))) expect(existsSync(f), f).toBe(true);
    expect(sealedConnections(dataDir, B)).toEqual(["gmail"]);
    const g = await openGraph(B);
    const [nodes] = await g.roQuery<{ c: number }>("MATCH (n:Memory) RETURN count(n) AS c");
    expect(nodes!.c).toBe(1);

    // what belongs to nobody stays: the shared cache, the ledgers; and a line says it happened, with nothing of the business in it
    expect(existsSync(join(dataDir, "cache", "extract", "legacy-shared.json"))).toBe(true);
    expect(existsSync(join(dataDir, "studio", "credit-ledger.json"))).toBe(true);
    const line = JSON.parse(readFileSync(join(dataDir, "erasures.jsonl"), "utf8").trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({ slug: A, at: "2026-10-17T10:00:00.000Z" });
    expect(JSON.stringify(line)).not.toMatch(/Alpha|Foods|memory/);
  }, 90_000);

  it("--force erases a public demo, export and all", async () => {
    const r = await eraseTenant(DEMO, { ...opts, dataDir, confirm: DEMO, force: true });
    expect(r.leftovers).toEqual([]);
    expect(await graphs()).not.toContain(graphName(DEMO));
    expect(await getTenant(DEMO, opts)).toBeNull();
    expect((await verifyTenantExport(r.exportFile)).ok).toBe(true);
  }, 60_000);

  it("erases a business that is only registry rows (no graph, no files) and says there is nothing for one that is not there", async () => {
    await (await openGraphByName(graphName(LINKED))).drop();
    const r = await eraseTenant(LINKED, { ...opts, dataDir, confirm: LINKED });
    expect(r).toMatchObject({ graph: null, leftovers: [] });
    expect(await getTenant(LINKED, opts)).toBeNull();
    await expect(eraseTenant(LINKED, { ...opts, dataDir, confirm: LINKED })).rejects.toThrow(/nothing for/);
    await ensureTenant({ slug: LINKED, name: "Link Linen" }, opts); // restore, so teardown finds what it expects
  }, 60_000);

  it("never follows a link out of the data folder: it removes the link, and what it pointed at stays", async () => {
    const slug = `test_lc_sym_${tag}`;
    await ensureTenant({ slug, name: "Linked Co" }, opts);
    const outside = mkdtempSync(join(tmpdir(), "allevia-outside-"));
    writeFileSync(join(outside, "keep.txt"), "mine");
    mkdirSync(join(dataDir, "assets"), { recursive: true });
    symlinkSync(outside, join(dataDir, "assets", slug));
    try {
      const r = await eraseTenant(slug, { ...opts, dataDir, confirm: slug });
      expect(r.leftovers).toEqual([]);
      expect(existsSync(join(dataDir, "assets", slug))).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("mine");
      expect(readFileSync(r.exportFile, "utf8")).not.toContain("keep.txt"); // a link is not followed on export either
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the commands", () => {
  async function run(name: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const cmd = (await loadCommands()).find((c) => c.name === name)!;
    let out = "", err = "";
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { out += `${a.join(" ")}\n`; });
    const error = vi.spyOn(console, "error").mockImplementation((...a) => { err += `${a.join(" ")}\n`; });
    try { return { code: (await cmd.run(args)) ?? 0, out, err }; } finally { log.mockRestore(); error.mockRestore(); }
  }

  it("are listed", async () => {
    const names = (await loadCommands()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["tenant:export", "tenant:erase"]));
  });

  it("tenant:export needs a business and a file, writes it, checks it, and says what it left out", async () => {
    expect((await run("tenant:export")).code).toBe(2);
    expect((await run("tenant:export", B)).code).toBe(2);
    const file = join(dataDir, "cli-export.jsonl");
    const r = await run("tenant:export", B, file);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${B} -> ${file}`);
    expect(r.out).toMatch(/graph: \d+ nodes, \d+ edges/);
    expect(r.out).toMatch(/not exported: the sealed connection tokens \(gmail\)/);
    expect(r.out).toMatch(/reads back whole/);
    expect(r.out).not.toMatch(/redis:|password|#key=/);
    expect((await run("tenant:export", B, file)).code).toBe(1); // it is there already
    expect((await run("tenant:export", `test_lc_nobody_${tag}`, join(dataDir, "none.jsonl"))).err).toMatch(/nothing for/);
  });

  it("tenant:erase will not run without --confirm <the same id>, and runs with it", async () => {
    expect((await run("tenant:erase")).code).toBe(2);
    expect((await run("tenant:erase", B)).code).toBe(2);
    expect((await run("tenant:erase", B, "--confirm", "other")).err).toMatch(/repeating the business id: --confirm test_lc_b_/);
    expect(await graphs()).toContain(graphName(B));
    const exportTo = join(dataDir, "kept", "bravo.jsonl");
    const r = await run("tenant:erase", B, "--confirm", B, "--export-to", exportTo);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Erased ${B}.`);
    expect(r.out).toContain(`export kept at ${exportTo}`);
    expect(r.out).toMatch(/Discord channels are still on Discord/);
    expect(r.out).toMatch(/revoke gmail at the provider/);
    expect(await graphs()).not.toContain(graphName(B));
    expect(existsSync(exportTo)).toBe(true);
    expect(readdirSync(join(dataDir, "assets")).includes(B)).toBe(false);
  }, 90_000);
});
