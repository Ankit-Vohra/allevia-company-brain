import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { mapRegistry } from "../../src/ingest/sources/registry.js";
import { findSensitive } from "../../src/ingest/redact.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { isAllowed, type EntityType } from "../../src/graph/schema.js";
import type { SourceResult } from "../../src/ingest/types.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { BRAIN_PATH } from "../helpers/vault.js";

const ROOT = new URL("../fixtures/brain/", import.meta.url).pathname;
function readTree(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(ROOT, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}
const FILES = readTree(join(ROOT, "registry"));
const ctx = { asOf: "2026-10-14" };
const res = mapRegistry(FILES, ctx);
const w = res.write;
const node = (id: string) => w.nodes.find((n) => n.id === id)!;
const ofType = (t: EntityType) => w.nodes.filter((n) => n.type === t).map((n) => n.id).sort();
const edgesOf = (type: string) => w.edges.filter((e) => e.type === type).map((e) => `${e.from} -> ${e.to}`).sort();

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "hash") strings(x, out); // hash = generated sha256, not source text
  return out;
}

function checkEdges(r: SourceResult, extra: Record<string, EntityType> = {}): void {
  const types = new Map<string, EntityType>(Object.entries(extra));
  for (const n of r.write.nodes) types.set(n.id, n.type);
  for (const e of r.write.edges) {
    expect(types.has(e.from), `missing from ${e.from}`).toBe(true);
    expect(types.has(e.to), `missing to ${e.to}`).toBe(true);
    expect(isAllowed(types.get(e.from)!, e.type, types.get(e.to)!), `${types.get(e.from)} ${e.type} ${types.get(e.to)}`).toBe(true);
  }
}

describe("mapRegistry: nodes", () => {
  it("is a registry SourceResult with no LLM docs", () => {
    expect(res.source).toBe("registry");
    expect(res.docs).toEqual([]);
    expect(w.observations).toEqual([]);
  });

  it("maps agents, departments and tools+connectors, skipping denied, reserved and invalid files", () => {
    expect(ofType("Agent")).toEqual(["agent:old-writer", "agent:pinger", "agent:planner", "agent:scout", "agent:stray"]);
    expect(ofType("Team")).toEqual(["team:platform", "team:research"]);
    expect(ofType("System")).toEqual([
      "system:analytics-db", "system:chat", "system:dup-keys", "system:mcp-widget-ops", "system:nightly-report", "system:sms-gateway",
      "system:source-host", "system:widget-bridge",
    ]);
    expect(w.nodes.some((n) => /^(agent|team):allevia-/.test(n.id))).toBe(false);
    const why = Object.fromEntries(res.skipped.map((s) => [s.ref, s.reason]));
    expect(why["registry/agents/token-keeper.yaml"]).toMatch(/denied.*sensitive/);
    expect(why["registry/connectors/aws-box.yaml"]).toMatch(/denied.*sensitive/);
    expect(why["registry/README.md"]).toMatch(/not a registry/);
    expect(why["registry/tools/broken.yaml"]).toMatch(/invalid yaml/);
    expect(why["registry/agents/allevia-guard.yaml"]).toMatch(/reserved/);
  });

  it("agents: kind, status, department, summary from `does`, only safe keys, lists restricted to known systems", () => {
    const a = node("agent:scout");
    expect(a).toMatchObject({ type: "Agent", name: "Scout (question desk)", asOf: ctx.asOf, src: "document:registry-agents-scout-yaml" });
    expect(a.summary).toMatch(/^Replies to the owner's questions in the team chat/);
    expect(a.props).toEqual({
      kind: "always-on-service", status: "active", department: "research", model: "sonnet", schedule: "always on", repo: "widget-brain",
      trigger: "a new chat message → the bridge → one assistant run", reportsTo: "founder",
    });
    expect(node("agent:planner").props).toMatchObject({ status: "planned", unverified: true, reportsTo: "scout", delegatesTo: ["pinger"] });
    expect(node("agent:pinger").props).toMatchObject({ kind: "edge-function", usesAgents: ["scout"] });
    expect(node("agent:old-writer").props).toMatchObject({ status: "retired", retiredOn: "2026-09-24", replacedBy: "planner" });
    // which tools and connectors an agent uses is a USES edge, not a list prop
    for (const n of w.nodes) for (const k of ["tools", "connectors", "usedByAgents"]) expect(n.props ?? {}, `${n.id}.${k}`).not.toHaveProperty(k);
  });

  it("systems: kind tool|connector, status (YAML comments stripped, last duplicate key wins)", () => {
    expect(node("system:widget-bridge").props).toMatchObject({ kind: "tool", toolType: "internal-service", status: "active", repo: "widget-brain" });
    expect(node("system:mcp-widget-ops").props).toMatchObject({ kind: "tool", toolType: "mcp" });
    expect(node("system:nightly-report").props).toMatchObject({ kind: "tool", toolType: "cron-job", status: "paused", schedule: "03:45 daily" });
    expect(node("system:dup-keys").props).toMatchObject({ status: "active" });
    expect(node("system:chat").props).toMatchObject({ kind: "connector", status: "connected", lastVerified: "first week of October 2026 (from the notes)" });
    expect(node("system:sms-gateway").props).toMatchObject({ kind: "connector", status: "not_configured" });
    expect(node("system:chat").summary).toMatch(/^Where the owner approves posts/);
  });

  it("teams: purpose as summary, lead and acting lead as props", () => {
    expect(node("team:research")).toMatchObject({ type: "Team", name: "Research", summary: "Works out what sells: products, numbers, tests and the weekly plan.", props: { leadAgent: "scout", actingLead: "founder (Planner is planned)" } });
    expect(node("team:platform").props).toEqual({ leadAgent: "founder" });
  });

  it("one Document per mapped registry file, kind 'registry', with a hash of the redacted text", () => {
    const docs = w.nodes.filter((n) => n.type === "Document");
    expect(docs).toHaveLength(5 + 2 + 4 + 4);
    expect(node("document:registry-agents-scout-yaml")).toMatchObject({
      type: "Document", name: "registry/agents/scout.yaml", props: { kind: "registry", path: "registry/agents/scout.yaml", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }, asOf: ctx.asOf,
    });
    expect(docs.some((d) => /token-keeper|aws-box|broken|README|allevia-guard/.test(d.id))).toBe(false);
  });
});

describe("mapRegistry: edges", () => {
  it("MEMBER_OF from the agent's department and the department's agent lists, deduplicated, lead marked", () => {
    expect(edgesOf("MEMBER_OF")).toEqual([
      "agent:old-writer -> team:research", "agent:pinger -> team:platform", "agent:planner -> team:research", "agent:scout -> team:research",
    ]);
    expect(w.edges.find((e) => e.type === "MEMBER_OF" && e.from === "agent:scout")!.props).toEqual({ role: "lead" });
    expect(w.edges.find((e) => e.type === "MEMBER_OF" && e.from === "agent:planner")!.props).toBeUndefined();
  });

  it("DEPENDS_ON between systems from a tool's `connectors` and from `used_by` entries that are systems", () => {
    expect(edgesOf("DEPENDS_ON")).toEqual([
      "system:mcp-widget-ops -> system:analytics-db", "system:mcp-widget-ops -> system:chat", "system:nightly-report -> system:analytics-db", "system:widget-bridge -> system:chat",
    ]);
  });

  it("no OWNS edges: the registry never states ownership", () => {
    expect(edgesOf("OWNS")).toEqual([]);
  });

  it("every entity gets SOURCED_FROM its own file's Document", () => {
    const src = w.edges.filter((e) => e.type === "SOURCED_FROM");
    expect(src).toHaveLength(5 + 2 + 8);
    expect(src.find((e) => e.from === "agent:scout")!.to).toBe("document:registry-agents-scout-yaml");
    expect(src.find((e) => e.from === "system:chat")!.to).toBe("document:registry-connectors-chat-yaml");
  });

  it("every edge is allowed by the ontology, has both endpoints in the write, and carries src and asOf", () => {
    checkEdges(res);
    for (const e of w.edges) expect(e).toMatchObject({ asOf: ctx.asOf, src: expect.stringMatching(/^document:registry-/) });
    for (const e of w.edges) expect(e.functional).toBeUndefined();
  });

  it("USES: an agent uses the tools and connectors it lists and the systems that list it under used_by (each edge once)", () => {
    const fromAgents = w.edges.filter((e) => e.type === "USES" && e.from.startsWith("agent:"));
    expect(fromAgents.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual([
      "agent:pinger -> system:analytics-db", "agent:pinger -> system:nightly-report", "agent:pinger -> system:sms-gateway",
      "agent:planner -> system:analytics-db", "agent:planner -> system:chat", "agent:planner -> system:mcp-widget-ops",
      "agent:scout -> system:chat", "agent:scout -> system:mcp-widget-ops", "agent:scout -> system:source-host", "agent:scout -> system:widget-bridge",
      "agent:stray -> system:mcp-widget-ops", // its unknown tool is dropped, not linked
    ]);
    expect(new Set(fromAgents.map((e) => `${e.from}|${e.to}`)).size).toBe(fromAgents.length);
    expect(w.edges.some((e) => e.type === "USES" && e.to.startsWith("agent:"))).toBe(false);
    expect(w.edges.some((e) => e.type === "KNOWS_ABOUT")).toBe(false);
  });

  it("USES edges name the file that states them: the agent's own, or the system's used_by", () => {
    const src = (from: string, to: string) => w.edges.find((e) => e.type === "USES" && e.from === from && e.to === to)!.src;
    expect(src("agent:scout", "system:chat")).toBe("document:registry-agents-scout-yaml"); // scout lists it (chat lists scout too)
    expect(src("agent:planner", "system:chat")).toBe("document:registry-connectors-chat-yaml"); // only the connector says so
    expect(src("agent:pinger", "system:nightly-report")).toBe("document:registry-tools-nightly-report-yaml");
  });

  it("USES: a team uses what its members use, marked via: members, sourced from the file that says so", () => {
    const fromTeams = w.edges.filter((e) => e.type === "USES" && e.from.startsWith("team:"));
    expect(fromTeams.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual([
      "team:platform -> system:analytics-db", "team:platform -> system:nightly-report", "team:platform -> system:sms-gateway",
      "team:research -> system:analytics-db", "team:research -> system:chat", "team:research -> system:mcp-widget-ops",
      "team:research -> system:source-host", "team:research -> system:widget-bridge",
    ]);
    for (const e of fromTeams) expect(e.props).toEqual({ via: "members" });
    expect(fromTeams.find((e) => e.to === "system:nightly-report")!.src).toBe("document:registry-tools-nightly-report-yaml");
    // stray names a department that has no file, so it is nobody's member and no team inherits its tools
    expect(w.edges.some((e) => e.type === "MEMBER_OF" && e.from === "agent:stray")).toBe(false);
  });

  it("a retired agent uses nothing, and a team does not inherit from it", () => {
    const r = mapRegistry([
      { path: "registry/agents/gone.yaml", text: "id: gone\nname: Gone\ndepartment: ops\nstatus: retired\ntools: [legacy-tool]\nconnectors: [legacy-hub]" },
      { path: "registry/agents/live.yaml", text: "id: live\nname: Live\ndepartment: ops\nstatus: active\ntools: [legacy-tool]" },
      { path: "registry/departments/ops.yaml", text: "id: ops\nname: Ops\nagents:\n  active: [live]\n  retired: [gone]" },
      { path: "registry/tools/legacy-tool.yaml", text: "id: legacy-tool\nname: Legacy tool\nused_by: [gone]" },
      { path: "registry/connectors/legacy-hub.yaml", text: "id: legacy-hub\nname: Legacy hub\nused_by: [gone]" },
    ], ctx);
    const uses = r.write.edges.filter((e) => e.type === "USES").map((e) => `${e.from} -> ${e.to}`).sort();
    expect(uses).toEqual(["agent:live -> system:legacy-tool", "team:ops -> system:legacy-tool"]);
    checkEdges(r);
  });

  it("never emits an edge the ontology refuses: USES is legal for Agent -> System and Team -> System", () => {
    expect(isAllowed("Agent", "USES", "System")).toBe(true);
    expect(isAllowed("Team", "USES", "System")).toBe(true);
    expect(w.edges.filter((e) => e.type === "USES").length).toBeGreaterThan(0);
    checkEdges(res); // every edge, USES included, passes isAllowed and has both endpoints
  });

  it("reports references it could not resolve once per file, without echoing them", () => {
    const why = Object.fromEntries(res.skipped.map((s) => [s.ref, s.reason]));
    expect(why["registry/agents/stray.yaml"]).toMatch(/unresolved/);
    expect(why["registry/departments/research.yaml"]).toMatch(/unresolved/);
    expect(why["registry/connectors/chat.yaml"]).toMatch(/unresolved/);
    expect(JSON.stringify(res.skipped)).not.toMatch(/ghost-agent|tool-that-does-not-exist|storefront/);
    expect(why["registry/agents/scout.yaml"]).toBeUndefined();
  });
});

describe("mapRegistry: privacy", () => {
  const json = JSON.stringify(res);
  it("drops hosts, paths, credential names and locations, runs_on, and never echoes the raw values", () => {
    for (const leak of [
      "bridge.env", "abc123def456", "CHAT_BOT_TOKEN", "CHAT_APP_ID", "ANALYTICS_SERVICE_ROLE_KEY", "chat.env", "secrets/chat.txt",
      "widget-prod", "pinger-worker", "supabase/functions", "203.0.113.45", "src/bridge", "agents/scout.md", "Never expires",
    ]) expect(json, leak).not.toContain(leak);
  });

  it("keeps a plain note but drops a note that talks about credentials or infrastructure", () => {
    const r = mapRegistry([
      { path: "registry/tools/a.yaml", text: "id: a\nname: A\nnotes: Each answer is kept short." },
      { path: "registry/tools/b.yaml", text: "id: b\nname: B\nnotes: No password on the box; the token lives in the host environment." },
    ], ctx);
    expect(r.write.nodes.find((n) => n.id === "system:a")!.props!.notes).toBe("Each answer is kept short.");
    expect("notes" in r.write.nodes.find((n) => n.id === "system:b")!.props!).toBe(false);
  });

  it("redacts what it keeps: emails, phones and a Supabase ref in a name", () => {
    expect(node("agent:scout").summary).toContain("[redacted:email]");
    expect(node("agent:pinger").summary).toContain("[redacted:phone]");
    expect(node("system:analytics-db").name).toBe("Supabase analytics ([redacted:supabase-ref], London)");
    expect(node("system:analytics-db").summary).toContain("[redacted:email]");
    expect(node("system:mcp-widget-ops").props!.notes).toBe("Answers stay short enough for one chat message. Write to [redacted:email] if it breaks.");
    expect(json).not.toMatch(/alerts@example|ops@example|7700|900123|xkqzbtwhrnvdmfgjpsly/);
    expect(res.redactions).toMatchObject({ email: expect.any(Number), phone: 1, "supabase-ref": 1 });
    expect(res.redactions.email).toBeGreaterThanOrEqual(3);
  });

  it("nothing in the whole result trips the detectors", () => {
    for (const s of strings(res.write)) expect(findSensitive(s), s).toEqual([]);
  });
});

describe("mapRegistry: robustness", () => {
  it("accepts paths with or without the registry/ prefix and gives the same ids", () => {
    const bare = mapRegistry(FILES.filter((f) => f.path.startsWith("registry/")).map((f) => ({ path: f.path.replace(/^registry\//, ""), text: f.text })), ctx);
    expect(bare.write.nodes.map((n) => n.id).sort()).toEqual(w.nodes.map((n) => n.id).sort());
  });

  it("is deterministic regardless of input order", () => {
    const shuffled = mapRegistry([...FILES].reverse(), ctx);
    expect(shuffled.write).toEqual(w);
  });

  it("an agent and a department can share an id without clashing", () => {
    const r = mapRegistry([
      { path: "registry/agents/ops.yaml", text: "id: ops\nname: Ops\ndepartment: ops\nstatus: active\ndoes: Watches things." },
      { path: "registry/departments/ops.yaml", text: "id: ops\nname: Operations\npurpose: Keeps it up.\nlead_agent: ops\nagents:\n  active: [ops]" },
    ], ctx);
    expect(r.write.nodes.filter((n) => n.type !== "Document").map((n) => n.id).sort()).toEqual(["agent:ops", "team:ops"]);
    expect(r.write.edges.filter((e) => e.type === "MEMBER_OF")).toHaveLength(1);
    checkEdges(r);
  });

  it("falls back to the file name for a missing id, skips files with nothing usable, and ignores non-map YAML", () => {
    const r = mapRegistry([
      { path: "registry/tools/no-id.yaml", text: "name: No id here\ntype: script\nstatus: active" },
      { path: "registry/tools/list.yaml", text: "- just\n- a list" },
      { path: "registry/tools/empty.yaml", text: "" },
      { path: "registry/tools/scalar.yaml", text: "hello" },
    ], ctx);
    expect(r.write.nodes.filter((n) => n.type === "System").map((n) => n.id)).toEqual(["system:no-id"]);
    expect(r.skipped.map((s) => s.ref).sort()).toEqual(["registry/tools/empty.yaml", "registry/tools/list.yaml", "registry/tools/scalar.yaml"]);
  });

  it("does not crash on hostile input", () => {
    const hostile = [
      "a: &a [*a]", "id: " + "x".repeat(100_000), "id: x\nname: " + "y ".repeat(100_000), "id: x\ntools: " + "[a,".repeat(5000),
      "id: x\nused_by: not-a-list\nconnectors: 5\ntools: {a: b}", "id: [1, 2]\nname: {a: 1}", "\u0000\u0001\u0002",
      "id: x\nagents:\n" + Array.from({ length: 5000 }, (_, i) => `  - a${i}`).join("\n"),
    ];
    for (const text of hostile) expect(() => mapRegistry([{ path: "registry/tools/x.yaml", text }], ctx)).not.toThrow();
  });
});

describe("mapRegistry (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("writes cleanly, idempotently, and the graph passes the privacy scan", async () => {
    const s1 = await writeBatch(g, w);
    expect(s1.errors).toEqual([]);
    expect(s1.nodesCreated).toBe(w.nodes.length);
    const s2 = await writeBatch(g, mapRegistry(FILES, ctx).write);
    expect(s2).toMatchObject({ nodesCreated: 0, nodesUpdated: 0, edgesCreated: 0, versions: 0, errors: [] });
    const one = async (cy: string) => (await g.roQuery<{ c: number }>(cy))[0]!.c;
    expect(await one("MATCH (:Entity:Agent)-[r:MEMBER_OF]->(:Entity:Team) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(4);
    expect(await one("MATCH (:Entity:System)-[r:DEPENDS_ON]->(:Entity:System) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(4);
    expect(await one("MATCH (:Entity:Agent)-[r:USES]->(:Entity:System) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(11);
    expect(await one("MATCH (:Entity:Team)-[r:USES]->(:Entity:System) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(8);
    expect(await scanGraph(g)).toEqual([]);
  });
});

// Structure only: never snapshot real content into the repo.
const VAULT = BRAIN_PATH;
describe.skipIf(!existsSync(join(VAULT, "registry", "agents")))("real vault registry (structure only)", () => {
  const real: Array<{ path: string; text: string }> = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e)) real.push({ path: relative(VAULT, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(join(VAULT, "registry"));
  const r = mapRegistry(real, { asOf: "2026-10-14" });

  it("maps at least 20 systems, plus agents and teams, with unique ids", () => {
    const count = (t: EntityType) => r.write.nodes.filter((n) => n.type === t).length;
    expect(count("System")).toBeGreaterThanOrEqual(20);
    expect(count("Agent")).toBeGreaterThanOrEqual(10);
    expect(count("Team")).toBeGreaterThanOrEqual(5);
    expect(new Set(r.write.nodes.map((n) => n.id)).size).toBe(r.write.nodes.length);
    expect(r.write.edges.filter((e) => e.type === "MEMBER_OF").length).toBeGreaterThanOrEqual(10);
    expect(r.write.edges.filter((e) => e.type === "DEPENDS_ON").length).toBeGreaterThanOrEqual(10);
    const uses = r.write.edges.filter((e) => e.type === "USES");
    expect(uses.filter((e) => e.from.startsWith("agent:")).length).toBeGreaterThanOrEqual(20);
    expect(uses.filter((e) => e.from.startsWith("team:")).length).toBeGreaterThanOrEqual(10);
    expect(uses.every((e) => e.to.startsWith("system:"))).toBe(true);
    expect(r.skipped.some((s) => /USES/.test(s.reason))).toBe(false);
  });

  it("every edge is allowed by the ontology and resolves to a node", () => {
    checkEdges(r);
    expect(r.write.nodes.some((n) => /^(agent|team):allevia-/.test(n.id))).toBe(false);
  });

  it("no string in the result trips a detector, and sensitive file names were not mapped", () => {
    const bad = strings(r.write).filter((s) => findSensitive(s).length > 0);
    expect(bad).toEqual([]);
    expect(r.write.nodes.filter((n) => n.type === "Document").every((n) => !/aws|token|secret|credential|ssh/i.test(n.id))).toBe(true);
  });
});
