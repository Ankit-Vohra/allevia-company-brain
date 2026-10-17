// POST /api/:t/ask as server-sent events (ask() with the real wiring and a scripted FakeRuntime over seedMini):
// the framing is `event: <type>\ndata: <json>\n\n`, events arrive in the order ask() made them, the tenant's time zone
// reaches the agents, the Turn is stored and replays. A client that goes away does not stop the turn: it runs to the
// end on the server and can be re-attached (GET /turns/:id/events?after=); only POST /turns/:id/stop stops it.
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

  // Opens a live turn, reads its first event (session) and returns the session plus a way to hang up.
  async function openTurn(app: Harness["app"], question: string) {
    const ctrl = new AbortController();
    const res = await post(app, "/api/mini/ask", { question }, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const session = JSON.parse(/data: (.*)/.exec(first)![1]!) as Extract<AgentEvent, { type: "session" }>;
    expect(session.type).toBe("session");
    const hangUp = async () => { ctrl.abort(); await reader.cancel().catch(() => {}); };
    const rest = async () => { let s = first; for (;;) { const { value, done } = await reader.read(); if (done) return s; s += new TextDecoder().decode(value); } };
    return { session, hangUp, rest };
  }
  const savedTurn = async (turnId: string, ms = 8_000) => {
    let row: { s: string | null; e: string | null; a: string | null } | undefined;
    for (let i = 0; i < ms / 100 && !row; i++) {
      await new Promise((r) => setTimeout(r, 100));
      [row] = await h.g.roQuery<{ s: string | null; e: string | null; a: string | null }>("MATCH (t:Turn {id:$id}) RETURN t.status AS s, t.error AS e, t.answer AS a", { id: turnId });
    }
    return row;
  };
  const slowPlan = (ms: number) => () => new FakeRuntime({ ...SCRIPTS, "chief-of-staff:plan": { ...(SCRIPTS["chief-of-staff:plan"] as object), delayMs: ms } });
  interface EventsPage { turnId: string; sessionId: string; question: string; status: string; events: AgentEvent[]; next: number; done: boolean }
  const eventsPage = async (app: Harness["app"], turnId: string, after: number) => {
    const res = await app.request(`/api/mini/turns/${encodeURIComponent(turnId)}/events?after=${after}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<EventsPage>;
  };

  it("a client that disconnects does not stop the turn: it runs to the end, is saved, and can be re-attached", async () => {
    // The Chief's plan takes 1.5 s; the client goes away first, the way a closed tab does.
    useRuntime(slowPlan(1_500));
    const app = h.make();
    const q = "Who owns the Instagram token fix?";
    const { session, hangUp } = await openTurn(app, q);
    await hangUp();

    // Still running on the server: the live list, the thread and the events endpoint all say so.
    const live = await (await app.request("/api/mini/turns/live")).json() as Array<{ turnId: string; sessionId: string; question: string; status: string }>;
    expect(live).toEqual([expect.objectContaining({ turnId: session.turnId, sessionId: session.sessionId, question: q, status: "running" })]);
    const thread = await (await app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as SessionDetailDto;
    expect(thread.running).toMatchObject({ turnId: session.turnId, question: q, status: "running" });
    const threads = await (await app.request("/api/mini/sessions")).json() as SessionSummaryDto[];
    expect(threads.find((s) => s.id === session.sessionId)?.running).toBe(true);

    // Re-attach: the events so far, then only the new ones, until the turn is done.
    const p0 = await eventsPage(app, session.turnId, 0);
    expect(p0).toMatchObject({ turnId: session.turnId, sessionId: session.sessionId, question: q, status: "running", done: false });
    expect(p0.events[0]).toMatchObject({ type: "session", turnId: session.turnId });
    const seen = [...p0.events];
    let page = p0;
    for (let i = 0; i < 100 && !page.done; i++) {
      await new Promise((r) => setTimeout(r, 100));
      page = await eventsPage(app, session.turnId, seen.length);
      expect(page.events.every((e) => e.type !== "session")).toBe(true); // nothing seen twice
      seen.push(...page.events);
    }
    expect(page).toMatchObject({ status: "done", done: true, next: seen.length });
    const types = seen.map((e) => e.type);
    expect(types.at(-1)).toBe("final");
    expect(types).toEqual(expect.arrayContaining(["plan", "finding", "path"]));
    expect(types).not.toContain("error");

    // Saved as a finished, answered turn; the thread now holds it and no longer shows it running.
    const row = await savedTurn(session.turnId);
    expect(row).toEqual({ s: "ok", e: null, a: (SCRIPTS["chief-of-staff:synthesis"] as { preText: string }).preText });
    const after = await (await app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as SessionDetailDto;
    expect(after.running).toBeUndefined();
    expect(after.turns.map((t) => t.id)).toContain(session.turnId);
    expect(await (await app.request("/api/mini/turns/live")).json()).toEqual([]);

    // A server that never ran it (a restart) answers from the stored log.
    const stored = await eventsPage(h.make(), session.turnId, 0);
    expect(stored).toMatchObject({ status: "done", done: true });
    expect(stored.events).toEqual(compactEvents(seen));
  });

  it("holds the live slot until the turn ends, not until its client leaves", async () => {
    useRuntime(slowPlan(800));
    const app = h.make({ maxLiveAsks: 1 });
    const { session, hangUp } = await openTurn(app, "What is waiting on me this week?");
    await hangUp();
    expect((await post(app, "/api/mini/ask", { question: QUESTION })).status).toBe(429);
    expect((await savedTurn(session.turnId))?.s).toBe("ok");
    for (let i = 0; i < 20 && (await (await app.request("/api/mini/turns/live")).json() as unknown[]).length; i++) await new Promise((r) => setTimeout(r, 50));
    const next = await post(app, "/api/mini/ask", { question: QUESTION });
    expect(next.status).toBe(200);
    await next.text();
  });

  it("an explicit stop aborts the turn: the stream ends with `final` and it is saved as stopped", async () => {
    // The Chief's plan waits 30 s; the owner presses Stop first.
    useRuntime(slowPlan(30_000));
    const app = h.make();
    const { session, rest } = await openTurn(app, "Who owns the sitemap fix?");
    const t0 = Date.now();
    const stop = await post(app, `/api/mini/turns/${encodeURIComponent(session.turnId)}/stop`, {});
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ turnId: session.turnId, status: "stopping" });
    const events = sseEvents(await rest());
    expect(events.at(-1)?.type).toBe("final");
    expect(await savedTurn(session.turnId)).toMatchObject({ s: "failed", e: STOPPED_MESSAGE });
    expect(Date.now() - t0).toBeLessThan(20_000); // well before the 30 s plan would have finished
    const page = await eventsPage(app, session.turnId, 0);
    expect(page).toMatchObject({ status: "stopped", done: true });
    // the thread says it was stopped (a reload shows "Stopped", not an empty answer)
    const thread = await (await app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as SessionDetailDto;
    expect(thread.turns.find((t) => t.id === session.turnId)).toMatchObject({ ended: "stopped", error: STOPPED_MESSAGE });
    expect(thread.turns.filter((t) => t.ended === undefined).every((t) => t.error === undefined)).toBe(true);

    // Stopping a finished turn changes nothing; an unknown one is a 404; public mode refuses.
    expect(await (await post(app, `/api/mini/turns/${encodeURIComponent(session.turnId)}/stop`, {})).json()).toEqual({ turnId: session.turnId, status: "stopped" });
    expect((await post(app, "/api/mini/turns/turn%3Anope/stop", {})).status).toBe(404);
    expect((await post(h.make({ publicMode: true }), `/api/mini/turns/${encodeURIComponent(session.turnId)}/stop`, {})).status).toBe(403);
  });

  it("the events endpoint: 404 for an unknown turn, 400 for a bad cursor", async () => {
    expect((await h.app.request("/api/mini/turns/turn%3Anope/events")).status).toBe(404);
    expect((await h.app.request("/api/mini/turns/turn%3Anope/events?after=-1")).status).toBe(400);
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

describe("server: a direct chat with one agent (integration)", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); }, 90_000);
  afterAll(async () => h.cleanup());
  afterEach(() => resetRuntime());

  const SCRIPT = {
    ...SCRIPTS,
    "librarian:direct": {
      calls: [{ name: "trace_decision", args: { id: "decision:007-pause-daily-stories" } }],
      text: "We paused daily stories on 20 Sep 2026 [[decision:007-pause-daily-stories]], as of 20 Sep 2026.",
    },
  };

  it("sends the request to that agent only, saves the thread against it and lists it with its agent", async () => {
    useRuntime(() => new FakeRuntime(SCRIPT));
    const res = await post(h.app, "/api/mini/ask", { question: QUESTION, target: "librarian" });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    const final = events.at(-1) as Extract<AgentEvent, { type: "final" }>;
    expect(final.type).toBe("final");
    expect(final.agents).toEqual(["librarian"]);
    expect(events.some((e) => e.type === "plan")).toBe(false);
    expect(events.filter((e) => e.type === "text").every((e) => (e as { agent: string }).agent === "librarian")).toBe(true);
    // the Chief's checks still ran on the answer
    expect(final.checks.citationsValid).toBe(true);

    const session = events[0] as Extract<AgentEvent, { type: "session" }>;
    const threads = await (await h.app.request("/api/mini/sessions")).json() as SessionSummaryDto[];
    expect(threads.find((t) => t.id === session.sessionId)).toMatchObject({ agent: "librarian", turns: 1 });
    const detail = await (await h.app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as SessionDetailDto;
    expect(detail.agent).toBe("librarian");
    expect(detail.turns[0]).toMatchObject({ target: "librarian", source: "web" });
  });

  it("refuses somebody who is not on the team, and a thread with the whole team has no agent", async () => {
    const bad = await post(h.app, "/api/mini/ask", { question: "Hi", target: "nobody" });
    expect(bad.status).toBe(400);
    const res = await post(h.app, "/api/mini/ask", { question: QUESTION, target: "chief-of-staff" });
    const events = sseEvents(await res.text());
    const session = events[0] as Extract<AgentEvent, { type: "session" }>;
    const threads = await (await h.app.request("/api/mini/sessions")).json() as SessionSummaryDto[];
    expect(threads.find((t) => t.id === session.sessionId)?.agent).toBeUndefined();
  });

  it("says plainly when the agent is switched off", async () => {
    const patch = (enabled: boolean) => h.app.request("/api/mini/agents/librarian", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    await patch(false);
    const res = await post(h.app, "/api/mini/ask", { question: "Who knows about the sitemap?", target: "librarian" });
    const events = sseEvents(await res.text());
    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(err?.message).toMatch(/Memory Keeper is switched off/);
    expect(events.at(-1)?.type).toBe("final");
    await patch(true);
  });
});

describe("tone (chat support)", () => {
  it("each tone the chat offers reads as one standing instruction for that person, nothing left unread", async () => {
    const h = await harness();
    try {
      const { TONES, toneDirective } = await import("../../web/src/lib/chat.js");
      for (const tone of TONES) {
        const res = await post(h.app, "/api/mini/directives", { text: toneDirective("Miss Influencer", tone) });
        expect(res.status, tone.id).toBe(200);
        const pv = await res.json() as { diff: Array<{ op: string; label: string }>; unparsed: string[] };
        expect(pv.unparsed, tone.id).toEqual([]);
        const added = pv.diff.filter((d) => d.op === "add").map((d) => d.label);
        expect(added.length, tone.id).toBeGreaterThan(0);
        expect(added.every((l) => /Miss Influencer/.test(l)), `${tone.id}: ${added.join("; ")}`).toBe(true); // only ever about the person asked
      }
    } finally {
      await h.cleanup();
    }
  }, 60_000);
});
