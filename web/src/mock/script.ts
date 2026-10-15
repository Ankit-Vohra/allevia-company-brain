// A tiny DSL for writing timed AgentEvent scripts. Each agent works on its own Track (its own clock) and the tracks are
// merged by time, which is how parallel desks interleave in a real run.
import type { AgentEvent, AgentId, EdgeRef, TurnChecks } from "@shared/contracts";
import { type MockGraph, refs, slice } from "./graph-kit";

export interface TimedEvent { at: number; event: AgentEvent }

export class Track {
  constructor(public t: number, private readonly out: TimedEvent[], private readonly g: MockGraph, private readonly agent: AgentId) {}

  at(t: number) { this.t = t; return this; }
  wait(ms: number) { this.t += ms; return this; }
  emit(event: AgentEvent, dt = 0) { this.t += dt; this.out.push({ at: this.t, event }); return this; }

  start(task: string, dt = 0) { return this.emit({ type: "agent_start", agent: this.agent, task }, dt); }
  status(text: string, dt = 300) { return this.emit({ type: "agent_status", agent: this.agent, text }, dt); }
  done(ms: number, dt = 250) { return this.emit({ type: "agent_done", agent: this.agent, ms, ok: true }, dt); }
  handoff(to: AgentId, note: string, dt = 250) { return this.emit({ type: "handoff", from: this.agent, to, note }, dt); }

  tool(name: string, args: unknown, ms: number, summary: string, ids: string[], dt = 400) {
    const id = `${this.agent}-${name}-${Math.round(this.t + dt)}`;
    this.emit({ type: "tool_call", agent: this.agent, id, name, args }, dt);
    const s = slice(this.g, ids);
    return this.emit({ type: "tool_result", agent: this.agent, id, name, summary, nodes: s.nodes, edges: s.edges, sources: s.sources }, ms);
  }

  finding(findingId: string, text: string, basedOn?: string[], dt = 500) {
    return this.emit({ type: "finding", agent: this.agent, findingId, text, citations: citationsIn(text), basedOn }, dt);
  }

  review(findingId: string, verdict: "ok" | "fix" | "reject", note: string, dt = 500) {
    return this.emit({ type: "review", agent: this.agent, findingId, verdict, note }, dt);
  }

  /** Stream markdown as the Chief of Staff types it: a few words per delta. */
  stream(text: string, msPerChunk = 85, dt = 200) {
    this.t += dt;
    const tokens = text.match(/\S+\s*/g) ?? [];
    let seed = 7;
    for (let i = 0; i < tokens.length; ) {
      seed = (seed * 9301 + 49297) % 233280;
      const n = 1 + (seed % 3);
      const delta = tokens.slice(i, i + n).join("");
      i += n;
      this.emit({ type: "text", agent: this.agent, delta }, msPerChunk + (seed % 40) - 20);
    }
    return this;
  }

  path(ids: string[], dt = 400) {
    const edges: EdgeRef[] = [];
    for (let i = 0; i < ids.length - 1; i++) {
      const a = ids[i]!, b = ids[i + 1]!;
      const e = this.g.edges.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
      if (e) edges.push(e);
    }
    return this.emit({ type: "path", nodes: refs(this.g, ids), edges }, dt);
  }
}

export const citationsIn = (text: string) => [...new Set([...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!))];

export const ALL_GOOD: TurnChecks = {
  citationsValid: true, invalidCitations: [],
  numbersGrounded: true, ungroundedNumbers: [],
  simulatedDisclosed: true, freshnessDisclosed: true, modeDisclosed: true,
};

export interface ScriptSpec {
  tenant: string;
  key: string;
  question: string;
  match: RegExp;
  build: (s: ScriptBuilder) => void;
}

export class ScriptBuilder {
  readonly events: TimedEvent[] = [];
  constructor(readonly g: MockGraph) {}
  track(agent: AgentId, t = 0) { return new Track(t, this.events, this.g, agent); }
  sorted(): TimedEvent[] {
    return [...this.events].sort((a, b) => a.at - b.at);
  }
}

/** Turn a spec into its timed events, with session ids filled in and a `final` computed from what was streamed. */
export function compile(spec: ScriptSpec, g: MockGraph, ids: { sessionId: string; turnId: string }, checks: TurnChecks = ALL_GOOD): TimedEvent[] {
  const b = new ScriptBuilder(g);
  b.events.push({ at: 0, event: { type: "session", tenant: spec.tenant, sessionId: ids.sessionId, turnId: ids.turnId, question: spec.question } });
  spec.build(b);
  const events = b.sorted();
  const answer = events.map((x) => (x.event.type === "text" ? x.event.delta : "")).join("");
  const agents = [...new Set(events.flatMap((x) => (x.event.type === "agent_start" ? [x.event.agent] : [])))];
  const last = events[events.length - 1]?.at ?? 0;
  events.push({
    at: last + 300,
    event: { type: "final", turnId: ids.turnId, answer, citations: citationsIn(answer), checks, agents, ms: last + 300 },
  });
  return events;
}
