// The audit log: every call a connection makes for a business, one line each, per business. It records who or what asked
// (the tool or page), which connection, what it did, whether it worked and how long it took, and nothing secret: no token,
// no email body, no query text. `detail` is clipped and scrubbed of anything that looks like a credential.
// Files are <dataDir>/connectors/<tenant>/audit.jsonl (a business's log sits next to its sealed records and nowhere else),
// and a log past MAX_BYTES is cut to its newest half so it cannot grow without end.
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AuditEntry {
  at: number;
  tenant: string;
  connector: string;
  op: string;
  ok: boolean;
  ms?: number;
  detail?: string;
  actor?: string;     // "owner", or the roster id of the agent
}

export interface AuditLog {
  append(e: AuditEntry): Promise<void>;
  /** This business's newest entries first. */
  recent(tenant: string, o?: { limit?: number; connector?: string }): Promise<AuditEntry[]>;
}

const MAX_BYTES = 1_000_000;
const SAFE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/** Clips and scrubs free text before it is logged: long token-like runs, bearer headers, key=value secrets and emails. */
export function scrub(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [removed]")
    .replace(/\b(access_token|refresh_token|client_secret|api_key|apikey|key|secret|token|code)=[^\s&"']+/gi, "$1=[removed]")
    .replace(/[A-Za-z0-9_\-./+=]{28,}/g, "[removed]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\s+/g, " ").trim().slice(0, 200);
}

const clean = (e: AuditEntry): AuditEntry => ({
  at: e.at, tenant: e.tenant, connector: e.connector, op: e.op.slice(0, 60), ok: e.ok,
  ...(e.ms !== undefined ? { ms: Math.round(e.ms) } : {}), ...(e.detail ? { detail: scrub(e.detail) } : {}), ...(e.actor ? { actor: e.actor.slice(0, 60) } : {}),
});

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async append(e: AuditEntry): Promise<void> { this.entries.push(clean(e)); }
  async recent(tenant: string, o: { limit?: number; connector?: string } = {}): Promise<AuditEntry[]> {
    return this.entries.filter((e) => e.tenant === tenant && (!o.connector || e.connector === o.connector)).slice().reverse().slice(0, o.limit ?? 50);
  }
}

export class FileAuditLog implements AuditLog {
  constructor(private dir: string) {}

  private file(tenant: string): { dir: string; file: string } {
    if (!SAFE.test(tenant)) throw new Error("Not a valid tenant name.");
    const d = join(this.dir, "connectors", tenant);
    return { dir: d, file: join(d, "audit.jsonl") };
  }

  async append(e: AuditEntry): Promise<void> {
    const { dir, file } = this.file(e.tenant);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify(clean(e))}\n`, { mode: 0o600 });
    try {
      if ((await stat(file)).size > MAX_BYTES) {
        const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
        await writeFile(file, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
      }
    } catch {
      // trimming is housekeeping; the entry is written
    }
  }

  async recent(tenant: string, o: { limit?: number; connector?: string } = {}): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(tenant).file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: AuditEntry[] = [];
    for (const line of raw.split("\n").reverse()) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (e.tenant !== tenant || (o.connector && e.connector !== o.connector)) continue;
        out.push(e);
        if (out.length >= (o.limit ?? 50)) break;
      } catch {
        // a half-written line is skipped
      }
    }
    return out;
  }
}
