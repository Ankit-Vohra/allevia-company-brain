// Where Studio media lives: <dataDir>/assets/<tenant>/<storageKey>, outside the repo (data/ is gitignored) and one
// directory per tenant, so a tenant's files can be exported or erased as a folder. Storage keys are content addresses
// (<sha256>.jpg), so storing the same bytes twice is a no-op, and a key can never walk out of its tenant's directory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isTenantSlug } from "../graph/slug.js";

const KEY = /^[0-9a-f]{64}\.(?:jpg|png|webp|mp4|mov|webm|pdf|ttf|otf)$/;

export class AssetStore {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = resolve(dataDir, "assets");
  }

  dir(tenant: string): string {
    if (!isTenantSlug(tenant)) throw new Error(`bad tenant slug ${JSON.stringify(tenant)}`);
    return join(this.root, tenant);
  }

  // The file for a storage key, or null when the key is malformed or would resolve outside the tenant's directory.
  path(tenant: string, key: string): string | null {
    if (!KEY.test(key)) return null;
    const dir = this.dir(tenant);
    const p = resolve(dir, key);
    return p.startsWith(dir + sep) ? p : null;
  }

  put(tenant: string, sha256: string, bytes: Buffer, ext: "jpg" | "png" | "webp" | "mp4" | "mov" | "webm" | "pdf" | "ttf" | "otf" = "jpg"): string {
    const key = `${sha256}.${ext}`;
    const p = this.path(tenant, key);
    if (!p) throw new Error(`bad storage key ${key}`);
    mkdirSync(this.dir(tenant), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, bytes, { mode: 0o600 });
    return key;
  }

  get(tenant: string, key: string): Buffer | null {
    const p = this.path(tenant, key);
    return p && existsSync(p) ? readFileSync(p) : null;
  }
}
