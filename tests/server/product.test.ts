// The product endpoints (product design §8) over the seeded graph: Allevia 90 (program, capabilities), team settings
// and "Tell your team" (agents, PATCH, directives preview/apply), the learning feed (a decision that teaches a rule,
// then retiring it), the insights and brief runs, approvals that run the real executors with GitHub in dry-run mode,
// onboarding resolving to the merged module, and public mode refusing every one of these writes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DirectivePreview, LearnedRuleDto, ProgramScorecard } from "../../shared/contracts.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { loadOnboardModule } from "../../src/server/app.js";
import type { AgentViewDto } from "../../src/server/routes/team.js";
import type { DecisionDto } from "../../src/server/types.js";
import { templateFor } from "../../src/onboard/templates.js";
import { baselinesWrite, checkpointWrite, programAndGoalsWrite, programGoals } from "../../src/program/program.js";
import { ensureAgentNode } from "../../src/actions/shared.js";
import { setActionTarget } from "../../src/actions/target.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { AGENTS } from "../../shared/roster.js";
import { harness, post, TENANT, type Harness } from "./harness.js";

const NOW = SEED_NOW + 3_600_000; // the harness clock
const today = new Date(NOW).toISOString().slice(0, 10);

const req = (app: Harness["app"], method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("server: product endpoints (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await upsertNode(h.g, { type: "Approval", id: "approval:p-villa", name: "content_draft: Villa tour", props: {
      status: "pending", kind: "content_draft", title: "Villa tour", by: "content-strategist",
      payload: JSON.stringify({ title: "Villa tour", body: "Our villa in Raipur is amazing! Book a villa visit." }) } }, SEED_NOW);
    await upsertNode(h.g, { type: "Approval", id: "approval:p-issue", name: "github_issue: Fix the sitemap", props: {
      status: "pending", kind: "github_issue", title: "Fix the sitemap", payload: JSON.stringify({ title: "Fix the sitemap", body: "Resubmit it." }) } }, SEED_NOW);
  }, 90_000);
  afterAll(async () => h.cleanup());

  const json = async <T>(res: Response, status = 200): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return res.json() as Promise<T>;
  };
  const nodes = async () => (await h.g.roQuery<{ c: number }>("MATCH (n:Entity) RETURN count(n) AS c"))[0]!.c;

  it("program: 404 until enrolled; then day 0 with goals, checkpoints, the first-pass curve and capabilities by mode", async () => {
    expect((await h.app.request("/api/mini/program")).status).toBe(404);
    // enrol the seeded business the way onboarding's goals and baseline stages do
    const template = templateFor("jobs");
    for (const o of ["growth-marketer", "content-strategist", "data-analyst"]) await ensureAgentNode(h.g, o, NOW);
    const p = await programAndGoalsWrite(h.g, { slug: "mini", businessId: TENANT.businessId, businessName: "Aamdani", template, now: NOW, startDate: today, timeZone: "Asia/Kolkata" });
    expect((await writeBatch(h.g, p.write, NOW)).errors).toEqual([]);
    const goals = await programGoals(h.g, p.program);
    const b = await baselinesWrite(h.g, { goals, businessId: TENANT.businessId, today });
    expect((await writeBatch(h.g, b.write, NOW)).errors).toEqual([]);
    expect((await writeBatch(h.g, await checkpointWrite(h.g, { program: p.program, day: 0, date: today, now: NOW, goals: await programGoals(h.g, p.program) }), NOW)).errors).toEqual([]);

    const card = await json<ProgramScorecard>(await h.app.request("/api/mini/program"));
    expect(card).toMatchObject({ day: 0, daysLeft: 90, status: "active", startDate: today });
    expect(card.goals.map((g) => g.name)).toEqual(["Weekly signups", "Instagram reach", "Search clicks"]);
    expect(card.goals.every((g) => g.baselineConf === "unknown" ? g.baseline === null && g.status === "no_data" : typeof g.baseline === "number")).toBe(true);
    expect(card.checkpoints[0]).toMatchObject({ day: 0, status: "done" });
    expect(card.firstPass.series.at(-1)!.date).toBe(card.today);
    expect(Object.values(card.capabilities.byMode).reduce((a, b) => a + b, 0)).toBe(7);
  });

  it("capabilities: the ladder in key order", async () => {
    const caps = await json<Array<{ key: string; accessMode: string }>>(await h.app.request("/api/mini/capabilities"));
    expect(caps.map((c) => c.key)).toEqual(["ga4", "search_console", "gbp", "instagram_insights", "reviews", "studio", "ads"]);
  });

  it("agents: stats merged with settings; PATCH switches a desk off (old state kept as a Version) and refuses what it can't do", async () => {
    const list = await json<AgentViewDto[]>(await h.app.request("/api/mini/agents"));
    expect(list.map((a) => a.id)).toEqual(AGENTS.map((a) => a.id)); // every roster desk, in roster order
    expect(list.map((a) => a.id)).toEqual(expect.arrayContaining(["oncall-engineer", "qa-release"]));
    expect(list.find((a) => a.id === "tech-lead")).toMatchObject({ stats: expect.any(Object), knows: expect.any(Number), enabled: true, mode: "full", autonomy: 0, instructions: [], learnedRules: [] });

    const off = await json<AgentViewDto>(await req(h.app, "PATCH", "/api/mini/agents/tech-lead", { enabled: false, statusNote: "till the new site launches" }));
    expect(off).toMatchObject({ id: "tech-lead", enabled: false, mode: "off", statusNote: "till the new site launches" });
    const [v] = await h.g.roQuery<{ c: number }>("MATCH (:Agent {id:'agent:allevia-tech-lead'})-[:HAD_VERSION]->(v:Version) RETURN count(v) AS c");
    expect(v!.c).toBeGreaterThan(0);
    expect((await json<AgentViewDto>(await req(h.app, "PATCH", "/api/mini/agents/tech-lead", { mode: "light" })))).toMatchObject({ enabled: true, mode: "light" });
    expect((await req(h.app, "PATCH", "/api/mini/agents/chief-of-staff", { enabled: false })).status).toBe(400);
    expect((await req(h.app, "PATCH", "/api/mini/agents/nobody", { enabled: false })).status).toBe(404);
    expect((await req(h.app, "PATCH", "/api/mini/agents/tech-lead", {})).status).toBe(400);
    expect((await req(h.app, "PATCH", "/api/mini/agents/tech-lead", { autonomy: 7 })).status).toBe(400);
  });

  it("directives: preview writes nothing to the agents, apply does; applying twice adds nothing", async () => {
    const preview = await json<DirectivePreview>(await post(h.app, "/api/mini/directives", { text: "Tara, no emojis on LinkedIn" }));
    expect(preview).toMatchObject({ status: "preview", parser: "rules" });
    expect(preview.patches).toContainEqual(expect.objectContaining({ kind: "memory.instruction", agents: ["content-strategist"] }));
    expect((await json<AgentViewDto[]>(await h.app.request("/api/mini/agents"))).find((a) => a.id === "content-strategist")!.instructions).toEqual([]);
    const applied = await json<DirectivePreview & { errors: string[] }>(await post(h.app, `/api/mini/directives/${encodeURIComponent(preview.id)}/apply`, {}));
    expect(applied).toMatchObject({ status: "applied", errors: [] });
    const tara = (await json<AgentViewDto[]>(await h.app.request("/api/mini/agents"))).find((a) => a.id === "content-strategist")!;
    expect(tara.instructions).toEqual([expect.objectContaining({ text: expect.stringMatching(/emoji/i) })]);
    const before = await nodes();
    await json(await post(h.app, `/api/mini/directives/${encodeURIComponent(preview.id)}/apply`, {}));
    expect(await nodes()).toBe(before);
    expect((await post(h.app, "/api/mini/directives/document%3Anope/apply", {})).status).toBe(404);
    expect((await post(h.app, "/api/mini/directives", { text: "" })).status).toBe(400);
  });

  it("approvals: an edit teaches a rule (the learned events are in the answer); the learning feed shows it; retiring keeps a Version", async () => {
    const d = await json<DecisionDto>(await post(h.app, "/api/mini/approvals/approval%3Ap-villa", {
      decision: "approve", editedPayload: { title: "Home tour", body: "Our home in Raipur. Book a home visit." },
    }));
    expect(d.status).toBe("executed");
    expect(d.action).toMatchObject({ kind: "content_draft", status: "done" });
    expect(d.learned).toContainEqual({ type: "learned", ruleId: expect.stringMatching(/^rule:/), text: 'Say "home", not "villa".', fromApprovalId: "approval:p-villa" });

    const feed = await json<{ rules: LearnedRuleDto[]; firstPass: { decided30d: number }; active: number }>(await h.app.request("/api/mini/learning?since=2026-01-01"));
    const rule = feed.rules.find((r) => r.text === 'Say "home", not "villa".')!;
    expect(rule).toMatchObject({ status: "active", fromApprovalIds: ["approval:p-villa"], agents: ["content-strategist"] });
    expect(feed.active).toBeGreaterThan(0);
    expect((await json<{ rules: unknown[] }>(await h.app.request(`/api/mini/learning?since=${NOW + 86_400_000}`))).rules).toEqual([]);
    expect((await h.app.request("/api/mini/learning?since=soon")).status).toBe(400);
    expect((await json<AgentViewDto[]>(await h.app.request("/api/mini/agents"))).find((a) => a.id === "content-strategist")!.learnedRules.map((r) => r.id)).toContain(rule.id);

    const retired = await json<LearnedRuleDto>(await req(h.app, "DELETE", `/api/mini/learning/${encodeURIComponent(rule.id)}`));
    expect(retired).toMatchObject({ id: rule.id, status: "retired", retiredAt: expect.any(String) });
    const [v] = await h.g.roQuery<{ props: string }>("MATCH (:Rule {id:$id})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props", { id: rule.id });
    expect(JSON.parse(v!.props)).toMatchObject({ status: "active" });
    expect((await json<AgentViewDto[]>(await h.app.request("/api/mini/agents"))).find((a) => a.id === "content-strategist")!.learnedRules.map((r) => r.id)).not.toContain(rule.id);
    expect((await req(h.app, "DELETE", "/api/mini/learning/rule%3Anope")).status).toBe(404);
  });

  it("approvals: a fix lands in the business's own tasks by default; with GitHub opted in it is a dry run unless actions are live", async () => {
    // the default for a customer's business ("mini" is the founder's in these tests, so it is a customer's for a moment): a
    // task inside the app, nothing outside touched, even without ALLEVIA_ACTIONS_LIVE
    const founders = process.env.ALLEVIA_ACTION_TENANTS;
    delete process.env.ALLEVIA_ACTION_TENANTS;
    let tasked: DecisionDto;
    try {
      tasked = await json<DecisionDto>(await post(h.app, "/api/mini/approvals/approval%3Ap-issue", { decision: "approve" }));
    } finally {
      if (founders !== undefined) process.env.ALLEVIA_ACTION_TENANTS = founders;
    }
    expect(tasked).toMatchObject({ status: "executed", action: { kind: "github_issue", status: "done", result: expect.stringMatching(/^Added to your tasks: “Fix the sitemap”/) } });
    const [t] = await h.g.roQuery<{ kind: string; status: string }>("MATCH (:Approval {id:'approval:p-issue'})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(t:Task) RETURN t.kind AS kind, t.status AS status");
    expect(t).toEqual({ kind: "fix", status: "open" });

    // opted in to its own repo (not the server's)
    await setActionTarget(h.g, { target: "github", repo: "acme-co/site" }, { now: SEED_NOW, serverRepo: "acme/site" });
    await upsertNode(h.g, { type: "Approval", id: "approval:p-dry", name: "github_issue: Dry one", props: {
      status: "pending", kind: "github_issue", title: "Dry one", payload: JSON.stringify({ title: "Dry one", body: "Hold." }) } }, SEED_NOW);
    const dry = await json<DecisionDto>(await post(h.app, "/api/mini/approvals/approval%3Ap-dry", { decision: "approve" }));
    expect(dry).toMatchObject({ status: "approved", action: { kind: "github_issue", status: "dry_run", result: expect.stringMatching(/^Dry run: would open a GitHub issue on acme-co\/site titled "Dry one"/) } });

    await upsertNode(h.g, { type: "Approval", id: "approval:p-live", name: "github_issue: Live one", props: {
      status: "pending", kind: "github_issue", title: "Live one", payload: JSON.stringify({ title: "Live one", body: "Go." }) } }, SEED_NOW);
    const calls: string[][] = [];
    const live = h.make({ actions: { live: true, gh: async (args) => { calls.push(args); return "https://github.com/acme-co/site/issues/7\n"; }, config: { githubActionRepo: "acme/site" } } });
    const done = await json<DecisionDto>(await post(live, "/api/mini/approvals/approval%3Ap-live", { decision: "approve" }));
    expect(done).toMatchObject({ status: "executed", action: { status: "done", url: "https://github.com/acme-co/site/issues/7" } });
    expect(calls[0]!.slice(0, 4)).toEqual(["issue", "create", "--repo", "acme-co/site"]);
    // back to "chose nothing", as the rest of this file expects of the founder's own business
    await upsertNode(h.g, { type: "Business", id: TENANT.businessId, name: "Aamdani", props: { actionTarget: null, actionRepo: null, actionOperator: null } }, SEED_NOW + 1000);
  });

  it("insights and brief runs; GET /brief serves the Document the brief run wrote, goal pulse included", async () => {
    const r = await json<{ findings: number; errors: unknown[] }>(await post(h.app, "/api/mini/insights/run", {}));
    expect(r.findings).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
    const b = await json<{ id: string; text: string; goals: Array<{ name: string }> }>(await post(h.app, "/api/mini/brief/run", {}));
    expect(b.text).toMatch(/^Your goals$/m);
    expect(b.goals.map((g) => g.name)).toEqual(expect.arrayContaining(["Weekly signups", "Instagram reach", "Search clicks"]));
    const served = await json<{ id: string; text: string }>(await h.app.request("/api/mini/brief"));
    expect(served).toMatchObject({ id: b.id, text: b.text });
  });

  it("onboarding resolves to the merged module (no more 501)", async () => {
    expect(typeof (await loadOnboardModule())).toBe("function");
  });

  it("public mode refuses every write and reads the program and capabilities without writing", async () => {
    const pub = h.make({ publicMode: true });
    const before = await nodes();
    for (const [method, path, body] of [
      ["PATCH", "/api/mini/agents/tech-lead", { enabled: true }],
      ["POST", "/api/mini/directives", { text: "No emojis" }],
      ["POST", "/api/mini/directives/document%3Ax/apply", {}],
      ["DELETE", "/api/mini/learning/rule%3Ax", undefined],
      ["POST", "/api/mini/insights/run", {}],
      ["POST", "/api/mini/brief/run", {}],
    ] as const) {
      const res = await req(pub, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/read-only/) });
    }
    expect((await pub.request("/api/mini/program")).status).toBe(200);
    expect((await pub.request("/api/mini/capabilities")).status).toBe(200);
    expect(await nodes()).toBe(before);
  });
});
