// Where a connector's tokens live: one sealed file per tenant and connector under <dataDir>/connectors/<tenant>/, mode 0600,
// written atomically. Never the graph (it is projected, searched and shown to agents), never a log, never an env file.
// The interface is small so a database or a secrets manager can replace the files without touching the connector.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { open, seal } from "./crypto.js";

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;       // epoch ms the access token stops working
  scope: string;           // what Google says was granted
  obtainedAt: number;
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

export class FileTokenStore implements TokenStore {
  constructor(private dir: string, private key: string) {}

  private path(tenant: string, connector: string): { dir: string; file: string } {
    const d = join(this.dir, "connectors", safe("tenant", tenant));
    return { dir: d, file: join(d, `${safe("connector", connector)}.sealed`) };
  }

  async get(tenant: string, connector: string): Promise<TokenRecord | null> {
    const { file } = this.path(tenant, connector);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return open<TokenRecord>(this.key, tenant, connector, raw);
  }

  async put(tenant: string, connector: string, tokens: TokenRecord): Promise<void> {
    const { dir, file } = this.path(tenant, connector);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, seal(this.key, tenant, connector, tokens), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }

  async delete(tenant: string, connector: string): Promise<void> {
    await rm(this.path(tenant, connector).file, { force: true });
  }
}
