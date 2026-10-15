// Where a business's cached model answers live: <dataDir>/cache/<kind>/<tenant>/. Every cache is content-keyed, and the
// key already carries the business context, so two businesses never share an entry unless their text AND context are
// identical; one folder per business means that even then they do not meet (docs/tenant-isolation.md).
// Earlier versions kept one folder per kind for everybody (<dataDir>/cache/<kind>/). The founder's own businesses read it
// once, as a fallback, and copy what they use into their own folder, so their cached extractions are not paid for twice;
// any other business never reads it.
import { join } from "node:path";
import { assertTenantSlug } from "../graph/slug.js";
import { TENANT_CONFIGS } from "../tenant-config.js";

export type CacheKind = "extract" | "onboard" | "studio";

export function tenantCacheDir(dataDir: string, kind: CacheKind, tenant: string): string {
  return join(dataDir, "cache", kind, assertTenantSlug(tenant));
}

// The shared folder of earlier versions, for a business that may still read it (the founder's own), else undefined.
export function legacyCacheDir(dataDir: string, kind: CacheKind, tenant: string): string | undefined {
  return Object.hasOwn(TENANT_CONFIGS, tenant) ? join(dataDir, "cache", kind) : undefined;
}
