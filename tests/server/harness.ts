// Harness for server tests: createApp over a seeded throwaway graph (seedMini plus the AI roster), one registered tenant
// ("mini") whose graph is that graph, and ask() deps from the real wiring with a scripted FakeRuntime.
import type { Hono } from "hono";
import type { AgentEvent } from "../../shared/contracts.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime, type AgentRuntime, type FakeScript } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { createApp, type RegistryTenant, type ServerDeps } from "../../src/server/app.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

export const TENANT: RegistryTenant = {
  slug: "mini", name: "Mini Jobs", businessId: "business:aamdani", domain: "mini.example", industry: "jobs",
};

// One desk (the Librarian) traces the decision; the Chief answers and draws the path.
export const SCRIPTS: Record<string, FakeScript> = {
  "chief-of-staff:plan": { structured: { rationale: "A decision question", steps: [{ agent: "librarian", task: "Trace why we paused daily stories" }] } },
  "librarian:work": {
    calls: [{ name: "trace_decision", args: { id: "decision:007-pause-daily-stories" } }],
    structured: { text: "We paused daily stories [[decision:007-pause-daily-stories]] after the September report.", citations: ["decision:007-pause-daily-stories"] },
  },
  "chief-of-staff:synthesis": {
    preText: "We paused daily stories on 20 Sep 2026 [[decision:007-pause-daily-stories]], as of 20 Sep 2026.",
    calls: [{ name: "show_path", args: { ids: ["decision:007-pause-daily-stories", "document:adr-007"] } }],
  },
};

export interface Harness {
  g: GraphHandle;
  app: Hono;
  make: (over?: Partial<ServerDeps>) => Hono;
  askCalls: Array<{ tenant: string; timeZone?: string }>;
  cleanup: () => Promise<void>;
}

// The runtime each live turn gets; a test may swap it (e.g. for one that waits).
let runtime: () => AgentRuntime = () => new FakeRuntime(SCRIPTS);
export const useRuntime = (make: () => AgentRuntime): void => { runtime = make; };
export const resetRuntime = (): void => { runtime = () => new FakeRuntime(SCRIPTS); };

export async function harness(): Promise<Harness> {
  const { g, cleanup } = await seededGraph();
  await ensureRoster(g, { businessId: TENANT.businessId }, SEED_NOW);
  await upsertNode(g, {
    type: "Business", id: TENANT.businessId, name: "Aamdani",
    props: { country: "India", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata" },
  }, SEED_NOW);
  const askCalls: Harness["askCalls"] = [];
  let clock = SEED_NOW + 3_600_000;
  const make = (over: Partial<ServerDeps> = {}): Hono => createApp({
    publicMode: false,
    listTenants: async () => [TENANT],
    openGraph: async (slug) => {
      if (slug !== TENANT.slug) throw new Error(`no graph for ${slug}`);
      return g;
    },
    askDeps: async (tenant, o) => {
      askCalls.push({ tenant, ...(o.timeZone ? { timeZone: o.timeZone } : {}) });
      const deps = await createAskDeps({ tenant }, { graph: g, runtime: runtime(), embedQuery: async (t) => fakeEmbed(t) });
      return { ...deps, now: () => (clock += 60_000) };
    },
    embedQuery: async () => async (t: string) => fakeEmbed(t),
    heartbeatMs: 0,
    replaySpeed: 0,
    now: () => SEED_NOW + 3_600_000,
    log: process.env.DEBUG_API ? (l: string) => console.error(l) : () => {},
    ...over,
  });
  return { g, app: make(), make, askCalls, cleanup };
}

export interface SseBlock { event: string; data: string; raw: string }

// Splits an SSE body into blocks exactly as framed (`event: x\ndata: y\n\n`), keeping the raw text for framing checks.
export function sseBlocks(body: string): SseBlock[] {
  return body.split("\n\n").filter((b) => b.trim() && !b.startsWith(":")).map((raw) => {
    const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
    const data = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    return { event, data, raw };
  });
}

export const sseEvents = (body: string): AgentEvent[] => sseBlocks(body).map((b) => JSON.parse(b.data) as AgentEvent);

export const post = (app: Hono, path: string, body: unknown, init: RequestInit = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
