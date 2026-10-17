// Toolkits: every tool is tagged (domain, read or create, cost class, whether it needs the owner's OK) in one place, each roster
// agent is built from toolkits plus named extras, the existing agents keep exactly the tools they had, and the Chief can call
// across every domain it should.
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../../src/agent/tools/index.js";
import { AGENTS, agentById } from "../../shared/roster.js";
import { TOOL_META, TOOLKITS, toolMeta, toolsOf, toolkitsWith } from "../../shared/toolkits.js";
import { isWriteTool } from "../../src/agent/runtime.js";

// What each agent held before toolkits existed (the behaviour that must not change).
const BEFORE: Record<string, string[]> = {
  "chief-of-staff": ["search", "recall", "get_entity", "neighbors", "find_paths", "show_path", "remember", "propose_action"],
  "coe-lead": ["metric_trend", "important", "get_entity", "search", "cypher"],
  "data-analyst": ["metric_trend", "seo_report", "content_performance", "find_paths", "search", "cypher"],
  "growth-marketer": ["ad_report", "content_performance", "seo_report", "playbook", "metric_trend", "search", "propose_action"],
  "content-strategist": ["content_performance", "playbook", "search", "get_entity", "neighbors", "propose_action"],
  "copy-editor": ["playbook", "get_entity", "search"],
  "fact-checker": ["search", "get_entity", "find_paths", "cypher"],
  "tech-lead": ["impact_of", "get_entity", "neighbors", "seo_report", "search", "cypher", "propose_action"],
  "oncall-engineer": ["metric_trend", "impact_of", "get_entity", "neighbors", "history", "search", "cypher", "propose_action", "find_paths"],
  "qa-release": ["metric_trend", "history", "get_entity", "search", "cypher", "propose_action", "neighbors", "find_paths"],
  "ops-manager": ["who_owns", "search", "get_entity", "recall", "cypher", "propose_action"],
  "sales-lead": ["search", "get_entity", "cypher", "propose_action", "history", "recall", "neighbors", "enquiries_read", "crm_read", "crm_write", "calendar_free_slots", "calendar_book", "gmail_draft", "gmail_send", "gmail_inbox", "connections_available", "connection_tools", "connection_read", "connection_act"],
  librarian: ["trace_decision", "who_knows", "history", "topics", "important", "find_paths", "search"],
};
// What was added: new tools only, to the agents that should have them.
const PUBLIC_DATA = ["google_listing", "instagram_public", "competitor_watch", "ad_library"];
const CONN = ["connections_available", "connection_tools", "connection_read", "connection_act"];
const POSTING = ["publish_post", "publish_status", "publish_cancel"];
const ADDED: Record<string, string[]> = {
  "data-analyst": ["what_worked", "research", ...PUBLIC_DATA, "website_checkup", "ai_visibility", "keyword_ideas", "ga4_report", "gsc_report", "ads_report", ...CONN],
  "growth-marketer": ["what_worked", "research", ...PUBLIC_DATA, "website_checkup", "ai_visibility", "ga4_report", "gsc_report", "ads_report", ...CONN],
  "tech-lead": ["website_checkup", "ai_visibility", "keyword_ideas"],
  "chief-of-staff": ["make_poster", "generate_image", "make_reel_script_and_clip", "get_brand_asset", "write_copy", ...POSTING, "research", "calendar_free_slots", "calendar_book", "gmail_draft", "gmail_send", "gmail_inbox", ...CONN, "meetings_read"],
  "content-strategist": ["what_worked", "write_copy", ...POSTING, "get_brand_asset", "research", ...PUBLIC_DATA, ...CONN],
  "coe-lead": ["ga4_report", "gsc_report", ...CONN],
  "ops-manager": ["calendar_free_slots", "calendar_book", "gmail_draft", "gmail_send", "gmail_inbox", ...CONN, "meetings_read"],
  // what was decided in a meeting and who does what ("remember this meeting")
  "sales-lead": ["meetings_read"],
  librarian: ["meetings_read"],
};

describe("toolkits", () => {
  it("tags every tool the registry has, and nothing else", () => {
    expect(TOOL_META.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    expect(new Set(TOOL_META.map((t) => t.name)).size).toBe(TOOL_META.length);
  });

  it("every tag is complete, and the tags agree with how the runtime treats the tool", () => {
    for (const m of TOOL_META) {
      expect(m.summary.length, m.name).toBeGreaterThan(10);
      expect(["read", "create", "write"]).toContain(m.mode);
      expect(["free", "model", "credits", "paid"]).toContain(m.cost);
      const tool = ALL_TOOLS.find((t) => t.name === m.name)!;
      // anything that creates or writes is roster-gated by the runtime; reads are not
      expect(isWriteTool(tool), m.name).toBe(m.mode !== "read");
      // what creates or proposes waits for the owner's OK; a read never does
      if (m.mode === "read") expect(m.needsOk, m.name).toBe(false);
      if (m.mode === "create" || m.name === "propose_action") expect(m.needsOk, m.name).toBe(true);
      // credits are spent only by the tools that make pictures and clips
      if (m.cost === "credits") expect(["creative"]).toContain(m.domain);
      // money at a data provider is spent only by the public-data lookups (which save what they read and post nothing)
      // and the optional keyword research, which records each call's cost
      if (m.cost === "paid" && m.name !== "keyword_ideas") expect([m.domain, m.mode, m.needsOk], m.name).toEqual(["research", "write", false]);
    }
  });

  it("each tool sits in at most one toolkit, and each toolkit's tools exist", () => {
    for (const k of TOOLKITS) for (const t of k.tools) expect(toolMeta(t), `${k.id}: ${t}`).toBeDefined();
    for (const m of TOOL_META) expect(toolkitsWith(m.name).length, m.name).toBeLessThanOrEqual(1);
  });

  it("builds an agent's tools from its toolkits and extras, once each, and rejects unknowns", () => {
    expect(toolsOf(["lookup", "numbers"], ["important", "search"])).toEqual(["search", "get_entity", "metric_trend", "important"]);
    expect(() => toolsOf(["nope"])).toThrow(/unknown toolkit/);
    expect(() => toolsOf(["lookup"], ["not_a_tool"])).toThrow(/no tag/);
  });

  it("every roster agent keeps the tools it had, plus only the new ones it should have", () => {
    for (const a of AGENTS) {
      expect([...a.tools].sort(), a.id).toEqual([...BEFORE[a.id]!, ...(ADDED[a.id] ?? [])].sort());
      expect(a.toolkits.length, a.id).toBeGreaterThan(0);
      expect(a.tools, a.id).toEqual(toolsOf(a.toolkits, a.extras));
    }
    expect(AGENTS.map((a) => a.id).sort()).toEqual(Object.keys(BEFORE).sort());
  });

  it("the Chief calls across domains: lookup, memory, answers, proposals, brand, copy, research and making things", () => {
    const chief = agentById("chief-of-staff")!;
    const domains = new Set(chief.tools.map((t) => toolMeta(t)!.domain));
    for (const d of ["knowledge", "memory", "answer", "brand", "creative", "content", "research"] as const) expect(domains.has(d), d).toBe(true);
    // the desks that review (Wordsmith, Fact Checker) never get the tools that make things
    for (const id of ["copy-editor", "fact-checker"]) for (const t of agentById(id)!.tools) expect(toolMeta(t)!.mode, `${id} ${t}`).toBe("read");
    // only the Chief makes pictures (credits): the cost class stays with one desk
    for (const a of AGENTS) if (a.id !== "chief-of-staff") for (const t of a.tools) expect(toolMeta(t)!.cost, `${a.id} ${t}`).not.toBe("credits");
  });
});
