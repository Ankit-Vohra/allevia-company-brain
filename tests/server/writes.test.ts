// What the API writes, and public mode refusing all of it: an approval decision (status, Version, decidedAt,
// editedPayload, decisionMs, then the onDecision hook), onboarding as SSE through an injected module, and the public
// demo (ALLEVIA_PUBLIC_MODE) serving only showcase replays.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AgentEvent, OnboardEvent } from "../../shared/contracts.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import type { OnboardStart } from "../../src/server/app.js";
import type { ApprovalDto, DecisionDto, SessionDetailDto, SessionSummaryDto } from "../../src/server/types.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, post, sseBlocks, sseEvents, type Harness } from "./harness.js";

const NOW = SEED_NOW + 3_600_000; // the harness clock

describe("server: writes and public mode (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    // A second card to reject, and a showcase turn with a stored event log.
    await upsertNode(h.g, { type: "Approval", id: "approval:t-002-1", name: "github_issue: Fix sitemap errors",
      props: { status: "pending", kind: "github_issue", title: "Fix sitemap errors", payload: JSON.stringify({ title: "Fix sitemap errors", body: "Resubmit the sitemap.", repo: "acme/site" }) } }, SEED_NOW);
    const events: AgentEvent[] = [
      { type: "session", tenant: "mini", sessionId: "session:show-1", turnId: "turn:show-1", question: "What is waiting on me?" },
      { type: "agent_start", agent: "ops-manager", task: "List what waits on the owner" },
      { type: "text", agent: "chief-of-staff", delta: "One approval waits [[approval:t-001-1]]." },
      { type: "final", turnId: "turn:show-1", answer: "One approval waits [[approval:t-001-1]].", citations: ["approval:t-001-1"],
        checks: { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true },
        agents: ["chief-of-staff", "ops-manager"], ms: 1200 },
    ];
    await upsertNode(h.g, { type: "Session", id: "session:show-1", name: "What is waiting on me", props: { channel: "web", startedAt: SEED_NOW } }, SEED_NOW);
    await upsertNode(h.g, { type: "Turn", id: "turn:show-1", name: "What is waiting on me?", props: {
      question: "What is waiting on me?", answer: "One approval waits [[approval:t-001-1]].", at: SEED_NOW, showcase: true, events: JSON.stringify(events),
    } }, SEED_NOW);
    await upsertEdge(h.g, { from: "turn:show-1", type: "IN_SESSION", to: "session:show-1" }, SEED_NOW);
  }, 90_000);
  afterAll(async () => h.cleanup());

  const count = async (cypher: string, params?: Record<string, unknown>) => (await h.g.roQuery<{ c: number }>(cypher, params))[0]!.c;

  it("approve with an edit: the real executor saves the draft, the pending state kept as a Version, decidedAt, decisionMs, editedPayload, hook called", async () => {
    const seen: Array<{ tenant: string; approval: ApprovalDto }> = [];
    const app = h.make({ onDecision: (tenant, approval) => { seen.push({ tenant, approval }); } });
    const edited = { title: "Double down on salary reels", body: "Two salary reels a week, Raipur jobs first." };
    const res = await post(app, "/api/mini/approvals/approval%3At-001-1", { decision: "approve", editedPayload: edited });
    expect(res.status).toBe(200);
    const a = await res.json() as DecisionDto;
    expect(a).toMatchObject({ id: "approval:t-001-1", status: "executed", editedPayload: edited, decidedAt: new Date(NOW).toISOString(), learned: [] });
    expect(a.action).toMatchObject({ kind: "content_draft", status: "done", result: expect.stringMatching(/^Draft saved to drafts\/mini\/t-001-1\.md.*Not published\.$/) });
    expect(seen).toEqual([{ tenant: "mini", approval: expect.objectContaining({ id: "approval:t-001-1", status: "executed" }) }]);

    const [row] = await h.g.roQuery<{ status: string; decidedAt: number; decisionMs: number; edited: string; fp: boolean }>(
      "MATCH (a:Approval {id:'approval:t-001-1'}) RETURN a.status AS status, a.decidedAt AS decidedAt, a.decisionMs AS decisionMs, a.editedPayload AS edited, a.firstPass AS fp");
    expect(row).toMatchObject({ status: "executed", decidedAt: NOW, fp: false });
    expect(row!.decisionMs).toBeGreaterThan(0);
    expect(JSON.parse(row!.edited)).toEqual(edited);
    const versions = await h.g.roQuery<{ props: string; changed: string[] }>(
      "MATCH (:Approval {id:'approval:t-001-1'})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props, v.changed AS changed");
    expect(versions.map((v) => (JSON.parse(v.props) as { status: string }).status).sort()).toEqual(["edited", "pending"]);
    expect(versions.every((v) => v.changed.includes("status"))).toBe(true);

    // Decided once: a second decision is a conflict, and the list shows it decided.
    expect((await post(app, "/api/mini/approvals/approval%3At-001-1", { decision: "reject" })).status).toBe(409);
    const list = await (await app.request("/api/mini/approvals")).json() as ApprovalDto[];
    expect(list.find((x) => x.id === "approval:t-001-1")!.status).toBe("executed");
    expect((await (await app.request("/api/mini/recommendations")).json() as Array<{ id: string; status: string }>)
      .find((r) => r.id === "recommendation:double-down-on-salary-reels")!.status).toBe("approved");
  });

  it("reject; an approve whose 'edit' changes nothing is a plain approve; a failing hook does not undo the decision", async () => {
    const app = h.make({ onDecision: () => { throw new Error("executor down"); } });
    const res = await post(app, "/api/mini/approvals/approval%3At-002-1", { decision: "reject" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "rejected", kind: "github_issue", payload: { title: "Fix sitemap errors", body: "Resubmit the sitemap.", target: "acme/site" } });
    expect(await count("MATCH (:Approval {id:'approval:t-002-1'})-[:HAD_VERSION]->(v:Version) RETURN count(v) AS c")).toBe(1);

    await upsertNode(h.g, { type: "Approval", id: "approval:t-003-1", name: "discord_post: Hello", props: { status: "pending", kind: "discord_post", title: "Hello", payload: JSON.stringify({ title: "Hello", body: "Hi all" }) } }, SEED_NOW);
    const same = await post(app, "/api/mini/approvals/approval%3At-003-1", { decision: "approve", editedPayload: { title: "Hello", body: "Hi all" } });
    // a Discord post is a dry run without ALLEVIA_ACTIONS_LIVE=1: recorded, nothing sent
    expect(await same.json()).toMatchObject({ status: "approved", action: { kind: "discord_post", status: "dry_run", result: expect.stringMatching(/^Dry run: would post "Hello"/) } });
    expect((await post(app, "/api/mini/approvals/approval%3Anope", { decision: "approve" })).status).toBe(404);
    expect((await post(app, "/api/mini/approvals/approval%3At-003-1", { decision: "maybe" })).status).toBe(400);
  });

  it("onboarding streams the module's events and passes the region through", async () => {
    const inputs: OnboardStart[] = [];
    const app = h.make({
      loadOnboard: async () => async (input, emit) => {
        inputs.push(input);
        emit({ type: "stage", stage: "crawl", text: "Reading the website" });
        emit({ type: "page", url: "https://kestrel.example/", title: "Kestrel & Oak" });
        emit({ type: "done", tenant: input.slug, counts: { Page: 1 } });
      },
    });
    const res = await post(app, "/api/onboard", {
      name: "Kestrel & Oak", url: "kestrel.example", instagram: "kestreloak", country: "United Kingdom", currency: "gbp", locale: "en-GB",
      timeZone: "Europe/London", industry: "architecture studio",
    });
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const body = await res.text();
    expect(sseBlocks(body).map((b) => b.event)).toEqual(["stage", "page", "done"]);
    expect((sseEvents(body) as unknown as OnboardEvent[]).at(-1)).toEqual({ type: "done", tenant: "kestrel_oak", counts: { Page: 1 } });
    expect(inputs).toEqual([{
      name: "Kestrel & Oak", slug: "kestrel_oak", url: "kestrel.example", instagram: "kestreloak", country: "United Kingdom", currency: "GBP",
      locale: "en-GB", timeZone: "Europe/London", industry: "architecture studio",
    }]);
    // An unknown time zone is dropped rather than stored.
    await (await post(app, "/api/onboard", { name: "Zed", url: "zed.example", timeZone: "Mars/Olympus" })).text();
    expect(inputs.at(-1)).not.toHaveProperty("timeZone");
  });

  describe("public mode", () => {
    let pub: ReturnType<Harness["make"]>;
    beforeAll(() => { pub = h.make({ publicMode: true, loadOnboard: async () => async () => {} }); });

    it("refuses approvals and onboarding with a JSON 403", async () => {
      for (const [path, body] of [["/api/mini/approvals/approval%3At-003-1", { decision: "approve" }], ["/api/onboard", { name: "X", url: "x.example" }]] as const) {
        const res = await post(pub, path, body);
        expect(res.status, path).toBe(403);
        expect(await res.json()).toEqual({ error: expect.stringMatching(/read-only/) });
      }
      expect((await (await pub.request("/api/health")).json() as { publicMode: boolean }).publicMode).toBe(true);
    });

    it("a live question gets one SSE error saying live chat needs the owner's model access; nothing is written", async () => {
      const turns = await count("MATCH (t:Turn) RETURN count(t) AS c");
      const res = await post(pub, "/api/mini/ask", { question: "How are signups doing?" });
      expect(res.status).toBe(200);
      const events = sseEvents(await res.text());
      expect(events).toEqual([{ type: "error", message: expect.stringMatching(/live chat needs the owner's model access/i) }]);
      expect(await count("MATCH (t:Turn) RETURN count(t) AS c")).toBe(turns);
    });

    it("a showcase question (or its turn id) replays the stored work log in order", async () => {
      const byQuestion = sseEvents(await (await post(pub, "/api/mini/ask", { question: "what is waiting on me" })).text());
      expect(byQuestion.map((e) => e.type)).toEqual(["session", "agent_start", "text", "final"]);
      const byId = sseEvents(await (await post(pub, "/api/mini/ask", { question: "", turnId: "turn:show-1" })).text());
      expect(byId).toEqual(byQuestion);
      // punctuation, case and hyphens do not matter ("signups" finds a recorded "sign-ups" question)
      const sloppy = sseEvents(await (await post(pub, "/api/mini/ask", { question: "  WHAT is   waiting-on me???" })).text());
      expect(sloppy).toEqual(byQuestion);
    });

    it("threads and replays show only showcase turns", async () => {
      const threads = await (await pub.request("/api/mini/sessions")).json() as SessionSummaryDto[];
      expect(threads.map((s) => s.id)).toEqual(["session:show-1"]);
      expect((await pub.request("/api/mini/sessions/session%3As-001")).status).toBe(404);
      const d = await (await pub.request("/api/mini/sessions/session%3Ashow-1")).json() as SessionDetailDto;
      expect(d.turns.map((t) => t.id)).toEqual(["turn:show-1"]);
      expect((await pub.request("/api/mini/turns/turn%3Ashow-1/replay")).status).toBe(200);
      // the owner's private turns stay private even with their id
      const [priv] = await h.g.roQuery<{ id: string }>("MATCH (t:Turn) WHERE t.events IS NOT NULL AND coalesce(t.showcase, false) = false RETURN t.id AS id LIMIT 1");
      if (priv) expect((await pub.request(`/api/mini/turns/${encodeURIComponent(priv.id)}/replay`)).status).toBe(404);
    });
  });
});
