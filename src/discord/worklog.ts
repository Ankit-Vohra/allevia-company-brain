// The live work log in a Discord thread (spec §16.3): one message, edited as the agents work, that says who is active
// and on which step ("Kabir · Checking the signups trend"). WorkLogState folds the AgentEvent stream into that text;
// ThrottledEditor edits the message at most once per interval (1.5 s by default, inside Discord's edit rate limits),
// always ending on the latest text, and never runs two edits at once.
import { agentById } from "../../shared/roster.js";
import type { AgentEvent } from "../../shared/contracts.js";
import { DISCORD_MAX } from "./format.js";

type Phase = "waiting" | "active" | "done" | "failed";
interface Line { agent: string; phase: Phase; text: string; ms?: number }

const CHIEF = "chief-of-staff";
const ICON: Record<Phase, string> = { waiting: "⏳", active: "🟢", done: "✅", failed: "❌" };

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const nameOf = (id: string): string => agentById(id)?.name ?? id;
export const seconds = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

export class WorkLogState {
  private lines = new Map<string, Line>();
  private final?: { ms: number; agents: string[]; ok: boolean };

  private set(agent: string, phase: Phase, text: string, ms?: number): void {
    const prev = this.lines.get(agent);
    if (prev && (prev.phase === "done" || prev.phase === "failed") && phase === "waiting") return;
    this.lines.set(agent, { agent, phase, text: clip(oneLine(text), 90), ...(ms !== undefined ? { ms } : {}) });
  }

  apply(e: AgentEvent): void {
    switch (e.type) {
      case "session": this.set(CHIEF, "active", "Reading the question"); break;
      case "recall": this.set(CHIEF, "active", e.ids.length ? "Recalling what we already know" : "Nothing on record yet; planning"); break;
      case "plan":
        this.set(e.by, "active", e.steps.length > 1 ? `Handing out ${e.steps.length} steps` : "Handing out the work");
        for (const s of e.steps) if (!this.lines.has(s.agent)) this.set(s.agent, "waiting", `waiting: ${s.task}`);
        break;
      case "agent_start": this.set(e.agent, "active", e.task); break;
      case "agent_status": this.set(e.agent, "active", e.text); break;
      case "handoff": this.set(e.to, "active", `Picking up from ${nameOf(e.from)}`); break;
      case "finding": this.set(e.agent, "active", "Wrote a finding"); break;
      case "review": this.set(e.agent, "active", `Reviewed ${this.ownerOf(e.findingId)}'s finding: ${e.verdict.toUpperCase()}`); break;
      case "proposal": this.set(e.agent, "active", `Proposed: ${e.title}`); break;
      case "agent_done": this.set(e.agent, e.ok ? "done" : "failed", e.ok ? `done in ${seconds(e.ms)}` : `stopped after ${seconds(e.ms)}`, e.ms); break;
      case "text": if (this.lines.get(e.agent)?.text !== "Writing the answer") this.set(e.agent, "active", "Writing the answer"); break;
      case "error": if (e.agent) this.set(e.agent, "failed", `Hit a problem: ${e.message}`); break;
      case "final":
        this.final = { ms: e.ms, agents: e.agents, ok: !!e.answer.trim() };
        for (const l of this.lines.values()) {
          if (l.phase === "active") this.set(l.agent, "done", l.agent === CHIEF ? "wrote the answer" : "done");
          else if (l.phase === "waiting") this.set(l.agent, "failed", "not needed");
        }
        break;
      default: break;
    }
  }

  // "finding:t-data-analyst" was written by Kabir; finding ids end in the roster id.
  private ownerOf(findingId: string): string {
    const agent = [...this.lines.keys()].find((a) => findingId.endsWith(a));
    return agent ? nameOf(agent) : "a colleague";
  }

  render(): string {
    const f = this.final;
    const head = f
      ? `**Work log** · ${f.ok ? "done" : "stopped"} in ${seconds(f.ms)}${f.agents.length ? ` · ${f.agents.map(nameOf).join(", ")}` : ""}`
      : "**Work log** · working…";
    const lines = [...this.lines.values()].map((l) => `${ICON[l.phase]} ${nameOf(l.agent)} · ${l.text}`);
    let out = [head, ...lines].join("\n");
    while (out.length > DISCORD_MAX && lines.length) { lines.shift(); out = [head, "…", ...lines].join("\n"); }
    return clip(out, DISCORD_MAX);
  }
}

export interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}
const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

// Edits one message with the latest text, at most once per `intervalMs`, one edit at a time. update() is cheap to call
// on every event: text that arrives inside the interval waits for the next slot, and only the newest text is sent.
// flush() sends the latest text in the next slot and resolves once it is shown. A failed edit is reported to onError
// and does not stop later ones.
export class ThrottledEditor {
  private shown: string | undefined;
  private latest: string | undefined;
  private lastAt = -Infinity;
  private timer: unknown;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private edit: (text: string) => Promise<unknown>,
    private intervalMs = 1500,
    private timers: Timers = realTimers,
    private onError: (e: unknown) => void = () => {},
  ) {}

  private wait(): number { return Math.max(0, this.lastAt + this.intervalMs - this.timers.now()); }

  update(text: string): void {
    this.latest = text;
    if (this.timer !== undefined || text === this.shown) return;
    this.timer = this.timers.setTimeout(() => { this.timer = undefined; void this.push(); }, this.wait());
  }

  // Edits run one after another; each sends whatever is newest when its turn comes.
  private push(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const text = this.latest;
      if (text === undefined || text === this.shown) return;
      this.lastAt = this.timers.now();
      this.shown = text;
      try { await this.edit(text); } catch (e) { this.onError(e); }
    });
    return this.chain;
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) { this.timers.clearTimeout(this.timer); this.timer = undefined; }
    await this.chain;
    if (this.latest === undefined || this.latest === this.shown) return;
    const wait = this.wait();
    if (wait > 0) await new Promise<void>((r) => { this.timers.setTimeout(r, wait); });
    if (this.timer !== undefined) { this.timers.clearTimeout(this.timer); this.timer = undefined; }
    await this.push();
  }
}
