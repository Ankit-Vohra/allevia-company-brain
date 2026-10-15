// LiveTurns (src/server/turns.ts) without a graph: a turn is found by the id its `session` event carries, followers
// attach from any index and leave without stopping it, stop() and the time cap abort it, and finished turns expire.
import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { LiveTurns } from "../../src/server/turns.js";

const session = (turnId: string): AgentEvent => ({ type: "session", tenant: "mini", sessionId: `session:${turnId}`, turnId, question: "q" });
const status = (text: string): AgentEvent => ({ type: "agent_status", agent: "librarian", text });

// A turn that emits `session`, then one status per tick until it is told to finish or its signal aborts.
function scripted() {
  let finish!: (ok: boolean) => void;
  let emit!: (e: AgentEvent) => void;
  let signal!: AbortSignal;
  const run = (e: (x: AgentEvent) => void, s: AbortSignal) => {
    emit = e; signal = s;
    e(session("turn:1"));
    return new Promise<{ ok: boolean }>((resolve) => {
      finish = (ok) => resolve({ ok });
      s.addEventListener("abort", () => resolve({ ok: false }), { once: true });
    });
  };
  return { run, emit: (e: AgentEvent) => emit(e), finish: (ok: boolean) => finish(ok), signal: () => signal };
}

describe("LiveTurns", () => {
  it("finds a turn by its id, replays to late followers, and a follower leaving does not stop it", async () => {
    const turns = new LiveTurns({ now: () => 1_000 });
    const s = scripted();
    const t = turns.start("mini", "q", s.run);
    expect(turns.get("mini", "turn:1")).toBe(t);
    expect(turns.get("other", "turn:1")).toBeUndefined();
    expect(turns.running("mini").map((x) => x.dto())).toEqual([{ turnId: "turn:1", sessionId: "session:turn:1", question: "q", startedAt: new Date(1_000).toISOString(), status: "running" }]);

    s.emit(status("one"));
    const early: AgentEvent[] = [];
    const leave = new AbortController();
    const following = t.follow(0, (e) => early.push(e), leave.signal);
    s.emit(status("two"));
    leave.abort();
    await following;
    s.emit(status("three"));
    expect(early.map((e) => e.type === "agent_status" ? e.text : e.type)).toEqual(["session", "one", "two"]);
    expect(s.signal().aborted).toBe(false);

    const late: AgentEvent[] = [];
    const tail = t.follow(2, (e) => late.push(e), new AbortController().signal);
    s.finish(true);
    await tail;
    expect(late.map((e) => e.type === "agent_status" ? e.text : e.type)).toEqual(["two", "three"]);
    expect(t.status).toBe("done");
    expect(turns.running("mini")).toEqual([]);
    expect(turns.get("mini", "turn:1")?.status).toBe("done"); // still re-attachable for a while
  });

  it("stop() aborts the run and ends it as stopped; a run that fails ends as failed", async () => {
    const turns = new LiveTurns();
    const s = scripted();
    const t = turns.start("mini", "q", s.run);
    t.stop("stopped by the owner");
    await t.done;
    expect(s.signal().aborted).toBe(true);
    expect(t.status).toBe("stopped");

    const f = turns.start("mini", "q", (e) => { e(session("turn:2")); return Promise.reject(new Error("boom")); });
    await f.done;
    expect(f.status).toBe("failed");
  });

  it("stops a turn that runs past the time cap", async () => {
    const turns = new LiveTurns({ maxTurnMs: 30 });
    const s = scripted();
    const t = turns.start("mini", "q", s.run);
    await t.done;
    expect(t.status).toBe("stopped");
    expect(String((s.signal().reason as Error).message)).toMatch(/time limit/);
  });

  it("forgets finished turns after keepMs, and keeps at most maxKept of them", async () => {
    const turns = new LiveTurns({ keepMs: 0, maxKept: 1 });
    const a = turns.start("mini", "q", (e) => { e(session("turn:a")); return Promise.resolve({ ok: true }); });
    await a.done;
    await new Promise((r) => setTimeout(r, 5));
    expect(turns.get("mini", "turn:a")).toBeUndefined();

    const kept = new LiveTurns({ maxKept: 1 });
    for (const id of ["turn:x", "turn:y", "turn:z"]) await kept.start("mini", "q", (e) => { e(session(id)); return Promise.resolve({ ok: true }); }).done;
    kept.start("mini", "q", (e) => { e(session("turn:w")); return new Promise(() => {}); });
    expect(["turn:x", "turn:y", "turn:z"].map((id) => !!kept.get("mini", id))).toEqual([false, false, true]);
    expect(kept.get("mini", "turn:w")?.running).toBe(true);
  });
});
