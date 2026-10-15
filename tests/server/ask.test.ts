// POST /api/:t/ask as server-sent events (ask() with the real wiring and a scripted FakeRuntime over seedMini):
// the framing is `event: <type>\ndata: <json>\n\n`, events arrive in the order ask() made them, the tenant's time zone
// reaches the agents, the Turn is stored and replays, and a client that goes away stops the turn.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { STOPPED_MESSAGE } from "../../src/agent/ask.js";
import { compactEvents } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import type { SessionDetailDto, SessionSummaryDto } from "../../src/server/types.js";
import { harness, post, resetRuntime, SCRIPTS, sseBlocks, sseEvents, useRuntime, type Harness } from "./harness.js";

const QUESTION = "Why did we pause daily stories?";

describe("server: ask over SSE (integration)", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); }, 90_000);
  afterAll(async () => h.cleanup());
  afterEach(() => resetRuntime());

  it("streams every AgentEvent framed as `event: <type>` + `data: <json>`, session first and final last", async () => {
    const res = await post(h.app, "/api/mini/ask", { question: QUESTION });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-cache/);
    const body = await res.text();

    // Framing: blocks separated by a blank line, each exactly one event line and one data line, the event name = type.
    expect(body.endsWith("\n\n")).toBe(true);
    const blocks = sseBlocks(body);
    for (const b of blocks) {
      expect(b.raw).toMatch(/^event: [a-z_]+\ndata: \{.*\}$/);
      expect((JSON.parse(b.data) as AgentEvent).type).toBe(b.event);
    }
    const events = sseEvents(body);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("session");
    expect(types.at(-1)).toBe("final");
    expect(types.filter((t) => t === "final")).toHaveLength(1);
    let from = 0;
    for (const t of ["session", "recall", "plan", "agent_start", "tool_call", "tool_result", "finding", "text", "path", "final"]) {
      const i = types.indexOf(t as AgentEvent["type"], from);
      expect(i, `${t} after ${from}`).toBeGreaterThanOrEqual(from);
      from = i + 1;
    }
    expect(types).not.toContain("error");
    const final = events.at(-1) as Extract<AgentEvent, { type: "final" }>;
    expect(final.answer).toBe((SCRIPTS["chief-of-staff:synthesis"] as { preText: string }).preText);
    expect(final.agents).toEqual(expect.arrayContaining(["chief-of-staff", "librarian"]));
    const path = events.find((e) => e.type === "path") as Extract<AgentEvent, { type: "path" }>;
    expect(path.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["decision:007-pause-daily-stories", "document:adr-007"]));

    // The tenant's own clock reached the agents.
    expect(h.askCalls.at(-1)).toEqual({ tenant: "mini", timeZone: "Asia/Kolkata" });

    // Stored: the thread lists it, and its replay is the same log ask() saved.
    const session = events[0] as Extract<AgentEvent, { type: "session" }>;
    const threads = await (await h.app.request("/api/mini/sessions")).json() as SessionSummaryDto[];
    expect(threads[0]).toMatchObject({ id: session.sessionId, title: QUESTION, turns: 1, channel: "web" });
    const detail = await (await h.app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as SessionDetailDto;
    expect(detail.turns[0]).toMatchObject({ id: session.turnId, question: QUESTION, answer: final.answer, checks: final.checks });
    const replay = await (await h.app.request(`/api/mini/turns/${encodeURIComponent(session.turnId)}/replay`)).json() as AgentEvent[];
    expect(replay).toEqual(compactEvents(events));

    // A follow-up in the same thread.
    const again = sseEvents(await (await post(h.app, "/api/mini/ask", { question: "And what did it replace?", sessionId: session.sessionId })).text());
    expect(again[0]).toMatchObject({ type: "session", sessionId: session.sessionId });
    const after = await (await h.app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as SessionDetailDto;
    expect(after.turns).toHaveLength(2);
  });

  it("the agents' stats and knowledge grow from the stored turn", async () => {
    const agents = await (await h.app.request("/api/mini/agents")).json() as Array<{ id: string; stats: { requests: number; findings: number }; knows: number }>;
    const sara = agents.find((a) => a.id === "librarian")!;
    expect(sara.stats.requests).toBeGreaterThanOrEqual(2);
    expect(sara.stats.findings).toBeGreaterThanOrEqual(1);
    expect(sara.knows).toBeGreaterThanOrEqual(1);
    const profile = await (await h.app.request("/api/mini/agents/librarian")).json() as {
      knowledge: { nodes: Array<{ id: string; weight?: number }>; edges: Array<{ from: string; type: string; to: string }> };
      findings: Array<{ agent: string; turnId: string; question: string; citations: string[] }>;
    };
    expect(profile.knowledge.nodes[0]!.id).toBe("agent:allevia-librarian");
    expect(profile.knowledge.nodes.map((n) => n.id)).toContain("decision:007-pause-daily-stories");
    expect(profile.knowledge.edges).toContainEqual(expect.objectContaining({ from: "agent:allevia-librarian", type: "KNOWS_ABOUT", to: "decision:007-pause-daily-stories" }));
    expect(profile.findings[0]).toMatchObject({ agent: "librarian", question: expect.any(String), citations: ["decision:007-pause-daily-stories"] });
  });

  it("a client that disconnects stops the turn: it is saved as stopped, not answered", async () => {
    // The Chief's plan waits 5 s; the client goes away first.
    useRuntime(() => new FakeRuntime({ ...SCRIPTS, "chief-of-staff:plan": { ...(SCRIPTS["chief-of-staff:plan"] as object), delayMs: 5_000 } }));
    const ctrl = new AbortController();
    const res = await post(h.app, "/api/mini/ask", { question: "Who owns the Instagram token fix?" }, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const session = JSON.parse(/data: (.*)/.exec(first)![1]!) as Extract<AgentEvent, { type: "session" }>;
    expect(session.type).toBe("session");
    const t0 = Date.now();
    ctrl.abort();
    await reader.cancel().catch(() => {});
    let row: { s: string | null; e: string | null } | undefined;
    for (let i = 0; i < 40 && !row; i++) {
      await new Promise((r) => setTimeout(r, 100));
      [row] = await h.g.roQuery<{ s: string | null; e: string | null }>("MATCH (t:Turn {id:$id}) RETURN t.status AS s, t.error AS e", { id: session.turnId });
    }
    expect(row).toEqual({ s: "failed", e: STOPPED_MESSAGE });
    expect(Date.now() - t0).toBeLessThan(4_000); // well before the 5 s plan would have finished
  });

  it("refuses an empty question, a bad body and an unknown business before streaming", async () => {
    expect((await post(h.app, "/api/mini/ask", { question: "   " })).status).toBe(400);
    expect((await post(h.app, "/api/mini/ask", { q: "wrong field" })).status).toBe(400);
    const bad = await h.app.request("/api/mini/ask", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: expect.stringMatching(/JSON/) });
    expect((await post(h.app, "/api/other/ask", { question: QUESTION })).status).toBe(404);
  });

  it("caps live turns running at once", async () => {
    const busy = h.make({ maxLiveAsks: 0 });
    const res = await post(busy, "/api/mini/ask", { question: QUESTION });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/already working/) });
  });
});
