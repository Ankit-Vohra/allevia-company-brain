// Typed client for the Allevia API (src/server, spec Milestone 4.1). The app talks to the live API by default. Every
// function has a mock twin in ./mock, used with ?mock=1, or when GET /api/health fails (no server, or no database), so the
// demo still runs offline.
import type { AgentEvent, AgentId, OnboardEvent } from "@shared/contracts";
import { ApiError, errorFrom, postSse, postSseForm } from "./lib/sse";

const STUDIO_LIVE_ONLY = "The Studio needs the live server: the photos, Tara's and Nisha's checks and the edits all run there.";

/** GET /api/:t/studio/latest: the last Studio run's events and where its card stands. */
export interface StudioLatest {
  run: null | {
    assetId: string;
    at: number;
    note: string;
    events: AgentEvent[];
    approval: { id: string; status: string; result: string | null; contentId: string | null } | null;
  };
}
import type {
  AgentDetail, AgentSummary, Approval, ApprovalDecision, GraphData, NodeDetail, OnboardRequest, Overview, Recommendation,
  SearchHit, SessionDetail, SessionSummary, Tenant,
} from "./types-ext";

export type ApiMode = "live" | "mock";

let mode: ApiMode = "live";
let publicMode = false;
let speed = 1;
export const getMode = () => mode;
/** The server is the public read-only demo: approvals and onboarding are refused, Ask replays recorded threads. */
export const getPublicMode = () => publicMode;
export const getSpeed = () => speed;
export const setSpeed = (s: number) => { speed = s; };

type MockApi = typeof import("./mock").mockApi;
let mockPromise: Promise<MockApi> | null = null;
const mock = () => (mockPromise ??= import("./mock").then((m) => m.mockApi));

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" }, ...init });
  if (!res.ok) throw await errorFrom(res, path);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new ApiError(`${path} did not return JSON`, res.status);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Decide live vs mock once, at startup: live unless ?mock=1, or the API's health check fails. */
export async function detectMode(): Promise<{ mode: ApiMode; tenants: Tenant[] }> {
  const params = new URLSearchParams(location.search);
  const useMock = async () => {
    mode = "mock";
    return { mode, tenants: await (await mock()).tenants() };
  };
  if (params.get("mock") === "1") return useMock();
  try {
    const health = await withTimeout(2500, (signal) => getJson<{ ok: boolean; publicMode?: boolean }>("/api/health", { signal }));
    if (!health.ok) throw new Error("unhealthy");
    publicMode = health.publicMode === true;
    const tenants = await withTimeout(8000, (signal) => getJson<Tenant[]>("/api/tenants", { signal }));
    // A live server with no business yet still needs one to show: the demo data stands in until onboarding adds one.
    if (!Array.isArray(tenants) || tenants.length === 0) return useMock();
    mode = "live";
    return { mode, tenants };
  } catch {
    return useMock();
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
    if (mode === "mock") return (await mock()).node(t, id);
    try {
      return await getJson<NodeDetail>(`/api/${enc(t)}/node/${enc(id)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null; // a cited id that is not in the graph
      throw e;
    }
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

  // ---- Studio (live server only: the photos, the vision checks and the edits live there) ----

  /** POST /api/:t/studio/intake (multipart), an SSE stream of AgentEvent. */
  async studioIntake(t: string, photo: Blob, note: string, onEvent: (e: AgentEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    const form = new FormData();
    form.append("photo", photo, "photo.jpg");
    if (note.trim()) form.append("note", note.trim());
    return postSseForm<AgentEvent>(`/api/${enc(t)}/studio/intake`, form, onEvent, opts.signal);
  },
  async studioLatest(t: string): Promise<StudioLatest> {
    if (mode === "mock") return { run: null };
    return getJson(`/api/${enc(t)}/studio/latest`);
  },
  async studioApprove(t: string, body: { approvalId: string; variantId?: string; caption?: string }): Promise<{ contentId: string; status: string; variantId: string; approval: Approval | null }> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    return getJson(`/api/${enc(t)}/studio/approve`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
    });
  },
  async studioSample(t: string): Promise<{ note: string; caption: string; url: string } | null> {
    if (mode === "mock") return null;
    try {
      return await getJson(`/api/${enc(t)}/studio/sample`);
    } catch {
      return null;
    }
  },

  /** POST /api/onboard, an SSE stream of OnboardEvent. */
  async onboard(req: OnboardRequest, onEvent: (e: OnboardEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (mode === "mock") return (await mock()).onboard(req, onEvent, { speed: getSpeed, signal: opts.signal });
    return postSse<OnboardEvent>("/api/onboard", req, onEvent, opts.signal);
  },
};
