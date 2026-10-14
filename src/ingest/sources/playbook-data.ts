// Vendored playbook packs (vendor/playbooks/<owner>__<repo>/, see NOTICE.md): pack metadata, the shape we expect of
// each data file, and memoised loaders. The files are third-party data, so every read is validated with zod and a pack
// whose data no longer matches fails loudly (the mapper records it as skipped) instead of writing half-understood rules.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { entityId, sha256 } from "../../util/ids.js";

export const VENDOR_DIR = fileURLToPath(new URL("../../../vendor/playbooks/", import.meta.url));

export interface PackFile { file: string; upstream: string; title: string }

export interface Pack {
  owner: string;
  repo: string;
  url: string;
  license: "MIT" | "Apache-2.0";
  sha: string;                 // commit the data was taken from (also in NOTICE.md)
  committedAt: string;         // ISO date of that commit
  title: string;
  summary: string;
  files: PackFile[];
}

export type PackKey = "instagram" | "seo" | "googleUpdates" | "ads" | "voice";

export const PACKS: Record<PackKey, Pack> = {
  instagram: {
    owner: "Jakeschincariol", repo: "instagram-agent-skill", url: "https://github.com/Jakeschincariol/instagram-agent-skill",
    license: "MIT", sha: "d03c56bb598be770c60b201f94237e5d1a4268a6", committedAt: "2026-09-13",
    title: "Instagram Reels hooks and profile rubric",
    summary: "26 Reel hook formulas (with a regex to recognise each) and a 12-item, 100-point Instagram profile rubric.",
    files: [
      { file: "hooks.json", upstream: "skills/ig-reel/hooks.json", title: "Reel hook formulas" },
      { file: "rubric.json", upstream: "skills/ig-profile/rubric.json", title: "Instagram profile rubric" },
    ],
  },
  seo: {
    owner: "every-app", repo: "open-seo", url: "https://github.com/every-app/open-seo",
    license: "MIT", sha: "d7ea7852480601af9bc8870942af8311a410e567", committedAt: "2026-10-14",
    title: "OpenSEO site-audit checks",
    summary: "The site-audit issue registry: what each technical-SEO issue is, how severe, and how to fix it.",
    files: [{ file: "audit-issues.json", upstream: "src/shared/audit-issues.ts", title: "Site-audit issue registry" }],
  },
  googleUpdates: {
    owner: "AgriciDaniel", repo: "claude-seo", url: "https://github.com/AgriciDaniel/claude-seo",
    license: "MIT", sha: "4b99de2f7de7e7d5247042e5fb5b4ea9368ef734", committedAt: "2026-10-04",
    title: "Google Search update timeline",
    summary: "Dated Google Search algorithm, spam, policy and product updates, each citing a Google-owned source.",
    files: [{ file: "google-updates.json", upstream: "data/google-updates.json", title: "Google update timeline" }],
  },
  ads: {
    owner: "nowork-studio", repo: "notfair-plugin", url: "https://github.com/nowork-studio/notfair-plugin",
    license: "MIT", sha: "9afd332f421d58498ddac4fc3b41bbcd66ebe513", committedAt: "2026-10-14",
    title: "NotFair ad benchmarks and policy registry",
    summary: "Industry benchmark presets for Google Ads and versioned Google Ads / Meta Ads policy and behaviour assumptions.",
    files: [
      { file: "industry-templates.json", upstream: "google-ads/shared/industry-templates.json", title: "Google Ads industry templates" },
      { file: "google-ads-policy-registry.json", upstream: "google-ads/shared/policy-registry.json", title: "Google Ads policy registry" },
      { file: "meta-ads-policy-registry.json", upstream: "meta-ads/shared/policy-registry.json", title: "Meta Ads policy registry" },
    ],
  },
  voice: {
    owner: "conorbronsdon", repo: "avoid-ai-writing", url: "https://github.com/conorbronsdon/avoid-ai-writing",
    license: "MIT", sha: "2dc826f7b9aea762f5557e56ba88a3e515bd2fed", committedAt: "2026-10-13",
    title: "Avoid AI writing: voice patterns",
    summary: "Vocabulary tiers, phrase patterns and regex categories that give AI-written text away, with replacements.",
    files: [{ file: "patterns.json", upstream: "detector/patterns.js", title: "AI-writing detection patterns" }],
  },
};

export const packDir = (p: Pack): string => `${p.owner}__${p.repo}`;
export const packPath = (p: Pack, file: string): string => `vendor/playbooks/${packDir(p)}/${file}`;
export const packAsOf = (p: Pack): string => p.committedAt;
export const playbookId = (p: Pack): string => entityId("Playbook", `${p.owner} ${p.repo}`);
export const documentId = (p: Pack, file: string): string => entityId("Document", packPath(p, file));
export const upstreamUrl = (p: Pack, f: PackFile): string => `${p.url}/blob/${p.sha}/${f.upstream}`;

export type RuleKind = "hook" | "profile-check" | "seo-check" | "benchmark" | "policy" | "voice-pattern";
export const ruleId = (kind: RuleKind, key: string): string => entityId("Rule", `${kind} ${key}`);

// ---------- file shapes (only the fields we read; extra keys are ignored) ----------

// Third-party regex strings are only ever compiled after this check: plain flags, and the pattern must compile.
const SAFE_FLAGS = /^[gimsuy]*$/;
export function compiles(source: string, flags: string): boolean {
  if (!SAFE_FLAGS.test(flags)) return false;
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}
const Re = z.object({
  source: z.string(), flags: z.string(),
  gated: z.string().optional(), // upstream reports it only after logic that is not vendored; the linter skips it
}).refine((r) => compiles(r.source, r.flags), { message: "regex does not compile, or uses flags other than gimsuy" });

// URLs read from vendored data end up on graph nodes, so they must be https.
const Https = z.string().startsWith("https://");

const HooksFile = z.object({
  classify_order: z.array(z.number()),
  hooks: z.array(z.object({
    id: z.number(), name: z.string(), template: z.string(), example: z.string(), on_screen: z.string(),
    best_for: z.string(), trap: z.string(),
    match: z.string().refine((m) => compiles(m, "i"), { message: "match is not a valid regex" }),
  })),
});

const RubricFile = z.object({
  total: z.number(),
  items: z.array(z.object({ id: z.string(), points: z.number(), full_marks: z.string(), common_fail: z.string() })),
});

const AuditFile = z.object({
  issues: z.array(z.object({
    type: z.string(), severity: z.enum(["critical", "warning", "info"]), title: z.string(), explanation: z.string(), howToFix: z.string(),
  })),
});

const GoogleUpdatesFile = z.object({
  last_verified: z.string(),
  updates: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string(), kind: z.string(), source: Https, notes: z.string().optional(),
  })),
});

const Range = z.tuple([z.number(), z.number()]);
const TemplateShape = z.object({
  aliases: z.array(z.string()),
  typical_margin: z.number(), aov_range_usd: Range, target_cpa_range_usd: Range, typical_cvr: z.number(),
  smart_bidding_min_conv_month: z.number(), pmax_advisability: z.string(), pmax_note: z.string(),
  recommended_conversion_actions: z.array(z.string()), seasonality_notes: z.string(),
  red_flags: z.array(z.string()), quick_start_negatives: z.array(z.string()),
});
const TemplatesFile = z.object({ templates: z.record(z.string(), TemplateShape) });
export type IndustryTemplate = z.infer<typeof TemplateShape>;

const PolicyFile = z.object({
  last_full_review: z.string(),
  entries: z.array(z.object({
    id: z.string(), category: z.string(), rule: z.string(), volatility: z.string(), last_verified: z.string(),
    source: z.string(), source_url: Https.nullable(), notes: z.string(), stale_after_days: z.number(),
  })),
});

const PatternsFile = z.object({
  tiers: z.object({
    tier1: z.object({
      words: z.record(z.string(), z.string()),
      phrases: z.array(z.object({ pattern: Re, replace: z.string(), clarity: z.boolean().optional(), guard: z.string().optional() })),
    }),
    tier2: z.object({
      words: z.record(z.string(), z.string()),
      conditional: z.array(z.object({ word: z.string(), pattern: Re, suggestion: z.string() })),
    }),
    // tier 3 is density-gated, so voiceLint does not use it; it is still validated like every other vendored regex
    tier3: z.object({ words: z.array(z.string()), phrases: z.array(Re) }),
  }),
  categories: z.record(z.string(), z.object({ severity: z.string(), weight: z.number().nullable(), label: z.string().nullable(), patterns: z.array(Re) })),
});

export type HooksData = z.infer<typeof HooksFile>;
export type PatternsData = z.infer<typeof PatternsFile>;
export type RegexSpec = z.infer<typeof Re>;

export const SCHEMAS = { hooks: HooksFile, googleUpdates: GoogleUpdatesFile, policy: PolicyFile, patterns: PatternsFile };

// classify_order is how hooks are told apart (most specific first), so it must name every hook exactly once and
// nothing else. The mapper reports each problem in `skipped`; classifyHook only walks ids that exist.
export interface HookOrderIssues { unknownIds: number[]; missing: Array<{ id: number; name: string }>; duplicateIds: number[] }
export function checkHookOrder(h: HooksData): HookOrderIssues {
  const known = new Set(h.hooks.map((x) => x.id));
  const listed = new Set(h.classify_order);
  const seen = new Set<number>();
  const duplicateIds = h.classify_order.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  return {
    unknownIds: h.classify_order.filter((id) => !known.has(id)),
    missing: h.hooks.filter((x) => !listed.has(x.id)).map((x) => ({ id: x.id, name: x.name })),
    duplicateIds: [...new Set(duplicateIds)],
  };
}

// ---------- loading ----------

export interface VendoredFile<T> { path: string; hash: string; data: T }

const cache = new Map<string, VendoredFile<unknown>>();

function load<T>(pack: Pack, file: string, schema: z.ZodType<T>): VendoredFile<T> {
  const path = packPath(pack, file);
  const hit = cache.get(path);
  if (hit) return hit as VendoredFile<T>;
  const text = readFileSync(`${VENDOR_DIR}${packDir(pack)}/${file}`, "utf8");
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path}: unexpected shape (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message})`);
  const out = { path, hash: sha256(text), data: parsed.data };
  cache.set(path, out);
  return out;
}

export const loadHooks = () => load(PACKS.instagram, "hooks.json", HooksFile);
export const loadRubric = () => load(PACKS.instagram, "rubric.json", RubricFile);
export const loadAuditIssues = () => load(PACKS.seo, "audit-issues.json", AuditFile);
export const loadGoogleUpdates = () => load(PACKS.googleUpdates, "google-updates.json", GoogleUpdatesFile);
export const loadIndustryTemplates = () => load(PACKS.ads, "industry-templates.json", TemplatesFile);
export const loadGoogleAdsPolicy = () => load(PACKS.ads, "google-ads-policy-registry.json", PolicyFile);
export const loadMetaAdsPolicy = () => load(PACKS.ads, "meta-ads-policy-registry.json", PolicyFile);
export const loadPatterns = () => load(PACKS.voice, "patterns.json", PatternsFile);
