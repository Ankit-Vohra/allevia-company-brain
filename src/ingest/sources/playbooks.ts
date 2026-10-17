// Playbooks source (spec §6.2, §13): maps the vendored open-source playbook data (vendor/playbooks, MIT) into the
// graph as procedural memory. A deterministic mapper: no LLM, no network, nothing from the upstream repos is executed.
//   Playbook (one per pack) -INCLUDES-> Rule (hook / profile-check / seo-check / benchmark / policy / voice-pattern)
//   Rule|Playbook -APPLIES_TO-> Channel,  Event (Google updates) -AFFECTS-> channel:google-search,
//   everything -SOURCED_FROM-> the vendored Document it came from.
// Also exports the two checkers built on the same data: classifyHook and voiceLint.
import type { EdgeInput, NodeInput, Prim } from "../../graph/upsert.js";
import type { RelType } from "../../graph/schema.js";
import type { SourceResult } from "../types.js";
import { entityId } from "../../util/ids.js";
import { channelId, channelNode, type ChannelKey } from "./channels.js";
import { matchIndustry, JOB_NEGATIVES } from "./playbook-industry.js";
import {
  PACKS, checkHookOrder, documentId, loadAuditIssues, loadGoogleAdsPolicy, loadGoogleUpdates, loadHooks, loadIndustryTemplates,
  loadMetaAdsPolicy, loadPatterns, loadRubric, packAsOf, packPath, playbookId, ruleId, upstreamUrl,
  type IndustryTemplate, type Pack, type RuleKind,
} from "./playbook-data.js";

export { classifyHook, voiceLint, type VoiceFinding } from "./playbook-lint.js";

export interface PlaybooksOptions {
  tenantSlug: string;   // playbooks are the same for every tenant; kept so all sources share one call shape
  industry?: string;    // picks the industry benchmark templates ("jobs", "architecture", "real estate"…)
  // Every industry's benchmark template in its neutral wording (no "closest template for" note, no jobs-only negative
  // keywords): what the shared reference graph holds (src/ingest/sources/reference.ts). `industry` is ignored with it.
  allIndustries?: boolean;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const compact = (o: Record<string, Prim | undefined>): Record<string, Prim> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, Prim>;
const words = (id: string): string => id.replace(/[_-]+/g, " ");

// Collects the nodes and edges of one pack; merged into the result only when the whole pack mapped cleanly.
class PackBuilder {
  nodes: NodeInput[] = [];
  edges: EdgeInput[] = [];
  skipped: SourceResult["skipped"] = []; // things inside a pack that could not be used; the pack itself still maps
  readonly asOf: string;
  readonly playbook: string;
  private channels = new Set<ChannelKey>();

  constructor(readonly pack: Pack) {
    this.asOf = packAsOf(pack);
    this.playbook = playbookId(pack);
    this.nodes.push({
      type: "Playbook", id: this.playbook, name: pack.title, summary: pack.summary, asOf: this.asOf,
      props: { source: pack.url, license: pack.license, sha: pack.sha, repo: `${pack.owner}/${pack.repo}` },
    });
  }

  edge(type: RelType, from: string, to: string, src?: string): void {
    this.edges.push({ from, type, to, src, asOf: this.asOf });
  }

  // Channel nodes are bare anchors (name + platform): other sources own their status and provenance.
  channel(key: ChannelKey): string {
    if (!this.channels.has(key)) {
      this.channels.add(key);
      this.nodes.push(channelNode(key));
    }
    return channelId(key);
  }

  doc(file: string, hash: string): string {
    const f = this.pack.files.find((x) => x.file === file);
    if (!f) throw new Error(`${this.pack.repo}: ${file} is not a declared pack file`);
    const id = documentId(this.pack, file);
    this.nodes.push({
      type: "Document", id, name: `${f.title} (${this.pack.owner}/${this.pack.repo})`, asOf: this.asOf,
      summary: `Vendored from ${this.pack.url} at ${this.pack.sha.slice(0, 7)} (${this.pack.license}), converted as described in vendor/playbooks/NOTICE.md.`,
      props: { kind: "playbook", title: f.title, path: packPath(this.pack, file), url: upstreamUrl(this.pack, f), hash },
    });
    this.edge("SOURCED_FROM", this.playbook, id, id);
    return id;
  }

  appliesTo(channels: ChannelKey[]): void {
    for (const c of channels) this.edge("APPLIES_TO", this.playbook, this.channel(c));
  }

  rule(kind: RuleKind, key: string, name: string, text: string, doc: string, channels: ChannelKey[], props: Record<string, Prim | undefined> = {}): string {
    const id = ruleId(kind, key);
    this.nodes.push({ type: "Rule", id, name, summary: clip(text, 300), src: doc, asOf: this.asOf, props: compact({ kind, text, ...props }) });
    this.edge("INCLUDES", this.playbook, id, doc);
    this.edge("SOURCED_FROM", id, doc, doc);
    for (const c of channels) this.edge("APPLIES_TO", id, this.channel(c), doc);
    return id;
  }
}

// ---------- packs ----------

function instagram(b: PackBuilder): void {
  const hooks = loadHooks();
  const doc = b.doc("hooks.json", hooks.hash);
  const order = new Map(hooks.data.classify_order.map((id, i) => [id, i + 1]));
  const o = checkHookOrder(hooks.data);
  const ref = packPath(b.pack, "hooks.json");
  for (const id of o.unknownIds) b.skipped.push({ ref: `${ref}#classify_order:${id}`, reason: "classify_order names a hook id that does not exist" });
  for (const id of o.duplicateIds) b.skipped.push({ ref: `${ref}#classify_order:${id}`, reason: "hook id appears more than once in classify_order" });
  for (const h of o.missing) b.skipped.push({ ref: `${ref}#hook:${h.id} ${h.name}`, reason: "not in classify_order, so classifyHook can never return it" });
  for (const h of hooks.data.hooks) {
    b.rule("hook", h.name, `Hook: ${h.name}`, `${h.template} Best for: ${h.best_for} Trap: ${h.trap}`, doc, ["instagram"], {
      template: h.template, example: h.example, onScreen: h.on_screen, bestFor: h.best_for, trap: h.trap, match: h.match,
      hookId: h.id, classifyOrder: order.get(h.id),
    });
  }
  const rubric = loadRubric();
  const rdoc = b.doc("rubric.json", rubric.hash);
  for (const i of rubric.data.items) {
    b.rule("profile-check", i.id, `Profile check: ${words(i.id)}`, i.full_marks, rdoc, ["instagram"], {
      weight: i.points, commonFail: i.common_fail, itemId: i.id,
    });
  }
  b.appliesTo(["instagram"]);
}

function seo(b: PackBuilder): void {
  const audit = loadAuditIssues();
  const doc = b.doc("audit-issues.json", audit.hash);
  for (const i of audit.data.issues) {
    b.rule("seo-check", i.type, `SEO check: ${i.title}`, `${i.title}. ${i.explanation}`, doc, ["website"], {
      severity: i.severity, howToFix: i.howToFix, issueType: i.type,
    });
  }
  b.appliesTo(["website"]);
}

// Only `updates[]` (each cites a Google-owned source). The file's `unverified[]` claims are never loaded.
function googleUpdates(b: PackBuilder): void {
  const upd = loadGoogleUpdates();
  const doc = b.doc("google-updates.json", upd.hash);
  const search = b.channel("google-search");
  for (const u of upd.data.updates) {
    const id = entityId("Event", `google update ${u.name} ${u.date}`);
    b.nodes.push({
      type: "Event", id, name: u.name, summary: u.notes, src: doc, asOf: b.asOf,
      props: { kind: "google-update", at: u.date, updateKind: u.kind, sourceUrl: u.source },
    });
    b.edge("AFFECTS", id, search, doc);
    b.edge("SOURCED_FROM", id, doc, doc);
  }
  b.appliesTo(["google-search"]);
}

const pct = (x: number): string => `${+(x * 100).toFixed(1)}%`;

function templateText(label: string, t: IndustryTemplate, jobs: boolean, approximate: string | undefined): string {
  const negatives = t.quick_start_negatives.filter((n) => !(jobs && JOB_NEGATIVES.has(n.toLowerCase())));
  return [
    `Google Ads benchmark for ${label} (directional, USD).${approximate ? ` Closest template for "${approximate}"; the figures are US-calibrated, so use them as a rough guide.` : ""}`,
    `Typical conversion rate ${pct(t.typical_cvr)}, target CPA $${t.target_cpa_range_usd[0]}-$${t.target_cpa_range_usd[1]}, typical margin ${pct(t.typical_margin)}, order value $${t.aov_range_usd[0]}-$${t.aov_range_usd[1]}.`,
    `Smart Bidding needs about ${t.smart_bidding_min_conv_month} conversions a month. Performance Max: ${t.pmax_advisability.replace(/_/g, " ")}. ${t.pmax_note}`,
    `Seasonality: ${t.seasonality_notes}`,
    `Red flags: ${t.red_flags.join("; ")}.`,
    `Track these conversions: ${t.recommended_conversion_actions.join(", ")}.`,
    negatives.length ? `Starter negative keywords: ${negatives.join(", ")}.` : undefined,
  ].filter(Boolean).join(" ");
}

function ads(b: PackBuilder, industry: string | undefined, all = false): void {
  const templates = loadIndustryTemplates();
  const tdoc = b.doc("industry-templates.json", templates.hash);
  const keys = Object.keys(templates.data.templates);
  const m = all
    ? { keys: [...keys.filter((k) => k !== "generic").sort(), ...keys.filter((k) => k === "generic")], via: undefined, jobs: false }
    : matchIndustry(industry, templates.data.templates);
  for (const key of m.keys) {
    const t = templates.data.templates[key]!;
    const specific = key !== "generic";
    const label = key.replace(/_/g, " ");
    b.rule("benchmark", `google-ads ${key}`, `Google Ads benchmark: ${label}`, templateText(label, t, m.jobs, specific && m.via === "synonym" ? industry : undefined), tdoc, ["google-ads"], {
      industry: key, matchedFor: specific ? industry : undefined, currency: "USD",
      typicalCvr: t.typical_cvr, typicalMargin: t.typical_margin,
      targetCpaMinUsd: t.target_cpa_range_usd[0], targetCpaMaxUsd: t.target_cpa_range_usd[1],
      aovMinUsd: t.aov_range_usd[0], aovMaxUsd: t.aov_range_usd[1],
      smartBiddingMinConvMonth: t.smart_bidding_min_conv_month, pmaxAdvisability: t.pmax_advisability,
    });
  }
  const registries = [
    { channel: "google-ads" as const, file: "google-ads-policy-registry.json", data: loadGoogleAdsPolicy() },
    { channel: "meta-ads" as const, file: "meta-ads-policy-registry.json", data: loadMetaAdsPolicy() },
  ];
  for (const r of registries) {
    const doc = b.doc(r.file, r.data.hash);
    for (const e of r.data.data.entries) {
      // Policy/behaviour assumptions; the ones about what numbers to expect are benchmarks.
      const kind: RuleKind = e.category === "benchmarks" ? "benchmark" : "policy";
      b.rule(kind, `${r.channel} ${e.id}`, `${r.channel === "google-ads" ? "Google" : "Meta"} Ads ${kind}: ${words(e.id)}`, e.rule, doc, [r.channel], {
        category: e.category, volatility: e.volatility, source: e.source, sourceUrl: e.source_url ?? undefined, lastVerified: e.last_verified,
        staleAfterDays: e.stale_after_days, notes: e.notes,
      });
    }
  }
  b.appliesTo(["google-ads", "meta-ads"]);
}

// Where owned writing goes: captions and posts on Instagram, copy on the website.
const VOICE_CHANNELS: ChannelKey[] = ["instagram", "website"];

function voice(b: PackBuilder): void {
  const patterns = loadPatterns();
  const doc = b.doc("patterns.json", patterns.hash);
  const { tier1, tier2, tier3 } = patterns.data.tiers;
  const sample = (w: Record<string, string>): string => Object.entries(w).slice(0, 6).map(([k, v]) => `${k} -> ${v}`).join("; ");
  const tiers = [
    { key: "ai-vocabulary", label: "AI vocabulary", severity: "high", weight: 5, text: `Words that give AI writing away; always replace. ${Object.keys(tier1.words).length} words and ${tier1.phrases.length} phrases, e.g. ${sample(tier1.words)}.`, n: Object.keys(tier1.words).length + tier1.phrases.length },
    { key: "word-cluster", label: "AI word cluster", severity: "medium", weight: 3, text: `Words that are fine alone but read as AI when two or more share a paragraph. ${Object.keys(tier2.words).length} words, e.g. ${sample(tier2.words)}.`, n: Object.keys(tier2.words).length },
    { key: "overused-word", label: "Overused word", severity: "low", weight: 2, text: `Words that become a tell only through density: ${tier3.words.slice(0, 8).join(", ")}.`, n: tier3.words.length },
  ];
  for (const t of tiers) {
    b.rule("voice-pattern", t.key, `Voice: ${t.label}`, t.text, doc, VOICE_CHANNELS, { severity: t.severity, weight: t.weight, patternCount: t.n });
  }
  for (const [category, c] of Object.entries(patterns.data.categories)) {
    const label = c.label ?? words(category);
    b.rule("voice-pattern", category, `Voice: ${label}`,
      `${label}: a stock pattern of AI-written text (${c.patterns.length} pattern${c.patterns.length === 1 ? "" : "s"}, severity ${c.severity}). Rewrite the sentence in plain words.`,
      doc, VOICE_CHANNELS, { severity: c.severity, weight: c.weight ?? undefined, patternCount: c.patterns.length, category });
  }
  b.appliesTo(VOICE_CHANNELS);
}

// ---------- entry point ----------

export function loadPlaybooks(opts: PlaybooksOptions): SourceResult {
  const nodes = new Map<string, NodeInput>();
  const edges = new Map<string, EdgeInput>();
  const skipped: SourceResult["skipped"] = [];

  const packs: Array<[Pack, (b: PackBuilder) => void]> = [
    [PACKS.instagram, instagram], [PACKS.seo, seo], [PACKS.googleUpdates, googleUpdates],
    [PACKS.ads, (b) => ads(b, opts.industry, opts.allIndustries === true)], [PACKS.voice, voice],
  ];
  for (const [pack, build] of packs) {
    const b = new PackBuilder(pack);
    try {
      build(b);
      const added = new Map<string, NodeInput>();
      for (const n of b.nodes) {
        const same = nodes.get(n.id) ?? added.get(n.id);
        if (same && JSON.stringify(same) !== JSON.stringify(n)) throw new Error(`two different nodes share the id ${n.id}`);
        added.set(n.id, n);
      }
      for (const [id, n] of added) nodes.set(id, n);
      for (const e of b.edges) edges.set(`${e.from}|${e.type}|${e.to}`, e);
      skipped.push(...b.skipped);
    } catch (err) {
      skipped.push({ ref: packPath(pack, ""), reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    source: "playbooks", docs: [], skipped, redactions: {},
    write: { nodes: [...nodes.values()], edges: [...edges.values()], observations: [] },
  };
}
