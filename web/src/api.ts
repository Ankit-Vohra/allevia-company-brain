// Typed client for the Allevia API (spec Milestone 4.1). Every function has a mock twin in ./mock; the app runs in mock
// mode with ?mock=1, or automatically when GET /api/tenants does not answer.
import type { AgentEvent, AgentId, OnboardEvent } from "@shared/contracts";
import { postSse } from "./lib/sse";
import type {
  AgentDetail, AgentSummary, Approval, ApprovalDecision, GraphData, NodeDetail, OnboardRequest, Overview, Recommendation,
  SearchHit, SessionDetail, SessionSummary, Tenant,
} from "./types-ext";

export type ApiMode = "live" | "mock";

let mode: ApiMode = "live";
let speed = 1;
export const getMode = () => mode;
export const getSpeed = () => speed;
export const setSpeed = (s: number) => { speed = s; };

type MockApi = typeof import("./mock").mockApi;
let mockPromise: Promise<MockApi> | null = null;
const mock = () => (mockPromise ??= import("./mock").then((m) => m.mockApi));

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" }, ...init });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error(`${path} did not return JSON`);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

/** Decide live vs mock once, at startup. */
export async function detectMode(): Promise<{ mode: ApiMode; tenants: Tenant[] }> {
  const params = new URLSearchParams(location.search);
  if (params.get("mock") === "1") {
    mode = "mock";
    return { mode, tenants: await (await mock()).tenants() };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const tenants = await getJson<Tenant[]>("/api/tenants", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!Array.isArray(tenants) || tenants.length === 0) throw new Error("no tenants");
    mode = "live";
    return { mode, tenants };
  } catch {
    mode = "mock";
    return { mode, tenants: await (await mock()).tenants() };
  }
}

export const api = {
  async tenants(): Promise<Tenant[]> {
    return mode === "mock" ? (await mock()).tenants() : getJson("/api/tenants");
  },
  async overview(t: string): Promise<Overview> {
    return mode === "mock" ? (await mock()).overview(t) : getJson(`/api/${enc(t)}/overview`);
  },
  async sessions(t: string): Promise<SessionSummary[]> {
    return mode === "mock" ? (await mock()).sessions(t) : getJson(`/api/${enc(t)}/sessions`);
  },
  async session(t: string, id: string): Promise<SessionDetail> {
    return mode === "mock" ? (await mock()).session(t, id) : getJson(`/api/${enc(t)}/sessions/${enc(id)}`);
  },
  async replay(t: string, turnId: string): Promise<AgentEvent[]> {
    return mode === "mock" ? (await mock()).replay(t, turnId) : getJson(`/api/${enc(t)}/turns/${enc(turnId)}/replay`);
  },
  async search(t: string, q: string): Promise<SearchHit[]> {
    return mode === "mock" ? (await mock()).search(t, q) : getJson(`/api/${enc(t)}/search?q=${enc(q)}`);
  },
  async node(t: string, id: string): Promise<NodeDetail | null> {
    return mode === "mock" ? (await mock()).node(t, id) : getJson(`/api/${enc(t)}/node/${enc(id)}`);
  },
  async graph(t: string, focus: string, depth = 1): Promise<GraphData> {
    return mode === "mock" ? (await mock()).graph(t, focus, depth) : getJson(`/api/${enc(t)}/graph?focus=${enc(focus)}&depth=${depth}`);
  },
  async graphOverview(t: string): Promise<GraphData> {
    return mode === "mock" ? (await mock()).graphOverview(t) : getJson(`/api/${enc(t)}/graph/overview`);
  },
  async agents(t: string): Promise<AgentSummary[]> {
    return mode === "mock" ? (await mock()).agents(t) : getJson(`/api/${enc(t)}/agents`);
  },
  async agent(t: string, id: AgentId): Promise<AgentDetail> {
    return mode === "mock" ? (await mock()).agent(t, id) : getJson(`/api/${enc(t)}/agents/${enc(id)}`);
  },
  async recommendations(t: string): Promise<Recommendation[]> {
    return mode === "mock" ? (await mock()).recommendations(t) : getJson(`/api/${enc(t)}/recommendations`);
  },
  async approvals(t: string): Promise<Approval[]> {
    return mode === "mock" ? (await mock()).approvals(t) : getJson(`/api/${enc(t)}/approvals`);
  },
  async decide(t: string, id: string, d: ApprovalDecision): Promise<Approval> {
    if (mode === "mock") return (await mock()).decide(t, id, d);
    return getJson(`/api/${enc(t)}/approvals/${enc(id)}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(d),
    });
  },

  /** POST /api/:t/ask, an SSE stream of AgentEvent. `seekMs` (mock only) fast-forwards a scripted run. */
  async ask(t: string, body: { question: string; sessionId?: string }, onEvent: (e: AgentEvent) => void, opts: { signal?: AbortSignal; seekMs?: number } = {}): Promise<void> {
    if (mode === "mock") return (await mock()).ask(t, body, onEvent, { speed: getSpeed, signal: opts.signal, seekMs: opts.seekMs });
    return postSse<AgentEvent>(`/api/${enc(t)}/ask`, body, onEvent, opts.signal);
  },

  /** POST /api/onboard, an SSE stream of OnboardEvent. */
  async onboard(req: OnboardRequest, onEvent: (e: OnboardEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (mode === "mock") return (await mock()).onboard(req, onEvent, { speed: getSpeed, signal: opts.signal });
    return postSse<OnboardEvent>("/api/onboard", req, onEvent, opts.signal);
  },
};
