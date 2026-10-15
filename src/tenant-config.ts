// Per-tenant settings the ingestion pipeline (and later the API) needs beyond the graph's Tenant registry: what the
// business is, who its founder is called, which sources `ingest <tenant>` runs and how each is set up. The Tenant node
// in allevia_meta (graph/tenants.ts) is written from this on every ingest, so this file is the source of truth.
// Nothing here is a secret: repo names and the founder's first name are public; tokens live in the env file.
import type { AdsProfile } from "./ingest/sources/simads.js";

export const SOURCE_NAMES = ["brain", "ops", "playbooks", "simads", "github"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];
export const isSourceName = (s: string): s is SourceName => (SOURCE_NAMES as readonly string[]).includes(s);

export interface TenantConfig {
  slug: string;                 // graph allevia_<slug>; lowercase words joined by "_"
  name: string;                 // the Business node's name
  domain?: string;
  industry?: string;            // picks playbook benchmark templates ("jobs", "architecture")
  city?: string;
  country?: string;             // sets currency, locale and time zone defaults (onboard/region.ts)
  description?: string;         // one phrase for the extraction prompt; defaults to `industry`
  founderNames: string[];       // how documents name the founder; extraction resolves these to person:founder
  sources: SourceName[];        // what `ingest <tenant>` runs when --sources is not given
  brainPath?: string;           // the vault clone (read-only); defaults to config.brainPath
  github?: { repos: string[]; founderLogins: string[] }; // issues to read; logins that are the founder
  ads?: { profile: AdsProfile; seed: number; days: number }; // simulated ads
}

export const TENANT_CONFIGS: Readonly<Record<string, TenantConfig>> = {
  aamdani: {
    slug: "aamdani",
    name: "Aamdani",
    domain: "aamdani.ai",
    industry: "jobs",
    city: "Raipur",
    country: "India",
    description: "a Hindi-first, hyperlocal blue-collar jobs marketplace",
    founderNames: ["Ankit", "the founder"],
    sources: ["brain", "ops", "playbooks", "simads", "github"],
    github: { repos: ["Ankit-Vohra/aamdani-brain"], founderLogins: ["Ankit-Vohra"] },
    ads: { profile: "jobs-platform", seed: 2026, days: 28 },
  },
  avs_atelier: {
    slug: "avs_atelier",
    name: "AVS Atelier",
    domain: "avsatelier.in",
    industry: "architecture",
    country: "India",
    description: "an architecture and interior design studio",
    founderNames: ["the founder"],
    sources: ["playbooks", "simads"],
    ads: { profile: "architecture-studio", seed: 2027, days: 28 },
  },
};

export function tenantConfig(slug: string): TenantConfig {
  const c = Object.hasOwn(TENANT_CONFIGS, slug) ? TENANT_CONFIGS[slug] : undefined;
  if (!c) throw new Error(`unknown tenant "${slug}" (configured: ${Object.keys(TENANT_CONFIGS).join(", ")})`);
  return c;
}
