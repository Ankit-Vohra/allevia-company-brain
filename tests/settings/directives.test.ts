import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ensureRoster } from "../../src/agent/memory.js";
import type { LlmRunner, StructuredInput } from "../../src/ingest/llm.js";
import {
  agentsIn, applyDirective, channelRef, getDirective, listAgentsWithSettings, loadTeamSettings, parseDirective, patchesFromModel,
  previewDirective, setAgentSettings, splitClauses,
} from "../../src/settings/directives.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

const CONTENT = ["content-strategist", "copy-editor"];

describe("parseDirective (deterministic rules)", () => {
  const p = (text: string) => parseDirective(text);

  it("switches a desk off by name or title, with the 'till …' note, and back on", () => {
    expect(p("switch Techie off till the new site launches")).toEqual({
      patches: [{ kind: "agent.enabled", agent: "tech-lead", enabled: false, note: "till the new site launches" }], unparsed: [], notes: [],
    });
    for (const t of ["Turn off the tech lead", "disable Techie", "pause the Tech Lead for now", "Techie is off"]) {
      expect(p(t).patches, t).toMatchObject([{ kind: "agent.enabled", agent: "tech-lead", enabled: false }]);
    }
    for (const t of ["turn Techie back on", "switch on the tech lead", "enable Techie", "bring back Techie"]) {
      expect(p(t).patches, t).toEqual([{ kind: "agent.enabled", agent: "tech-lead", enabled: true }]);
    }
    expect(p("switch Growth Hacker and Data Detective off").patches.map((x) => (x as { agent: string }).agent)).toEqual(["data-analyst", "growth-marketer"]);
  });

  it("never switches the Chief of Staff off, and says why", () => {
    const r = p("switch The Chief off");
    expect(r.patches).toEqual([]);
    expect(r.unparsed).toEqual([]);
    expect(r.notes[0]).toMatch(/The Chief can't be switched off/);
  });

  it("does not mistake other uses of on/off for a switch", () => {
    expect(p("take Growth Hacker off ads").patches).toEqual([]);
    expect(p("put Growth Hacker on light mode").patches).toEqual([{ kind: "agent.mode", agent: "growth-marketer", mode: "light" }]);
    expect(p("turn off notifications").patches).toEqual([]);
  });

  it("sets mode and autonomy", () => {
    expect(p("set Miss Influencer's autonomy to 2").patches).toEqual([{ kind: "agent.autonomy", agent: "content-strategist", autonomy: 2 }]);
    expect(p("Data Detective: autonomy level 1").patches).toEqual([{ kind: "agent.autonomy", agent: "data-analyst", autonomy: 1 }]);
    expect(p("run the data analyst in full mode").patches).toEqual([{ kind: "agent.mode", agent: "data-analyst", mode: "full" }]);
  });

  it("'no emojis on LinkedIn' is an instruction for the content desks, scoped to LinkedIn; an address narrows it", () => {
    expect(p("No emojis on LinkedIn").patches).toEqual([{ kind: "memory.instruction", agents: CONTENT, text: "No emojis on LinkedIn.", channel: "channel:linkedin" }]);
    expect(p("Miss Influencer, no emojis on LinkedIn").patches).toEqual([{ kind: "memory.instruction", agents: ["content-strategist"], text: "No emojis on LinkedIn.", channel: "channel:linkedin" }]);
  });

  it("'always mention free consultation' goes to everyone who writes promotion", () => {
    expect(p("always mention free consultation").patches).toEqual([
      { kind: "memory.instruction", agents: ["content-strategist", "copy-editor", "growth-marketer"], text: "Always mention free consultation." },
    ]);
  });

  it("'never spend above $X/day' is a spend cap for the growth marketer", () => {
    expect(p("never spend above $50/day").patches).toEqual([
      { kind: "memory.instruction", agents: ["growth-marketer"], text: "Never spend above $50/day.", limit: { kind: "max_daily_spend", amount: 50, currency: "USD" } },
    ]);
    expect(p("Don't spend more than ₹2,000 a day on ads").patches[0]).toMatchObject({ limit: { amount: 2000, currency: "INR" } });
    expect(p("never spend over 1.5k AED per day").patches[0]).toMatchObject({ limit: { amount: 1500, currency: "AED" } });
  });

  it("an unaddressed 'never say …' is a brand voice rule; what it can't read is left for the model", () => {
    expect(p("Never say cheap").patches).toEqual([{ kind: "brand_rule.add", text: "Never say cheap.", ruleKind: "voice" }]);
    expect(p("make the captions punchier").unparsed).toEqual(["make the captions punchier"]);
  });

  it("splits several orders in one message", () => {
    expect(splitClauses("No emojis on LinkedIn; switch Techie off till the new site launches")).toEqual(["No emojis on LinkedIn", "switch Techie off till the new site launches"]);
    expect(splitClauses("No emojis on LinkedIn, switch Techie off and always mention free consultation.")).toEqual(["No emojis on LinkedIn", "switch Techie off", "always mention free consultation"]);
    const r = p("Miss Influencer, no emojis on LinkedIn. And switch Techie off till the new site launches.");
    expect(r.patches.map((x) => x.kind)).toEqual(["memory.instruction", "agent.enabled"]);
  });

  it("finds desks and channels by any of their names", () => {
    expect(agentsIn("ask the copy editor and Fact Checker")).toEqual(["copy-editor", "fact-checker"]);
    expect(agentsIn("restart the dev server")).toEqual([]); // "Wordsmith" only capitalised
    expect(agentsIn("the on-call engineer and the release manager")).toEqual(["oncall-engineer", "qa-release"]);
    expect(agentsIn("Firefighter, page me on every crash; Bug Hunter owns QA")).toEqual(["oncall-engineer", "qa-release"]);
    expect(channelRef("linked in")).toEqual({ id: "channel:linkedin", name: "LinkedIn" });
    expect(channelRef("insta")).toEqual({ id: "channel:instagram", name: "Instagram" });
    expect(channelRef("Houzz")).toEqual({ id: "channel:houzz", name: "Houzz" });
  });
});

describe("patchesFromModel (the model's output is validated)", () => {
  it("drops unknown desks and kinds, never switches the Chief off, defaults instruction desks", () => {
    const r = patchesFromModel({
      patches: [
        { kind: "agent.enabled", agents: ["growth-marketer", "chief-of-staff", "ghost"], enabled: false, note: "for a week" },
        { kind: "agent.autonomy", agents: ["content-strategist"], autonomy: 7 },
        { kind: "memory.instruction", text: "keep captions under 20 words", channel: "Instagram" },
        { kind: "brand_rule.add", text: "warm, plain words", ruleKind: "voice" },
        { kind: "delete.everything", agents: ["librarian"] },
      ],
      unclear: ["the bit about the logo"],
    });
    expect(r.patches).toEqual([
      { kind: "agent.enabled", agent: "growth-marketer", enabled: false, note: "for a week" },
      { kind: "memory.instruction", agents: CONTENT, text: "Keep captions under 20 words.", channel: "channel:instagram" },
      { kind: "brand_rule.add", text: "Warm, plain words.", ruleKind: "voice" },
    ]);
    expect(r.notes[0]).toMatch(/can't be switched off/);
    expect(r.unclear).toEqual(["the bit about the logo"]);
  });
});

class FakeDirectiveLlm implements LlmRunner {
  calls: StructuredInput[] = [];
  constructor(private out: unknown) {}
  async structured(input: StructuredInput): Promise<unknown> { this.calls.push(input); return this.out; }
}

describe("preview and apply (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const count = async (cypher: string, params?: Record<string, unknown>) => (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:kestrel-oak", name: "Kestrel & Oak Studio" },
        { type: "Channel", id: "channel:linkedin", name: "LinkedIn" },
        { type: "Person", id: "person:founder", name: "Founder" },
      ],
      edges: [{ from: "channel:linkedin", type: "PART_OF", to: "business:kestrel-oak" }],
    }, NOW);
    expect(s.errors).toEqual([]);
    await ensureRoster(g, { businessId: "business:kestrel-oak" }, NOW);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  let previewId = "";

  it("previews 'No emojis on LinkedIn; switch Techie off' as a diff, stored but not applied, with no model call", async () => {
    const llm = new FakeDirectiveLlm({ patches: [], unclear: [] });
    const pv = await previewDirective(g, { text: "No emojis on LinkedIn; switch Techie off till the new site launches" }, { llm, now: NOW });
    previewId = pv.id;
    expect(llm.calls).toEqual([]);
    expect(pv.id).toMatch(/^document:directive-2026-10-15-[0-9a-f]{8}$/);
    expect(pv).toMatchObject({ status: "preview", parser: "rules", unparsed: [], actor: "person:founder" });
    expect(pv.diff).toEqual([
      { patch: 0, op: "add", target: `memory:${pv.id.slice(9)}-1`, label: "Instruction for Miss Influencer, Wordsmith on LinkedIn", after: "No emojis on LinkedIn." },
      { patch: 1, op: "change", target: "agent:allevia-tech-lead", label: "Techie · Tech", before: "on", after: "off (till the new site launches)" },
    ]);
    // nothing applied yet
    expect((await listAgentsWithSettings(g)).find((a) => a.id === "tech-lead")).toMatchObject({ enabled: true, mode: "full", autonomy: 0, instructions: [] });
    expect(await count("MATCH (:Person {id:'person:founder'})-[:AUTHORED]->(d:Document {id:$id}) WHERE d.status = 'preview' RETURN count(d) AS c", { id: pv.id })).toBe(1);
    expect((await getDirective(g, pv.id))!.patches).toEqual(pv.patches);
  });

  it("applies it: Techie off with the old state kept as a Version, the instruction ABOUT Miss Influencer, Wordsmith and LinkedIn, STATED by the owner", async () => {
    const r = await applyDirective(g, previewId, { now: NOW + 1000 });
    expect(r.errors).toEqual([]);
    expect(r.status).toBe("applied");
    const agents = await listAgentsWithSettings(g);
    expect(agents.find((a) => a.id === "tech-lead")).toMatchObject({ enabled: false, mode: "off", statusNote: "till the new site launches" });
    const [v] = await g.roQuery<{ props: string; changed: string[] }>("MATCH (:Agent {id:'agent:allevia-tech-lead'})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props, v.changed AS changed");
    expect(JSON.parse(v!.props)).toMatchObject({ enabled: true, mode: "full" });
    expect(v!.changed).toEqual(expect.arrayContaining(["enabled", "mode"]));

    const mem = `memory:${previewId.slice(9)}-1`;
    expect(await count("MATCH (m:Memory {id:$id})-[r:ABOUT]->(x) WHERE m.kind = 'instruction' AND r.until IS NULL AND x.id IN ['agent:allevia-content-strategist','agent:allevia-copy-editor','channel:linkedin'] RETURN count(r) AS c", { id: mem })).toBe(3);
    expect(await count("MATCH (:Person {id:'person:founder'})-[:STATED]->(:Memory {id:$id}) RETURN count(*) AS c", { id: mem })).toBe(1);
    expect(await count("MATCH (:Memory {id:$id})-[:SOURCED_FROM]->(:Document {id:$doc}) RETURN count(*) AS c", { id: mem, doc: previewId })).toBe(1);
    expect(agents.find((a) => a.id === "content-strategist")!.instructions).toEqual([{ id: mem, text: "No emojis on LinkedIn.", channel: "LinkedIn", at: NOW + 1000 }]);

    const team = await loadTeamSettings(g);
    expect(team.disabled).toEqual(["tech-lead"]);
    expect(team.instructions).toEqual([{ id: mem, text: "No emojis on LinkedIn.", agents: CONTENT, channel: { id: "channel:linkedin", name: "LinkedIn" } }]);
  });

  it("applying twice writes nothing more", async () => {
    const size = async () => [await count("MATCH (n) RETURN count(n) AS c"), await count("MATCH ()-[r]->() RETURN count(r) AS c")];
    const before = await size();
    const r = await applyDirective(g, previewId, { now: NOW + 5000 });
    expect(r.errors).toEqual([]);
    expect(await size()).toEqual(before);
  });

  it("a repeated instruction previews as 'same' and is not written again; the model reads what the rules can't", async () => {
    const llm = new FakeDirectiveLlm({ patches: [{ kind: "agent.mode", agents: ["growth-marketer"], mode: "light" }], unclear: [] });
    const pv = await previewDirective(g, { text: "No emojis on LinkedIn. Give Growth Hacker a lighter load this month" }, { llm, now: NOW + 10_000 });
    expect(pv.parser).toBe("rules+llm");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.model).toBe("haiku");
    expect(llm.calls[0]!.prompt).toContain("- Give Growth Hacker a lighter load this month");
    expect(llm.calls[0]!.system).toContain("The business's channels: LinkedIn.");
    expect(pv.diff.map((l) => [l.op, l.label])).toEqual([["same", "Instruction for Miss Influencer, Wordsmith on LinkedIn"], ["change", "Growth Hacker · Marketing mode"]]);
    const memories = await count("MATCH (m:Memory) RETURN count(m) AS c");
    await applyDirective(g, pv.id, { now: NOW + 11_000 });
    expect(await count("MATCH (m:Memory) RETURN count(m) AS c")).toBe(memories);
    expect((await loadTeamSettings(g)).light).toEqual(["growth-marketer"]);
  });

  it("without a model (llm: null) the rest stays unparsed and toggles still work; a failing model is reported", async () => {
    const pv = await previewDirective(g, { text: "turn Techie back on; make the captions punchier" }, { llm: null, now: NOW + 20_000 });
    expect(pv.patches).toEqual([{ kind: "agent.enabled", agent: "tech-lead", enabled: true }]);
    expect(pv.unparsed).toEqual(["make the captions punchier"]);
    const failing: LlmRunner = { structured: async () => { throw new Error("offline"); } };
    const pf = await previewDirective(g, { text: "make the captions punchier" }, { llm: failing, now: NOW + 20_500 });
    expect(pf.unparsed).toEqual(["make the captions punchier"]);
    expect(pf.notes[0]).toMatch(/could not read the rest \(offline\)/);
    await applyDirective(g, pv.id, { now: NOW + 21_000 });
    const arjun = (await listAgentsWithSettings(g)).find((a) => a.id === "tech-lead")!;
    expect(arjun).toMatchObject({ enabled: true, mode: "full" });
    expect(arjun.statusNote).toBeUndefined();
  });

  it("setAgentSettings (PATCH) refuses the Chief and bad values", async () => {
    await expect(setAgentSettings(g, "chief-of-staff", { enabled: false })).rejects.toThrow(/can't be switched off/);
    await expect(setAgentSettings(g, "librarian", { autonomy: 5 })).rejects.toThrow(/0 to 3/);
    await expect(setAgentSettings(g, "ghost", { enabled: false })).rejects.toThrow(/no agent/);
    expect(await setAgentSettings(g, "librarian", { autonomy: 1 }, { now: NOW + 30_000 })).toMatchObject({ id: "librarian", autonomy: 1, enabled: true });
  });

  it("a brand rule applies to the Business", async () => {
    const pv = await previewDirective(g, { text: "never say cheap" }, { llm: null, now: NOW + 40_000 });
    await applyDirective(g, pv.id, { now: NOW + 41_000 });
    expect(await count("MATCH (r:BrandRule {id:'brand-rule:owner-never-say-cheap'})-[:APPLIES_TO]->(:Business {id:'business:kestrel-oak'}) WHERE r.origin = 'owner' RETURN count(r) AS c")).toBe(1);
  });

  it("rejects an empty or unknown directive", async () => {
    await expect(previewDirective(g, { text: "  " }, { llm: null })).rejects.toThrow(/Tell your team something/);
    await expect(applyDirective(g, "document:directive-nope")).rejects.toThrow(/no directive preview/);
  });
});
