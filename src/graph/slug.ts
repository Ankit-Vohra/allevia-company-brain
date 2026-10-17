// The one definition of a tenant slug. Every graph name, folder and file name Allevia builds from a tenant comes from a
// slug that passed isTenantSlug, never from raw input (graphName in client.ts, the asset store, the API's route guard,
// onboarding). A slug is lowercase ASCII words joined by single underscores, at most MAX_SLUG_LENGTH long, and not one
// of the reserved names below.
//
// Why each rule: "__" is the projection-graph separator (`<graph>__cur_…`), so no real graph may contain it; lower-case
// ASCII only means no look-alike letters, no path separators, no quotes and no control characters can get in;
// RESERVED_SLUGS keep a tenant from taking the name of something else: `meta` would make graphName("meta") the registry
// graph `allevia_meta` itself, and the others are API path words (/api/health, /api/tenants, …) or token scopes.

export const MAX_SLUG_LENGTH = 40;
export const TENANT_SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export const RESERVED_SLUGS: readonly string[] = [
  "meta",      // allevia_meta is the tenant registry
  "reference", // allevia_reference is the shared general know-how (src/graph/reference.ts)
  "operator",  // the scope of an operator token (src/auth/tokens.ts)
  "health", "tenants", "plans", "onboard", "auth", "admin", "api", "connectors", // first path segments under /api (connectors: Google's redirect back)
];

export function isTenantSlug(s: unknown): boolean {
  return typeof s === "string" && s.length <= MAX_SLUG_LENGTH && TENANT_SLUG.test(s) && !RESERVED_SLUGS.includes(s);
}

// Throws unless `s` is a tenant slug; returns it.
export function assertTenantSlug(s: unknown): string {
  if (!isTenantSlug(s)) {
    throw new Error(`tenant slug must be lowercase words joined by single "_" (at most ${MAX_SLUG_LENGTH} characters, not a reserved name), got ${JSON.stringify(s)}`);
  }
  return s as string;
}
