// One business, taken out of Allevia or removed from it (issue #23: "no per-business erase or export command"). Isolation says what
// belongs to a business; this is the same list used twice:
//
//   export  one file with everything of the business's that is theirs: the registry rows (its Tenant, its owner links without their
//           hashes, its Discord mapping without the join codes), the whole graph (every node, edge, vector, index and constraint, the
//           format of `db:export`), and every file in its data folders (photos, drafts, run reports, caches), in chunks.
//           Never the sealed connection tokens: they are encrypted with the server's key and mean nothing to anyone else.
//   erase   exports first and checks the export reads back whole; only then removes the graph, the registry rows (Tenant, AuthToken,
//           its account invites and who was a member of it (the accounts themselves stay: a person may be in other businesses),
//           the Discord area, channel mapping, invites and post records: the Discord channels themselves stay on Discord), and the
//           data folders, sealed connection tokens included. Refuses a public demo unless --force. Leaves a line in
//           <data>/erasures.jsonl (the id and when, nothing else) and the export, which is the customer's to be handed and then deleted.
//   import  the mirror of export, on another server: checks the file whole, refuses a business that is already there unless
//           --replace, then writes the graph, the registry rows and the files, and counts them all again (see "import" below).
//
// The file is JSON lines, one object a line:
//   {"kind":"tenant-export", ...}     first: format, version, the business id, when
//   {"kind":"registry", ...}          the registry rows
//   header / node / edge / end        the graph, exactly as `db:export` writes it (src/graph/transfer.ts); or {"kind":"graph-missing"}
//   {"kind":"file", path, bytes, sha256, chunks}  then `chunks` lines {"kind":"chunk", path, n, b64}, for each file
//   {"kind":"export-end", files, bytes}          last: a file without it did not finish
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, appendFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GraphHandle, connect, graphName, openGraphByName } from "../graph/client.js";
import { assertTenantSlug } from "../graph/slug.js";
import { loadConfig } from "../config.js";
import { ensureIndexes } from "../graph/indexes.js";
import { getTenant, linkRegistry, metaName, type TenantOpts } from "../graph/tenants.js";
import { importDump, readGraph, summarize, type EdgeLine, type EndLine, type ExportHeader, type GraphDump, type NodeLine } from "../graph/transfer.js";
import { TENANT_CONFIGS } from "../tenant-config.js";
import { tenantCacheDirs } from "../util/cache.js";
import { slugify } from "../util/ids.js";

export const TENANT_EXPORT_FORMAT = "allevia-tenant-export";
export const TENANT_EXPORT_VERSION = 1;
const CHUNK_BYTES = 4 * 1024 * 1024;

export interface LifecycleOpts extends TenantOpts {
  /** Where the business's folders are (the config's data dir). */
  dataDir: string;
  now?: number;
  log?: (line: string) => void;
}

/** Why a command was refused: said to the operator as it is, nothing was changed. */
export class Refused extends Error {
  override name = "Refused";
}

const missingGraph = (e: unknown): boolean => /empty key/i.test(String((e as Error)?.message));

// ---------- what belongs to a business ----------

/** The folders a business's files are in, whether or not they exist (all under the data dir, all named by a valid slug). */
export function tenantFolders(dataDir: string, slug: string): string[] {
  const s = assertTenantSlug(slug);
  return [
    join(dataDir, "assets", s), join(dataDir, "drafts", s), join(dataDir, "drafts", slugify(s)),
    ...tenantCacheDirs(dataDir, s), // util/cache.ts names the cache folders
    join(dataDir, "onboard", s), join(dataDir, "runs", s), join(dataDir, "snapshots", s), join(dataDir, "studio-demo", s),
    join(dataDir, "connectors", s), // the sealed connection tokens, and the business's connection audit log
  ];
}

const isDir = (p: string): boolean => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

function existingFolders(dataDir: string, slug: string): string[] {
  return tenantFolders(dataDir, slug).filter((p) => isDir(p) || isLink(p));
}

function inside(dataDir: string, p: string): string {
  const root = resolve(dataDir);
  const full = resolve(p);
  if (full === root || !full.startsWith(root + sep)) throw new Error(`refusing a path outside the data folder: ${p}`);
  return full;
}

// Regular files under a folder, sorted; links and anything odd are left out (and, on erase, not followed).
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (isDir(dir)) walk(dir);
  return out;
}

const isSealed = (p: string): boolean => p.endsWith(".sealed") || /\.sealed\.\d+\.\d+\.tmp$/.test(p);

/** The names of the connections a business has sealed tokens for (names only: which providers still need revoking). */
export function sealedConnections(dataDir: string, slug: string): string[] {
  const dir = join(dataDir, "connectors", assertTenantSlug(slug));
  return isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sealed")).map((f) => f.slice(0, -".sealed".length)).sort() : [];
}

// ---------- the registry rows ----------

export interface RegistryRows {
  tenant: Record<string, unknown> | null;
  tokens: Array<{ tokenId: string; label: string; createdAt: number; expiresAt: number | null; revokedAt: number | null }>;
  discord: { area: Record<string, unknown> | null; channels: Array<Record<string, unknown>>; invites: Array<Record<string, unknown>>; posts: Array<Record<string, unknown>> };
}

// What never leaves in an export: a join code is a credential, a lock or sync token is bookkeeping.
const secretKey = (k: string): boolean => k === "code" || /token$/i.test(k);
const withoutSecrets = (p: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(p).filter(([k]) => !secretKey(k)));

async function metaRows<T>(opts: TenantOpts, cypher: string, params: Record<string, unknown>): Promise<T[]> {
  const meta = await openGraphByName(metaName(opts));
  try {
    return await meta.roQuery<T>(cypher, params);
  } catch (e) {
    if (missingGraph(e)) return []; // no registry yet
    throw e;
  }
}

export async function readRegistryRows(slug: string, opts: TenantOpts = {}): Promise<RegistryRows> {
  const s = assertTenantSlug(slug);
  const props = async (label: string, key: string): Promise<Array<Record<string, unknown>>> =>
    (await metaRows<{ p: Record<string, unknown> }>(opts, `MATCH (n:${label} {${key}:$slug}) RETURN properties(n) AS p`, { slug: s })).map((r) => withoutSecrets(r.p));
  const tokens = await metaRows<{ tokenId: string; label: string | null; createdAt: number; expiresAt: number | null; revokedAt: number | null }>(opts,
    "MATCH (k:AuthToken {scope:$slug}) RETURN k.tokenId AS tokenId, k.label AS label, k.createdAt AS createdAt, k.expiresAt AS expiresAt, k.revokedAt AS revokedAt", { slug: s });
  return {
    tenant: (await props("Tenant", "slug"))[0] ?? null,
    tokens: tokens.map((t) => ({ tokenId: t.tokenId, label: t.label ?? "", createdAt: t.createdAt, expiresAt: t.expiresAt ?? null, revokedAt: t.revokedAt ?? null })),
    discord: { area: (await props("DiscordArea", "slug"))[0] ?? null, channels: await props("DiscordChannel", "slug"), invites: await props("DiscordInvite", "slug"), posts: await props("DiscordPost", "slug") },
  };
}

const registryCounts = (r: RegistryRows) => ({
  tenants: r.tenant ? 1 : 0, ownerLinks: r.tokens.length, discordAreas: r.discord.area ? 1 : 0, discordChannels: r.discord.channels.length,
  discordInvites: r.discord.invites.length, discordPosts: r.discord.posts.length,
});

// ---------- export ----------

export interface ExportReport {
  file: string;
  slug: string;
  graph: { name: string; nodes: number; edges: number; digest: string } | null;
  registry: ReturnType<typeof registryCounts>;
  files: number;
  bytes: number;
  sealedLeftOut: string[];       // connection names whose sealed tokens were not exported
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const rel = (dataDir: string, p: string): string => relative(resolve(dataDir), resolve(p)).split(sep).join("/");

/** Writes everything that is the business's to `file` (which must not exist yet). */
export async function exportTenant(slug: string, file: string, opts: LifecycleOpts): Promise<ExportReport> {
  const s = assertTenantSlug(slug);
  const name = graphName(s);
  const log = opts.log ?? (() => undefined);
  if (existsSync(file)) throw new Refused(`${file} already exists. Choose a new file name; an export is never written over another.`);
  const db = await connect();
  const hasGraph = (await db.list()).includes(name);
  const registry = await readRegistryRows(s, opts);
  const folders = existingFolders(opts.dataDir, s);
  if (!hasGraph && !registry.tenant && !folders.length) throw new Refused(`There is nothing for "${s}": no graph, no registry entry and no files.`);

  const dump = hasGraph ? await readGraph(new GraphHandle(name, db.selectGraph(name), db), db) : null;
  const files = folders.filter((f) => !isLink(f)).flatMap((f) => filesUnder(f)).filter((p) => !isSealed(p));
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const out = createWriteStream(file, { encoding: "utf8", mode: 0o600 });
  const put = async (o: unknown): Promise<void> => { if (!out.write(`${JSON.stringify(o)}\n`)) await once(out, "drain"); };
  let bytes = 0;
  try {
    await put({ kind: "tenant-export", format: TENANT_EXPORT_FORMAT, version: TENANT_EXPORT_VERSION, slug: s, graph: name, exportedAt: new Date(opts.now ?? Date.now()).toISOString() });
    await put({ kind: "registry", ...registry });
    if (dump) {
      await put(dump.header);
      for (const n of dump.nodes) await put(n);
      for (const e of dump.edges) await put(e);
      await put(dump.end);
    } else await put({ kind: "graph-missing", graph: name });
    for (const p of files) {
      const buf = readFileSync(p);
      const path = rel(opts.dataDir, p);
      const chunks = Math.ceil(buf.length / CHUNK_BYTES);
      await put({ kind: "file", path, bytes: buf.length, sha256: sha256(buf), chunks });
      for (let n = 0; n < chunks; n++) await put({ kind: "chunk", path, n, b64: buf.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES).toString("base64") });
      bytes += buf.length;
    }
    await put({ kind: "export-end", files: files.length, bytes });
  } finally {
    out.end();
    await once(out, "finish");
  }
  log(`exported ${s}: ${dump ? `${dump.nodes.length} nodes, ${dump.edges.length} edges` : "no graph"}, ${files.length} files (${bytes} bytes) -> ${file}`);
  return {
    file, slug: s, graph: dump ? { name, nodes: dump.nodes.length, edges: dump.edges.length, digest: dump.end.digest } : null,
    registry: registryCounts(registry), files: files.length, bytes, sealedLeftOut: sealedConnections(opts.dataDir, s),
  };
}

// ---------- reading an export back ----------

export interface ExportCheck {
  ok: boolean;
  problems: string[];
  slug: string | null;
  nodes: number;
  edges: number;
  files: number;
  bytes: number;
  paths: string[];
}

/** Reads a whole export and checks it: format and version, the graph's counts and digest, every file's size and hash, and the end line. */
export async function verifyTenantExport(file: string): Promise<ExportCheck> {
  const problems: string[] = [];
  const nodes: NodeLine[] = [];
  const edges: EdgeLine[] = [];
  let first: { kind?: string; format?: string; version?: number; slug?: string } | undefined;
  let header: ExportHeader | undefined;
  let end: { nodes: number; edges: number; digest: string } | undefined;
  let graphMissing = false;
  let last = "";
  let sawRegistry = false;
  let cur: { path: string; bytes: number; sha256: string; chunks: number; seen: number; size: number; hash: ReturnType<typeof createHash> } | undefined;
  const paths: string[] = [];
  let files = 0, bytes = 0, lineNo = 0;
  const closeFile = (): void => {
    if (!cur) return;
    if (cur.seen !== cur.chunks) problems.push(`${cur.path}: ${cur.seen} of ${cur.chunks} chunks`);
    else if (cur.size !== cur.bytes) problems.push(`${cur.path}: ${cur.size} bytes read, ${cur.bytes} expected`);
    else if (cur.hash.digest("hex") !== cur.sha256) problems.push(`${cur.path}: its content does not match its hash`);
    cur = undefined;
  };
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    lineNo++;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { problems.push(`line ${lineNo} is not JSON`); continue; }
    last = String(o.kind);
    switch (o.kind) {
      case "tenant-export": first = o as typeof first; break;
      case "registry": sawRegistry = true; break;
      case "header": header = o as unknown as ExportHeader; break;
      case "node": nodes.push(o as unknown as NodeLine); break;
      case "edge": edges.push(o as unknown as EdgeLine); break;
      case "end": end = o as unknown as typeof end; break;
      case "graph-missing": graphMissing = true; break;
      case "file":
        closeFile();
        files++;
        bytes += Number(o.bytes);
        paths.push(String(o.path));
        if (/(^|\/)\.\.(\/|$)/.test(String(o.path)) || String(o.path).startsWith("/")) problems.push(`a file path leaves the data folder: ${String(o.path)}`);
        cur = { path: String(o.path), bytes: Number(o.bytes), sha256: String(o.sha256), chunks: Number(o.chunks), seen: 0, size: 0, hash: createHash("sha256") };
        break;
      case "chunk": {
        if (!cur || cur.path !== o.path || cur.seen !== o.n) { problems.push(`a chunk of ${String(o.path)} is out of place`); break; }
        const buf = Buffer.from(String(o.b64), "base64");
        cur.hash.update(buf);
        cur.size += buf.length;
        cur.seen++;
        break;
      }
      case "export-end": closeFile(); if (Number(o.files) !== files || Number(o.bytes) !== bytes) problems.push("the end line's file counts do not match the files"); break;
      default: problems.push(`line ${lineNo} is of an unknown kind`);
    }
  }
  if (first?.format !== TENANT_EXPORT_FORMAT) problems.push(`${file} is not an ${TENANT_EXPORT_FORMAT} file`);
  else if (first.version !== TENANT_EXPORT_VERSION) problems.push(`it is export version ${first.version}; this code reads version ${TENANT_EXPORT_VERSION}`);
  if (last !== "export-end") problems.push("the file has no end line: the export did not finish or was cut short");
  if (!sawRegistry) problems.push("the registry line is missing");
  if (!graphMissing) {
    if (!header || !end) problems.push("the graph's header or end line is missing");
    else {
      if (nodes.length !== end.nodes || edges.length !== end.edges || nodes.length !== header.counts.nodes || edges.length !== header.counts.edges) problems.push("the graph's counts do not match its lines");
      else if (summarize(nodes, edges).digest !== end.digest) problems.push("the graph's content does not match its digest");
    }
  }
  return { ok: problems.length === 0, problems, slug: first?.slug ?? null, nodes: nodes.length, edges: edges.length, files, bytes, paths };
}

// ---------- erase ----------

export interface EraseReport {
  slug: string;
  exportFile: string;
  export: ExportReport;
  graph: { name: string; nodes: number; edges: number; dropped: boolean } | null;
  registry: ReturnType<typeof registryCounts>;
  folders: string[];                 // relative to the data folder
  sealedConnections: string[];       // names of the connections whose sealed tokens were deleted
  leftovers: string[];               // anything that was still there afterwards (empty when it all went)
}

export interface EraseOpts extends LifecycleOpts {
  /** The business id again, typed by the operator: the guard against erasing the wrong business. */
  confirm: string;
  /** Erase a public demo, or one of the founder's own businesses, as well. */
  force?: boolean;
  /** Where the export goes (default: <data>/exports/<slug>-<time>.jsonl). */
  exportTo?: string;
}

const REGISTRY_DELETES: Array<{ label: string; key: string }> = [
  { label: "DiscordPost", key: "slug" }, { label: "DiscordChannel", key: "slug" }, { label: "DiscordArea", key: "slug" },
  { label: "DiscordInvite", key: "slug" }, { label: "AuthToken", key: "scope" }, { label: "Invite", key: "slug" },
  { label: "Tenant", key: "slug" }, // its MEMBER_OF edges go with it; the accounts stay (a person may be in other businesses)
];

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

export async function eraseTenant(slug: string, o: EraseOpts): Promise<EraseReport> {
  const s = assertTenantSlug(slug);
  const name = graphName(s);
  const log = o.log ?? (() => undefined);
  const now = o.now ?? Date.now();
  if (o.confirm !== s) throw new Refused(`--confirm must repeat the business id exactly: --confirm ${s}`);

  const tenant = await getTenant(s, o);
  const db = await connect();
  const hasGraph = (await db.list()).includes(name);
  const folders = existingFolders(o.dataDir, s);
  if (!tenant && !hasGraph && !folders.length) throw new Refused(`There is nothing for "${s}": no graph, no registry entry and no files.`);
  if (tenant?.demo === true && !o.force) throw new Refused(`${s} is a public demo business. Erasing it takes it off the public demo; add --force if that is what you want.`);
  if (Object.hasOwn(TENANT_CONFIGS, s) && !o.force) throw new Refused(`${s} is one of the founder's own businesses. Add --force if you really mean to erase it.`);

  // 1. The export, checked, before anything is removed.
  const exportFile = o.exportTo ?? join(o.dataDir, "exports", `${s}-${stamp(now)}.jsonl`);
  const exported = await exportTenant(s, exportFile, o);
  const check = await verifyTenantExport(exportFile);
  if (!check.ok) throw new Refused(`The export did not read back whole, so nothing was erased (${check.problems[0]}). The export file is ${exportFile}.`);
  log(`the export reads back whole: ${check.nodes} nodes, ${check.edges} edges, ${check.files} files`);

  const registry = await readRegistryRows(s, o);
  const connections = sealedConnections(o.dataDir, s);

  // 2. The graph (its projections go with it).
  let dropped = false;
  if (hasGraph) {
    await new GraphHandle(name, db.selectGraph(name), db).drop();
    dropped = true;
    log(`dropped ${name}`);
  }

  // 3. The registry rows: the business, its owner links, its Discord mapping. The Discord channels themselves are not touched.
  const meta = await openGraphByName(metaName(o));
  for (const { label, key } of REGISTRY_DELETES) {
    try {
      await meta.query(`MATCH (n:${label} {${key}:$slug}) DETACH DELETE n`, { slug: s });
    } catch (e) {
      if (!missingGraph(e)) throw e;
    }
  }
  log("removed its registry rows");

  // 4. The folders, sealed connection tokens included. A link is unlinked, never followed.
  const removed: string[] = [];
  for (const f of folders) {
    const p = inside(o.dataDir, f);
    if (isLink(p)) unlinkSync(p);
    else rmSync(p, { recursive: true, force: true });
    removed.push(rel(o.dataDir, p));
  }

  // 5. A line that it happened (the id and the time, nothing of the business's).
  mkdirSync(o.dataDir, { recursive: true });
  appendFileSync(join(o.dataDir, "erasures.jsonl"), `${JSON.stringify({ at: new Date(now).toISOString(), slug: s, nodes: exported.graph?.nodes ?? 0, edges: exported.graph?.edges ?? 0, files: exported.files, export: rel(o.dataDir, exportFile).startsWith("..") ? "elsewhere" : rel(o.dataDir, exportFile) })}\n`, { mode: 0o600 });

  // 6. Look again.
  const leftovers: string[] = [];
  if ((await db.list()).includes(name)) leftovers.push(`the graph ${name}`);
  const again = await readRegistryRows(s, o);
  for (const [k, n] of Object.entries(registryCounts(again))) if (n > 0) leftovers.push(`${n} registry row${n === 1 ? "" : "s"} (${k})`);
  for (const f of existingFolders(o.dataDir, s)) leftovers.push(`the folder ${rel(o.dataDir, f)}`);

  return {
    slug: s, exportFile, export: exported,
    graph: exported.graph ? { name, nodes: exported.graph.nodes, edges: exported.graph.edges, dropped } : null,
    registry: registryCounts(registry), folders: removed, sealedConnections: connections, leftovers,
  };
}

// ---------- import ----------
//
// The mirror of export: one business's file, read into this server's database and data folder (moving a business from one server
// to another, e.g. the founder's Mac on FalkorDB Cloud to the public server). In this order, and only after the whole file has
// been read back and checked (verifyTenantExport):
//   1. refuse when the business is already here (a registry row, a graph or files), unless `replace`: then its graph, its Tenant
//      row and Discord mapping and its files are cleared first (its owner links, accounts and sealed connection tokens stay);
//   2. the graph, through the same import `db:import` uses (src/graph/transfer.ts importDump: labels in order, typed values,
//      vectors, indexes and constraints), which reads the graph back and holds it to the file's digest;
//   3. the registry rows: the Tenant (its demo and showcase flags too) and, under its own id, the Discord area, channels and post
//      records. Not carried, because the export never holds what makes them work: owner links (no hash: issue new ones with
//      `auth:issue`) and Discord invites (no join code);
//   4. the files, each written to a temporary name, checked against its size and hash, then put in place. Only into the
//      business's own folders (a file elsewhere in the export is refused), never a sealed token;
//   5. counts again: the graph's nodes and edges, the registry entry field by field, the Discord rows, every file's size and
//      hash on disk.
// `as` imports it under another id: the graph is named for the new id and the folders too (a path segment that is the old id
// becomes the new one); the Business node inside keeps its id, which the Tenant row's businessId names, and the Discord mapping
// is left out (its channels belong to the old id's area). Connections are not in the file: the operator copies
// <data>/connectors/<id>/ and runs the server with the same ALLEVIA_CONNECTOR_KEY (and COMPOSIO_API_KEY); a sealed token opens
// only under the id it was sealed for (docs/tenant-isolation.md).

export interface ImportTenantOpts extends LifecycleOpts {
  /** Import under this id instead of the one in the file. */
  as?: string;
  /** Overwrite a business that is already here. */
  replace?: boolean;
}

export interface ImportTenantReport {
  slug: string;
  from: string;
  graph: { name: string; nodes: number; edges: number } | null;
  registry: { tenants: number; discordAreas: number; discordChannels: number; discordPosts: number; ownerLinksLeftOut: number; discordLeftOut: number };
  files: number;
  bytes: number;
  replaced: boolean;
  /** What did not match when it was all counted again (empty when everything did). */
  problems: string[];
}

const TENANT_ROOTS = new Set(["assets", "drafts", "onboard", "runs", "snapshots", "studio-demo", "connectors"]);
const SEGMENT = /^[a-z0-9_-]+$/;

// Where a file of the export goes here: under one of the business's own folders (tenantFolders), the old id swapped for the new
// one; undefined for a path anywhere else.
export function importTarget(path: string, from: string, to: string): string | undefined {
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return undefined;
  const swap = (seg: string): string => (seg === from ? to : seg === slugify(from) ? slugify(to) : seg);
  const at = parts[0] === "cache" ? 2 : 1; // cache/<kind>/<id>/..., or <folder>/<id>/...
  if (parts.length <= at + 1) return undefined;
  if (parts[0] === "cache" ? !SEGMENT.test(parts[1]!) : !TENANT_ROOTS.has(parts[0]!)) return undefined;
  const id = swap(parts[at]!);
  if (id !== to && !(parts[0] === "drafts" && id === slugify(to))) return undefined;
  return [...parts.slice(0, at), id, ...parts.slice(at + 1)].join("/");
}

async function readExport(file: string): Promise<{ registry: RegistryRows; dump: GraphDump | null }> {
  let registry: RegistryRows | undefined;
  let header: ExportHeader | undefined;
  let end: EndLine | undefined;
  const nodes: NodeLine[] = [];
  const edges: EdgeLine[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim() || line.startsWith('{"kind":"chunk"')) continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o.kind === "registry") registry = { tenant: o.tenant, tokens: o.tokens, discord: o.discord } as RegistryRows;
    else if (o.kind === "header") header = o as unknown as ExportHeader;
    else if (o.kind === "node") nodes.push(o as unknown as NodeLine);
    else if (o.kind === "edge") edges.push(o as unknown as EdgeLine);
    else if (o.kind === "end") end = o as unknown as EndLine;
  }
  if (!registry) throw new Refused(`${file} has no registry line`);
  return { registry, dump: header && end ? { header, nodes, edges, end } : null };
}

// The registry rows that describe a business here and are replaced with the file's (never owner links, accounts or invites).
const REPLACED_ROWS: Array<{ label: string; key: string }> = [
  { label: "DiscordPost", key: "slug" }, { label: "DiscordChannel", key: "slug" }, { label: "DiscordArea", key: "slug" }, { label: "Tenant", key: "slug" },
];

export async function importTenant(file: string, o: ImportTenantOpts): Promise<ImportTenantReport> {
  const log = o.log ?? (() => undefined);
  if (!existsSync(file)) throw new Refused(`There is no file ${file}.`);
  const check = await verifyTenantExport(file);
  if (!check.ok) throw new Refused(`${file} does not read back whole, so nothing was imported: ${check.problems.join("; ")}`);
  const from = assertTenantSlug(check.slug ?? "");
  const s = assertTenantSlug(o.as ?? from);
  const renamed = s !== from;
  const name = graphName(s);
  for (const p of check.paths) {
    if (isSealed(p)) throw new Refused(`${file} holds a sealed connection token (${p}); an export never does, so nothing was imported.`);
    if (!importTarget(p, from, s)) throw new Refused(`${file} holds a file outside the business's own folders (${p}), so nothing was imported.`);
  }
  const { registry, dump } = await readExport(file);
  if (!registry.tenant) throw new Refused(`${file} has no registry entry for ${from}; an import needs one.`);

  // 1. already here?
  const db = await connect();
  const hasGraph = (await db.list()).includes(name);
  const here = await getTenant(s, o);
  const withFiles = existingFolders(o.dataDir, s).filter((f) => isLink(f) || filesUnder(f).some((p) => !isSealed(p)));
  const replaced = !!(here || hasGraph || withFiles.length);
  if (replaced && !o.replace) {
    const what = [here ? "a registry entry" : "", hasGraph ? "a graph" : "", withFiles.length ? "files" : ""].filter(Boolean).join(", ");
    throw new Refused(`${s} is already on this server (${what}). Nothing was changed. Add --replace to overwrite it with the file.`);
  }
  const meta = await openGraphByName(metaName(o));
  if (replaced) {
    for (const { label, key } of REPLACED_ROWS) {
      try { await meta.query(`MATCH (n:${label} {${key}:$slug}) DETACH DELETE n`, { slug: s }); } catch (e) { if (!missingGraph(e)) throw e; }
    }
    // the files go, except the sealed connection tokens (never in the file: the operator copied them on purpose). A link is unlinked.
    for (const f of existingFolders(o.dataDir, s)) {
      const p = inside(o.dataDir, f);
      if (isLink(p)) { unlinkSync(p); continue; }
      for (const x of filesUnder(p)) if (!isSealed(x)) rmSync(x, { force: true });
    }
    log(`cleared what was here of ${s}`);
  }

  // 2. the graph (importDump drops the one that is here, and reads the new one back against the file)
  let graph: ImportTenantReport["graph"] = null;
  if (dump) {
    const r = await importDump(dump, loadConfig().falkordbUrl, { graph: name, replace: true, log });
    if (!r.verify.ok) throw new Error(`the graph ${name} was written but does not match the file: ${r.verify.problems.slice(0, 3).join("; ")}`);
    graph = { name, nodes: r.nodes, edges: r.edges };
  } else if (hasGraph) {
    await new GraphHandle(name, db.selectGraph(name), db).drop(); // the business had no graph when it was exported
  }

  // 3. the registry rows
  await ensureIndexes(meta, [{ label: "Tenant", prop: "slug", type: "RANGE" }]);
  await meta.query("CREATE (t:Tenant) SET t = $p", { p: { ...registry.tenant, slug: s, graph: name } });
  const discord = renamed ? { area: null, channels: [], posts: [] } : registry.discord;
  if (discord.area) await meta.query("CREATE (n:DiscordArea) SET n = $p", { p: discord.area });
  for (const p of discord.channels) await meta.query("CREATE (n:DiscordChannel) SET n = $p", { p });
  for (const p of discord.posts) await meta.query("CREATE (n:DiscordPost) SET n = $p", { p });
  await linkRegistry(o);
  log("registry rows written");

  // 4. the files: each to a temporary name, checked, then moved into place
  const written = new Map<string, { bytes: number; sha256: string }>();
  let cur: { tmp: string; final: string; bytes: number; sha256: string; hash: ReturnType<typeof createHash>; out: ReturnType<typeof createWriteStream> } | undefined;
  const close = async (): Promise<void> => {
    if (!cur) return;
    const c = cur;
    cur = undefined;
    c.out.end();
    await once(c.out, "finish");
    if (c.hash.digest("hex") !== c.sha256) { rmSync(c.tmp, { force: true }); throw new Error(`${rel(o.dataDir, c.final)}: what was written does not match its hash`); }
    renameSync(c.tmp, c.final);
    written.set(c.final, { bytes: c.bytes, sha256: c.sha256 });
  };
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.startsWith('{"kind":"file"')) {
      await close();
      const f = JSON.parse(line) as { path: string; bytes: number; sha256: string };
      const final = inside(o.dataDir, join(o.dataDir, importTarget(f.path, from, s)!));
      mkdirSync(dirname(final), { recursive: true });
      const tmp = `${final}.import-${process.pid}.tmp`;
      cur = { tmp, final, bytes: f.bytes, sha256: f.sha256, hash: createHash("sha256"), out: createWriteStream(tmp, { mode: 0o600 }) };
    } else if (line.startsWith('{"kind":"chunk"') && cur) {
      const buf = Buffer.from((JSON.parse(line) as { b64: string }).b64, "base64");
      cur.hash.update(buf);
      if (!cur.out.write(buf)) await once(cur.out, "drain");
    } else if (line.startsWith('{"kind":"export-end"')) await close();
  }
  await close();
  log(`${written.size} files written`);

  // 5. counted again
  const problems: string[] = [];
  if (dump) {
    const g = new GraphHandle(name, db.selectGraph(name), db);
    const [n] = await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
    const [e] = await g.roQuery<{ c: number }>("MATCH ()-[r]->() WHERE ID(r) >= 0 RETURN count(r) AS c");
    if (n?.c !== check.nodes || e?.c !== check.edges) problems.push(`the graph has ${n?.c ?? 0} nodes and ${e?.c ?? 0} edges; the file has ${check.nodes} and ${check.edges}`);
  }
  const back = await readRegistryRows(s, o);
  if (!back.tenant) problems.push("the registry entry is missing");
  else {
    for (const [k, v] of Object.entries(registry.tenant)) {
      if (k !== "slug" && k !== "graph" && JSON.stringify(back.tenant[k]) !== JSON.stringify(v)) problems.push(`the registry entry's ${k} differs from the file`);
    }
  }
  if (!!back.discord.area !== !!discord.area || back.discord.channels.length !== discord.channels.length || back.discord.posts.length !== discord.posts.length) {
    problems.push("the Discord mapping's rows do not match the file");
  }
  if (written.size !== check.files) problems.push(`${written.size} files written; the file has ${check.files}`);
  let bytes = 0;
  for (const [p, w] of written) {
    const buf = readFileSync(p);
    bytes += buf.length;
    if (buf.length !== w.bytes || sha256(buf) !== w.sha256) problems.push(`${rel(o.dataDir, p)} does not match the file`);
  }
  const counts = registryCounts(back);
  return {
    slug: s, from, graph, replaced, files: written.size, bytes, problems,
    registry: {
      tenants: counts.tenants, discordAreas: counts.discordAreas, discordChannels: counts.discordChannels, discordPosts: counts.discordPosts,
      ownerLinksLeftOut: registry.tokens.length,
      discordLeftOut: registry.discord.invites.length + (renamed ? (registry.discord.area ? 1 : 0) + registry.discord.channels.length + registry.discord.posts.length : 0),
    },
  };
}
