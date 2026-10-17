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
//
// The file is JSON lines, one object a line:
//   {"kind":"tenant-export", ...}     first: format, version, the business id, when
//   {"kind":"registry", ...}          the registry rows
//   header / node / edge / end        the graph, exactly as `db:export` writes it (src/graph/transfer.ts); or {"kind":"graph-missing"}
//   {"kind":"file", path, bytes, sha256, chunks}  then `chunks` lines {"kind":"chunk", path, n, b64}, for each file
//   {"kind":"export-end", files, bytes}          last: a file without it did not finish
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, appendFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GraphHandle, connect, graphName, openGraphByName } from "../graph/client.js";
import { assertTenantSlug } from "../graph/slug.js";
import { getTenant, metaName, type TenantOpts } from "../graph/tenants.js";
import { readGraph, summarize, type EdgeLine, type ExportHeader, type NodeLine } from "../graph/transfer.js";
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
