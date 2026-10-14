import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PACKS, VENDOR_DIR, packDir } from "../../src/ingest/sources/playbook-data.js";
import { loadPlaybooks } from "../../src/ingest/sources/playbooks.js";
import { isAllowed, typeOfLabels, type EntityType } from "../../src/graph/schema.js";
import { entityId, typeFromId } from "../../src/util/ids.js";
import { closeAll } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const res = loadPlaybooks({ tenantSlug: "aamdani", industry: "jobs" });
const nodes = res.write.nodes;
const byType = (t: EntityType) => nodes.filter((n) => n.type === t);
const rules = (kind: string) => byType("Rule").filter((n) => n.props?.kind === kind);

describe("vendor tree and licensing", () => {
  const notice = readFileSync(`${VENDOR_DIR}NOTICE.md`, "utf8");
  it.each(Object.values(PACKS).map((p) => [`${p.owner}/${p.repo}`, p] as const))("%s: pinned sha and repo url are in NOTICE.md, LICENSE is MIT or Apache-2.0", (_name, p) => {
    expect(notice).toContain(p.sha);
    expect(notice).toContain(p.url);
    const license = readFileSync(`${VENDOR_DIR}${packDir(p)}/LICENSE`, "utf8");
    expect(license).toMatch(p.license === "MIT" ? /^MIT License/ : /Apache License/);
    for (const f of p.files) expect(existsSync(`${VENDOR_DIR}${packDir(p)}/${f.file}`), f.file).toBe(true);
  });
  it("vendors data only: JSON, LICENSE and NOTICE.md, no executable code", () => {
    const files = readdirSync(VENDOR_DIR, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(f === "LICENSE" || f === "NOTICE.md" || f.endsWith(".json"), f).toBe(true);
  });
});

describe("loadPlaybooks: structure", () => {
  it("is a playbooks SourceResult with nothing skipped, nothing for LLM extraction and no observations", () => {
    expect(res.source).toBe("playbooks");
    expect(res.skipped).toEqual([]);
    expect(res.docs).toEqual([]);
    expect(res.write.observations).toEqual([]);
    expect(res.redactions).toEqual({});
  });

  it("emits one Playbook per pack with source url, licence and pinned sha", () => {
    const pbs = byType("Playbook");
    expect(pbs).toHaveLength(5);
    const ig = pbs.find((p) => p.id === entityId("Playbook", "Jakeschincariol instagram-agent-skill"));
    expect(ig?.props).toMatchObject({
      source: "https://github.com/Jakeschincariol/instagram-agent-skill", license: "MIT", sha: "d03c56bb598be770c60b201f94237e5d1a4268a6",
    });
    for (const p of pbs) expect(p.props?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("emits one playbook Document per vendored file with path and content hash", () => {
    const docs = byType("Document");
    expect(docs).toHaveLength(8);
    const hooks = docs.find((d) => d.id === entityId("Document", "vendor/playbooks/Jakeschincariol__instagram-agent-skill/hooks.json"));
    expect(hooks?.props).toMatchObject({ kind: "playbook", path: "vendor/playbooks/Jakeschincariol__instagram-agent-skill/hooks.json" });
    expect(hooks?.props?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hooks?.props?.url).toContain("/blob/d03c56bb598be770c60b201f94237e5d1a4268a6/skills/ig-reel/hooks.json");
  });

  it("has unique node ids, none reserved, all typed by their prefix", () => {
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of nodes) {
      expect(n.id).not.toMatch(/^(agent|team):allevia-/);
      expect(typeFromId(n.id)).toBe(n.type);
      expect(n.name.trim()).not.toBe("");
    }
  });

  it("every edge is allowed by the ontology and points at nodes of this result", () => {
    const type = new Map(nodes.map((n) => [n.id, n.type]));
    expect(res.write.edges.length).toBeGreaterThan(300);
    for (const e of res.write.edges) {
      const from = type.get(e.from), to = type.get(e.to);
      expect(from, `${e.from} missing`).toBeDefined();
      expect(to, `${e.to} missing`).toBeDefined();
      expect(isAllowed(from!, e.type, to!), `${from} ${e.type} ${to}`).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(loadPlaybooks({ tenantSlug: "aamdani", industry: "jobs" })).toEqual(res);
  });
});

describe("loadPlaybooks: rules", () => {
  it("maps the 26 hooks with their match regex, example and template", () => {
    const hooks = rules("hook");
    expect(hooks).toHaveLength(26);
    const cost = hooks.find((h) => h.id === entityId("Rule", "hook Cost Confession"))!;
    expect(cost.props).toMatchObject({ kind: "hook", template: "{Specific amount} is what {one mistake} cost me." });
    expect(cost.props?.example).toBe("$18,000 is what one missing clause cost me.");
    expect(typeof cost.props?.text).toBe("string");
    for (const h of hooks) expect(() => new RegExp(String(h.props?.match), "i")).not.toThrow();
  });

  it("maps the profile rubric with points as weight", () => {
    const checks = rules("profile-check");
    expect(checks).toHaveLength(12);
    expect(checks.reduce((a, c) => a + Number(c.props?.weight), 0)).toBe(100);
    expect(checks.find((c) => c.id === entityId("Rule", "profile-check name_field"))?.props?.weight).toBe(12);
  });

  it("maps the SEO audit issues with severity and howToFix", () => {
    const checks = rules("seo-check");
    expect(checks).toHaveLength(30);
    const t = checks.find((c) => c.id === entityId("Rule", "seo-check missing-title"))!;
    expect(t.props).toMatchObject({ severity: "critical" });
    expect(String(t.props?.howToFix)).toContain("<title>");
  });

  it("maps both ad policy registries, benchmark-category entries as benchmarks", () => {
    const policy = rules("policy");
    const bench = rules("benchmark");
    expect(policy.length + bench.filter((b) => b.props?.category).length).toBe(39 + 23);
    expect(bench.some((b) => b.id === entityId("Rule", "benchmark google-ads industry-cpc-cpa-ctr-benchmarks"))).toBe(true);
    expect(policy.some((p) => p.id === entityId("Rule", "policy meta-ads meta-learning-phase"))).toBe(true);
    // a source URL is optional (20 upstream entries cite "industry reports"); when present it is https
    for (const p of [...policy, ...bench]) {
      expect(typeof p.props?.source === "string" || p.props?.industry !== undefined).toBe(true);
      if (p.props?.sourceUrl !== undefined) expect(p.props.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("maps voice patterns by category with severity and weight", () => {
    const vp = rules("voice-pattern");
    expect(vp.length).toBeGreaterThanOrEqual(36);
    const chat = vp.find((v) => v.id === entityId("Rule", "voice-pattern chatbot"))!;
    expect(chat.props).toMatchObject({ severity: "critical", weight: 8 });
  });

  it("every rule has text, a source Document, an INCLUDES edge from its Playbook and a SOURCED_FROM edge", () => {
    const edges = res.write.edges;
    const docIds = new Set(byType("Document").map((d) => d.id));
    for (const r of byType("Rule")) {
      expect(String(r.props?.text).length).toBeGreaterThan(10);
      expect(edges.filter((e) => e.type === "INCLUDES" && e.to === r.id), r.id).toHaveLength(1);
      const src = edges.filter((e) => e.type === "SOURCED_FROM" && e.from === r.id);
      expect(src, r.id).toHaveLength(1);
      expect(docIds.has(src[0]!.to)).toBe(true);
      expect(r.src).toBe(src[0]!.to);
    }
  });

  it("applies hooks and profile checks to Instagram, SEO checks to the website, ad rules to the ad channels", () => {
    const applies = (ruleId: string) => res.write.edges.filter((e) => e.type === "APPLIES_TO" && e.from === ruleId).map((e) => e.to);
    expect(applies(entityId("Rule", "hook Cost Confession"))).toEqual(["channel:instagram"]);
    expect(applies(entityId("Rule", "profile-check name_field"))).toEqual(["channel:instagram"]);
    expect(applies(entityId("Rule", "seo-check missing-title"))).toEqual(["channel:website"]);
    expect(applies(entityId("Rule", "policy google-ads rsa-character-limits"))).toEqual(["channel:google-ads"]);
    expect(applies(entityId("Rule", "policy meta-ads meta-learning-phase"))).toEqual(["channel:meta-ads"]);
    const channels = byType("Channel").map((c) => c.id).sort();
    expect(channels).toEqual(["channel:google-ads", "channel:google-search", "channel:instagram", "channel:meta-ads", "channel:website"]);
  });
});

describe("loadPlaybooks: Google updates", () => {
  const events = byType("Event");
  it("emits one Event per dated update, sourced from the vendored doc and affecting Google Search", () => {
    expect(events).toHaveLength(58);
    const march = events.find((e) => e.id === entityId("Event", "google update March 2024 Core Update + spam updates 2024-03-05"))!;
    expect(march.props).toMatchObject({ kind: "google-update", at: "2024-03-05", updateKind: "core+spam" });
    for (const e of events) {
      expect(e.props?.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.write.edges.some((x) => x.type === "AFFECTS" && x.from === e.id && x.to === "channel:google-search")).toBe(true);
      expect(res.write.edges.some((x) => x.type === "SOURCED_FROM" && x.from === e.id)).toBe(true);
    }
  });
  it("never loads the unverified claims", () => {
    const text = JSON.stringify(events);
    expect(text).not.toContain("third_party_sources");
    expect(text).not.toContain("primary_source_check");
  });
});

describe("loadPlaybooks: industry filter", () => {
  const run = (industry?: string) => {
    const r = loadPlaybooks({ tenantSlug: "t", industry });
    return r.write.nodes.filter((n) => n.type === "Rule" && n.props?.kind === "benchmark" && n.props?.industry).map((n) => String(n.props?.industry)).sort();
  };

  it("jobs, recruitment and staffing map to the B2B platform template, plus generic", () => {
    for (const i of ["jobs", "Recruitment platform", "staffing"]) expect(run(i)).toEqual(["generic", "saas_b2b"]);
  });
  it("architecture, interior and home services map to home_services; real estate to real_estate", () => {
    for (const i of ["architecture", "Interior design studio", "home services"]) expect(run(i)).toEqual(["generic", "home_services"]);
    expect(run("real estate")).toEqual(["generic", "real_estate"]);
  });
  it("matches template aliases, and falls back to generic only for anything else (or no industry)", () => {
    expect(run("dentist")).toEqual(["generic", "healthcare"]);
    expect(run("underwater basket weaving")).toEqual(["generic"]);
    expect(run(undefined)).toEqual(["generic"]);
  });
  it("does not carry the 'jobs'/'salary' negative keywords into a jobs business", () => {
    const jobs = loadPlaybooks({ tenantSlug: "t", industry: "jobs" }).write.nodes.filter((n) => n.props?.kind === "benchmark" && n.props?.industry);
    for (const b of jobs) expect(String(b.props?.text)).not.toMatch(/negatives?[^.]*\b(jobs|salary)\b/i);
    const arch = loadPlaybooks({ tenantSlug: "t", industry: "architecture" }).write.nodes.find((n) => n.props?.industry === "home_services")!;
    expect(String(arch.props?.text)).toMatch(/negatives?[^.]*\bjobs\b/i);
  });
  it("labels benchmark rules as USD and directional", () => {
    const b = loadPlaybooks({ tenantSlug: "t", industry: "real estate" }).write.nodes.find((n) => n.props?.industry === "real_estate")!;
    expect(String(b.props?.text)).toMatch(/USD/);
    expect(b.props).toMatchObject({ currency: "USD", typicalCvr: 0.035, targetCpaMinUsd: 40, targetCpaMaxUsd: 120 });
  });
});

describe("loadPlaybooks: graph write (integration)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterAll(async () => {
    await cleanup?.();
    await closeAll();
  });

  it("writes cleanly and idempotently", async () => {
    const t = await testGraph();
    cleanup = t.cleanup;
    await ensureIndexes(t.g);
    const first = await writeBatch(t.g, res.write, 1_760_000_000_000);
    expect(first.errors).toEqual([]);
    expect(first.nodesCreated).toBe(res.write.nodes.length);
    expect(first.edgesCreated).toBe(res.write.edges.length);
    const second = await writeBatch(t.g, res.write, 1_760_000_100_000);
    expect(second.errors).toEqual([]);
    expect(second.nodesCreated).toBe(0);
    expect(second.edgesCreated).toBe(0);
    const rows = await t.g.roQuery<{ labels: string[] }>("MATCH (n:Entity {id:'rule:hook-cost-confession'}) RETURN labels(n) AS labels");
    expect(typeOfLabels(rows[0]!.labels)).toBe("Rule");
  }, 60_000);
});
