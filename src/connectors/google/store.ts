// Where a connector's secrets live: one sealed file per tenant and connector under <dataDir>/connectors/<tenant>/, mode 0600,
// written atomically. Never the graph (it is projected, searched and shown to agents), never a log, never an env file.
// The interface is small so a database or a secrets manager can replace the files without touching the connector.
//
// Keys and rotation: `key` is the current ALLEVIA_CONNECTOR_KEY; `previous` are older keys (ALLEVIA_CONNECTOR_KEY_PREVIOUS,
// comma-separated) that can still open what they sealed. A record opened with an older key is sealed again with the current
// one on the spot, and `rotate` / `rotateAll` do the same for every record, so the old key can be dropped from the env file.
// Revocation: `delete` forgets one connection, `deleteTenant` forgets every connection a business has (crypto-shredding).
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SealError, open, seal } from "./crypto.js";

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;       // epoch ms the access token stops working
  scope: string;           // what Google says was granted
  obtainedAt: number;
  meta?: Record<string, string>; // what the owner picked or the connector learned (a GA4 property, an Ads customer): not secret, kept with the grant
}

export interface TokenStore {
  get(tenant: string, connector: string): Promise<TokenRecord | null>;
  put(tenant: string, connector: string, tokens: TokenRecord): Promise<void>;
  delete(tenant: string, connector: string): Promise<void>;
}

const SAFE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const safe = (what: string, v: string): string => {
  if (!SAFE.test(v)) throw new Error(`Not a valid ${what} name: ${JSON.stringify(v.slice(0, 40))}`);
  return v;
};

// Any JSON value, sealed per tenant and name. FileTokenStore is this with the Google token shape.
export class SealedVault<T = unknown> {
  private keys: string[];
  constructor(private dir: string, key: string, previous: readonly string[] = []) {
    this.keys = [key, ...previous.filter((k) => k && k !== key)];
  }

  private path(tenant: string, name: string): { dir: string; file: string } {
    const d = join(this.dir, "connectors", safe("tenant", tenant));
    return { dir: d, file: join(d, `${safe("connector", name)}.sealed`) };
  }

  private async read(tenant: string, name: string): Promise<{ value: T; usedKey: number } | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(tenant, name).file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let last: unknown;
    for (let i = 0; i < this.keys.length; i++) {
      try {
        return { value: open<T>(this.keys[i]!, tenant, name, raw), usedKey: i };
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof SealError ? last : new SealError("The stored connection could not be opened. Connect it again.");
  }

  async get(tenant: string, name: string): Promise<T | null> {
    const r = await this.read(tenant, name);
    if (!r) return null;
    if (r.usedKey > 0) await this.put(tenant, name, r.value).catch(() => undefined); // sealed with an older key: seal it with the current one
    return r.value;
  }

  async put(tenant: string, name: string, value: T): Promise<void> {
    const { dir, file } = this.path(tenant, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, seal(this.keys[0]!, tenant, name, value), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }

  async delete(tenant: string, name: string): Promise<void> {
    await rm(this.path(tenant, name).file, { force: true });
  }

  /** The names this business has something sealed under. */
  async list(tenant: string): Promise<string[]> {
    try {
      return (await readdir(this.path(tenant, "x").dir)).filter((f) => f.endsWith(".sealed")).map((f) => f.slice(0, -".sealed".length)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  /** Forget everything this business has stored (revocation, or deleting the business). */
  async deleteTenant(tenant: string): Promise<void> {
    for (const n of await this.list(tenant)) await this.delete(tenant, n);
  }

  /** Seal every record of one business with the current key. Returns how many were sealed again and which could not be opened. */
  async rotate(tenant: string): Promise<{ rotated: number; unreadable: string[] }> {
    let rotated = 0;
    const unreadable: string[] = [];
    for (const n of await this.list(tenant)) {
      try {
        const r = await this.read(tenant, n);
        if (!r) continue;
        await this.put(tenant, n, r.value);
        rotated++;
      } catch {
        unreadable.push(n);
      }
    }
    return { rotated, unreadable };
  }

  async tenants(): Promise<string[]> {
    try {
      return (await readdir(join(this.dir, "connectors"), { withFileTypes: true })).filter((d) => d.isDirectory() && SAFE.test(d.name)).map((d) => d.name).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async rotateAll(): Promise<{ rotated: number; unreadable: string[] }> {
    let rotated = 0;
    const unreadable: string[] = [];
    for (const t of await this.tenants()) {
      const r = await this.rotate(t);
      rotated += r.rotated;
      unreadable.push(...r.unreadable.map((n) => `${t}/${n}`));
    }
    return { rotated, unreadable };
  }
}

export class FileTokenStore extends SealedVault<TokenRecord> implements TokenStore {}
