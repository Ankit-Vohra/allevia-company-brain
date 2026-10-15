// The brain source (spec §6.2): the founder's vault, read from its local clone exactly as it is. READ-ONLY: this module
// only lists and reads files and runs `git rev-parse` / `git log` (with GIT_OPTIONAL_LOCKS=0, so git never touches the
// index). It never pulls, writes or checks anything out.
//
// What it emits, all through the privacy filter (path policy → sensitive sections dropped → redaction):
//   Document  one per allowed markdown file; kind from its folder; asOf = the file's last commit date
//   Chunk     ~800-character passages, Document -HAS_CHUNK-> Chunk
//   LINKS_TO  Document -> Document for wiki-links that resolve to another allowed file
//   AUTHORED  Person/Agent -> Document from `git log --follow` per file: a subject `agent:<name>:` is that agent's,
//             anything else the founder's; Allevia's reserved namespace (agent:allevia-*) is credited to nobody
//   PENDING   Tasks and OWNS (pending.ts); ADRs -> Decisions (adr.ts); registry YAML -> Agent/Team/System (registry.ts)
// `docs` are the extraction candidates: every markdown Document except PENDING (already deterministic); the registry
// YAML never goes to the LLM.
//
// Vault text is untrusted data: it is parsed, never followed. Symlinks are not followed (one could point outside the
// vault), and files over MAX_FILE_BYTES are skipped.
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EdgeInput, NodeInput } from "../../graph/upsert.js";
import { entityId, sha256, slugify } from "../../util/ids.js";
import { dropSensitiveSections, pathAllowed, redact } from "../privacy.js";
import { parseMarkdown } from "../markdown.js";
import { FOUNDER_ID, founderNode, isReservedId } from "../actors.js";
import { Semaphore } from "../llm.js";
import type { RawDoc, SourceResult } from "../types.js";
import { parsePending, pendingToWrite } from "./pending.js";
import { adrDecisionId, adrIdIndex, adrToWrite, isAdrPath, parseAdr, type Adr } from "./adr.js";
import { mapRegistry } from "./registry.js";

const execFileP = promisify(execFile);

export const MAX_FILE_BYTES = 2_000_000;
export const PENDING_PATH = "00-command/PENDING.md";
const GIT_LOG_FORMAT = "%H|%an|%aI|%s";
const SUMMARY_CHARS = 280;

export type DocKind = RawDoc["kind"];

export interface BrainOptions {
  vaultPath: string;
  gitConcurrency?: number;   // parallel `git log` calls (default 8)
}

export interface BrainStats {
  files: number; allowed: number; documents: number; chunks: number; links: number; authored: number;
  registryFiles: number; droppedSections: number; commitsIgnored: number;
}

export interface BrainResult extends SourceResult {
  vaultHead?: string;        // the clone's HEAD commit (full sha), recorded in the run report
  stats: BrainStats;
}

export const brainDocId = (path: string): string => entityId("Document", path);

// Chunk ids stay short and unique whatever the path length: a readable prefix, a hash of the path, the ordinal.
export const chunkId = (path: string, ord: number): string =>
  entityId("Chunk", `${slugify(path).slice(0, 56)}-${sha256(path).slice(0, 8)}-${ord}`);

export function docKind(path: string): DocKind {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^readme\.md$/i.test(base) || path === "CLAUDE.md") return "readme";
  if (path === PENDING_PATH) return "pending";
  if (path.startsWith("60-decisions/")) return "decision";
  if (path.startsWith("70-reports/")) return "report";
  if (path.startsWith("agents/")) return "agent";
  return "note";
}

// ---------- git ----------

export interface CommitLine { sha: string; at: string; subject: string }

// `%H|%an|%aI|%s` lines. The author name is read past and never kept (the subject decides who gets credit); it may
// itself contain "|", so the date is found by its shape.
const LOG_LINE = /^([0-9a-f]{7,64})\|(?:.*?)\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2}))\|(.*)$/;

export function parseGitLog(out: string): CommitLine[] {
  const commits: CommitLine[] = [];
  for (const line of out.split("\n")) {
    const m = LOG_LINE.exec(line);
    if (!m || !Number.isFinite(Date.parse(m[2]!))) continue;
    commits.push({ sha: m[1]!, at: m[2]!, subject: m[3]! });
  }
  return commits;
}

// `agent:<name>: …` → that agent; anything else → the founder; Allevia's reserved namespace → nobody (null).
export function actorFromSubject(subject: string): { id: string; name: string } | null {
  const m = /^agent:([A-Za-z0-9][\w.-]{0,60}):/.exec(subject.trim());
  if (!m) return { id: FOUNDER_ID, name: "founder" };
  const name = m[1]!.toLowerCase();
  const id = entityId("Agent", name);
  return isReservedId(id) ? null : { id, name };
}

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };

async function git(vault: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", vault, "-c", "core.quotepath=off", ...args], { env: GIT_ENV, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function vaultHead(vault: string): Promise<string | undefined> {
  try {
    const sha = (await git(vault, ["rev-parse", "HEAD"])).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined; // not a git repo (or no commits yet): no authorship, asOf from file times
  }
}

// ---------- files ----------

interface VaultFile { path: string; abs: string }

function walk(vault: string, skipped: SourceResult["skipped"]): VaultFile[] {
  const out: VaultFile[] = [];
  const visit = (rel: string) => {
    const abs = rel ? join(vault, rel) : vault;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.name === ".git" && !rel) continue;
      if (ent.isSymbolicLink()) { skipped.push({ ref: p, reason: "symlink (not followed)" }); continue; }
      if (ent.isDirectory()) visit(p);
      else if (ent.isFile()) out.push({ path: p, abs: join(abs, ent.name) });
    }
  };
  visit("");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const day = (iso: string): string => iso.slice(0, 10);

// Plain words for a summary: wiki-links become their alias or file name, markdown marks go.
function plain(s: string): string {
  return s
    .replace(/\[\[([^\]|]{0,200})\|([^\]]{0,200})\]\]/g, "$2")
    .replace(/\[\[([^\]]{0,200})\]\]/g, (_m, t: string) => t.split("#")[0]!.split("/").pop() ?? t)
    .replace(/\[([^\]]{1,200})\]\([^)]{0,300}\)/g, "$1")
    .replace(/~~|\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summaryOf(sections: Array<{ heading: string; text: string }>): string | undefined {
  for (const s of sections) {
    const para = s.text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^[|>#-]/.test(p) && !p.startsWith("```"));
    if (!para) continue;
    const t = plain(para);
    if (t) return t.length > SUMMARY_CHARS ? `${t.slice(0, SUMMARY_CHARS - 1).replace(/\s+\S*$/, "")}…` : t;
  }
  return undefined;
}

// ---------- entry point ----------

interface Authorship { actor: { id: string; name: string }; commits: number; firstAt: string; lastAt: string }

export async function loadBrain(opts: BrainOptions): Promise<BrainResult> {
  const vault = opts.vaultPath;
  const skipped: SourceResult["skipped"] = [];
  const redactions: Record<string, number> = {};
  const addCounts = (c: Record<string, number>) => { for (const [k, n] of Object.entries(c)) redactions[k] = (redactions[k] ?? 0) + n; };
  const stats: BrainStats = { files: 0, allowed: 0, documents: 0, chunks: 0, links: 0, authored: 0, registryFiles: 0, droppedSections: 0, commitsIgnored: 0 };

  // 1. which files may be read at all
  const files = walk(vault, skipped);
  stats.files = files.length;
  const allowed: VaultFile[] = [];
  for (const f of files) {
    const v = pathAllowed(f.path);
    if (!v.allowed) { skipped.push({ ref: f.path, reason: v.reason }); continue; }
    if (!/\.md$/i.test(f.path) && !(f.path.startsWith("registry/") && /\.ya?ml$/i.test(f.path))) {
      skipped.push({ ref: f.path, reason: "not markdown or registry yaml" });
      continue;
    }
    const size = lstatSync(f.abs).size;
    if (size > MAX_FILE_BYTES) { skipped.push({ ref: f.path, reason: `too large (${size} bytes)` }); continue; }
    allowed.push(f);
  }
  stats.allowed = allowed.length;

  // 2. history: one `git log --follow` per allowed file (newest first)
  const head = await vaultHead(vault);
  const history = new Map<string, CommitLine[]>();
  if (head) {
    const sem = new Semaphore(opts.gitConcurrency ?? 8);
    await Promise.all(allowed.map((f) => sem.run(async () => {
      try {
        history.set(f.path, parseGitLog(await git(vault, ["log", `--format=${GIT_LOG_FORMAT}`, "--follow", "--", f.path])));
      } catch (e) {
        skipped.push({ ref: f.path, reason: `git log failed: ${(e as Error).message.slice(0, 120)}` });
      }
    })));
  }
  const asOfOf = (f: VaultFile): string => {
    const last = history.get(f.path)?.[0];
    return last ? day(last.at) : new Date(lstatSync(f.abs).mtimeMs).toISOString().slice(0, 10); // untracked: file time
  };

  // Nodes deduplicated by id; the first writer wins (registry first, so a registry agent keeps its own name and summary).
  const nodes = new Map<string, NodeInput>();
  const put = (n: NodeInput) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const edges: EdgeInput[] = [];

  // 3. registry YAML (deterministic; its own Documents)
  const registryFiles = allowed.filter((f) => f.path.startsWith("registry/") && /\.ya?ml$/i.test(f.path));
  stats.registryFiles = registryFiles.length;
  const registryAsOf = registryFiles.map(asOfOf).sort().at(-1) ?? new Date().toISOString().slice(0, 10);
  const registry = mapRegistry(registryFiles.map((f) => ({ path: f.path, text: readFileSync(f.abs, "utf8") })), { asOf: registryAsOf });
  for (const n of registry.write.nodes) put(n);
  edges.push(...registry.write.edges);
  skipped.push(...registry.skipped);
  addCounts(registry.redactions);
  const registryAgents = new Set(registry.write.nodes.filter((n) => n.type === "Agent").map((n) => n.id));
  const documentIds = new Set(registry.write.nodes.filter((n) => n.type === "Document").map((n) => n.id));

  // 4. markdown: filter, parse, Documents, Chunks
  const mdFiles = allowed.filter((f) => /\.md$/i.test(f.path));
  const linkable = [...mdFiles.map((f) => f.path), ...registryFiles.map((f) => f.path)];
  const docs: RawDoc[] = [];
  const links: Array<{ from: string; to: string; asOf: string }> = [];
  const adrs: Array<{ adr: Adr; docId: string; asOf: string }> = [];
  let pending: { text: string; docId: string; asOf: string } | undefined;

  for (const f of mdFiles) {
    const raw = readFileSync(f.abs, "utf8");
    const cut = dropSensitiveSections(raw);
    stats.droppedSections += cut.dropped.length;
    const red = redact(cut.text);
    addCounts(red.counts);
    const text = red.text;
    const parsed = parseMarkdown(f.path, text, linkable);
    const id = brainDocId(f.path);
    const kind = docKind(f.path);
    const asOf = asOfOf(f);
    const base = f.path.slice(f.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    const reportDate = kind === "report" ? /(\d{4}-\d{2}-\d{2})/.exec(base)?.[1] : undefined;
    const hash = sha256(text);
    const props: NodeInput["props"] = { kind, path: f.path, title: parsed.title, hash, chunkCount: parsed.chunks.length };
    if (reportDate) props.reportDate = reportDate;
    put({
      type: "Document", id, name: parsed.title === base ? f.path : parsed.title,
      ...(summaryOf(parsed.sections) ? { summary: summaryOf(parsed.sections) } : {}), props, asOf,
    });
    documentIds.add(id);
    stats.documents++;

    for (const c of parsed.chunks) {
      const cid = chunkId(f.path, c.ord);
      put({
        type: "Chunk", id: cid, name: `${parsed.title} (${c.ord + 1}/${parsed.chunks.length})`,
        props: { text: c.text, ord: c.ord, heading: c.heading, path: f.path }, src: id, asOf,
      });
      edges.push({ from: id, type: "HAS_CHUNK", to: cid, src: id, asOf });
      stats.chunks++;
    }
    for (const l of parsed.wikilinks) {
      if (l.resolved && l.resolved !== f.path) links.push({ from: id, to: brainDocId(l.resolved), asOf });
    }

    if (kind === "pending") { pending = { text, docId: id, asOf }; continue; }
    const meta: NonNullable<RawDoc["meta"]> = { commits: history.get(f.path)?.length ?? 0 };
    let docAsOf = reportDate ?? asOf;
    if (kind === "decision" && isAdrPath(f.path)) {
      try {
        const adr = parseAdr(f.path, text);
        adrs.push({ adr, docId: id, asOf });
        meta.decisionId = adrDecisionId(adr);
        meta.decisionName = adr.number ? `ADR ${adr.number}: ${adr.title}` : adr.title;
        if (adr.date) docAsOf = adr.date;
      } catch (e) {
        skipped.push({ ref: f.path, reason: `ADR not parsed: ${(e as Error).message.slice(0, 120)}` });
      }
    }
    docs.push({ id, kind, title: parsed.title, path: f.path, text, asOf: docAsOf, hash, meta });
  }

  // 5. LINKS_TO between allowed documents (deduplicated), and in-link counts for extraction priority
  const seenLinks = new Set<string>();
  const inLinks = new Map<string, number>();
  for (const l of links) {
    const key = `${l.from}|${l.to}`;
    if (seenLinks.has(key) || !documentIds.has(l.to) || l.from === l.to) continue;
    seenLinks.add(key);
    edges.push({ from: l.from, type: "LINKS_TO", to: l.to, src: l.from, asOf: l.asOf });
    inLinks.set(l.to, (inLinks.get(l.to) ?? 0) + 1);
    stats.links++;
  }
  for (const d of docs) d.meta = { ...d.meta, inLinks: inLinks.get(d.id) ?? 0 };

  // 6. ADRs and PENDING
  const adrIds = adrIdIndex(adrs.map((a) => a.adr));
  for (const a of adrs) {
    const w = adrToWrite(a.adr, { docId: a.docId, asOf: a.asOf, adrIds });
    for (const n of w.nodes) put(n);
    edges.push(...w.edges);
  }
  if (pending) {
    const w = pendingToWrite(parsePending(pending.text), { docId: pending.docId, asOf: pending.asOf });
    for (const n of w.nodes) put(n);
    edges.push(...w.edges);
  }

  // 7. AUTHORED from the history of every allowed file
  for (const f of allowed) {
    const commits = history.get(f.path);
    if (!commits?.length) continue;
    const docId = brainDocId(f.path);
    if (!documentIds.has(docId)) continue;
    const by = new Map<string, Authorship>();
    for (const c of commits) {
      const actor = actorFromSubject(c.subject);
      if (!actor) { stats.commitsIgnored++; continue; }
      const a = by.get(actor.id);
      if (!a) by.set(actor.id, { actor, commits: 1, firstAt: c.at, lastAt: c.at });
      else {
        a.commits++;
        if (Date.parse(c.at) < Date.parse(a.firstAt)) a.firstAt = c.at;
        if (Date.parse(c.at) > Date.parse(a.lastAt)) a.lastAt = c.at;
      }
    }
    for (const a of by.values()) {
      if (a.actor.id === FOUNDER_ID) put(founderNode());
      else if (!registryAgents.has(a.actor.id)) {
        put({
          type: "Agent", id: a.actor.id, name: a.actor.name, summary: `Commits to the vault as agent:${a.actor.name}.`,
          props: { kind: "vault-committer" },
        });
      }
      edges.push({
        from: a.actor.id, type: "AUTHORED", to: docId, since: Date.parse(a.firstAt),
        props: { at: a.lastAt, firstAt: a.firstAt, commits: a.commits }, src: docId, asOf: asOfOf(f),
      });
      stats.authored++;
    }
  }

  if (stats.droppedSections) redactions.dropped_section = (redactions.dropped_section ?? 0) + stats.droppedSections;
  return {
    source: "brain", docs, write: { nodes: [...nodes.values()], edges, observations: [] }, skipped, redactions, stats,
    ...(head ? { vaultHead: head } : {}),
  };
}
