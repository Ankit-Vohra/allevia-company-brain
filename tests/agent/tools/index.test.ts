import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ALL_TOOLS, toolsByName } from "../../../src/agent/tools/index.js";
import { AGENTS } from "../../../shared/roster.js";

const SPEC_TOOLS = [
  "search", "get_entity", "neighbors", "find_paths", "trace_decision", "who_owns", "who_knows", "impact_of", "important", "topics",
  "metric_trend", "content_performance", "seo_report", "ad_report", "playbook", "history", "recall", "cypher", "remember",
  "propose_action", "show_path", "use_skill",
  // the creating tools, the brand library and web research
  "get_brand_asset", "write_copy", "make_poster", "generate_image", "make_reel_script_and_clip", "research",
  // public data (Apify)
  "google_listing", "instagram_public", "competitor_watch", "ad_library",
  // the website check-up: what to fix, whether AI names the business, and the optional paid keyword ideas
  "website_checkup", "ai_visibility", "keyword_ideas",
  // the business's connected tools
  "calendar_free_slots", "calendar_book", "gmail_draft", "gmail_send", "gmail_inbox", "ga4_report", "gsc_report", "ads_report",
  "connections_available", "connection_tools", "connection_read", "connection_act",
  // the Sales desk: enquiries waiting, the pipeline, leads and deals in the records
  "enquiries_read", "crm_read", "crm_write",
];

// The first {...} after "Example:" in a description.
function example(description: string): unknown {
  const start = description.indexOf("{", description.indexOf("Example:"));
  let depth = 0;
  for (let i = start; i < description.length; i++) {
    if (description[i] === "{") depth++;
    if (description[i] === "}" && --depth === 0) return JSON.parse(description.slice(start, i + 1));
  }
  throw new Error("no example");
}

describe("tool registry", () => {
  it("has exactly the spec's tools, uniquely named", () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual([...SPEC_TOOLS].sort());
  });

  it("resolves every roster agent's tools and rejects unknown names", () => {
    for (const a of AGENTS) expect(toolsByName(a.tools).map((t) => t.name)).toEqual(a.tools);
    expect(() => toolsByName(["search", "nope", "zap"])).toThrow(/unknown tools: nope, zap/);
    expect(toolsByName(["search", "search"])).toHaveLength(1);
  });

  it("descriptions are short, say what comes back, and carry an example that validates", () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length, t.name).toBeLessThan(400);
      expect(t.description, t.name).toMatch(/Example:/);
      const parsed = z.object(t.input).safeParse(example(t.description));
      expect(parsed.success, `${t.name}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it("each owner question names one tool: a description that opens by answering it", () => {
    const routes: Array<[string, string, string]> = [
      ["why did we pause stories?", "trace_decision", "why did we"],
      ["what breaks if the Instagram token expires?", "impact_of", "what breaks if .*expires"],
      ["which hooks work?", "content_performance", "which hooks.* work"],
      ["how is our SEO?", "seo_report", "how is our SEO"],
    ];
    for (const [question, tool, phrase] of routes) {
      const opens = new RegExp(`^Answer '[^']*${phrase}`, "i");
      expect(ALL_TOOLS.filter((t) => opens.test(t.description)).map((t) => t.name), question).toEqual([tool]);
    }
    // The nearest neighbours send the model on: search to trace_decision, playbook to content_performance.
    expect(ALL_TOOLS.find((t) => t.name === "search")!.description).toMatch(/trace_decision/);
    expect(ALL_TOOLS.find((t) => t.name === "playbook")!.description).toMatch(/content_performance/);
    expect(ALL_TOOLS.find((t) => t.name === "impact_of")!.description).toMatch(/token.*System/);
  });

  it("inputs convert to JSON Schema (what MCP and the Agent SDK send to the model)", () => {
    for (const t of ALL_TOOLS) expect(() => z.toJSONSchema(z.object(t.input)), t.name).not.toThrow();
  });

  it("only remember, propose_action, the tools that make things, the public-data lookups, keyword ideas and the proposals through connections (a booking, an email, a change) write", () => {
    expect(ALL_TOOLS.filter((t) => t.writes).map((t) => t.name).sort()).toEqual([
      "ad_library", "calendar_book", "competitor_watch", "connection_act", "crm_write", "generate_image", "gmail_draft", "gmail_send", "google_listing", "instagram_public", "keyword_ideas", "make_poster", "make_reel_script_and_clip", "propose_action", "remember", "write_copy",
    ]);
  });
});
