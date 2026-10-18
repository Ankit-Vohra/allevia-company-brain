// Typed client for the Allevia API (src/server, spec Milestone 4.1). The app talks to the live API by default. Every
// function has a mock twin in ./mock, used with ?mock=1, or when GET /api/health fails (no server, or no database), so the
// demo still runs offline.
import type { AgentEvent, AgentId, OnboardEvent } from "@shared/contracts";
import { ApiError, errorFrom, postSse, postSseForm } from "./lib/sse";
import type { BillingCycle, BillingResultDto, CreditsDto, SubscriptionDto } from "@shared/credits";
import type { PlanId } from "@shared/plans";
import type { WeekDto } from "@shared/week";
import { consumeLinkInAddressBar } from "./lib/link";
import { accountApi, type Account } from "./lib/account";
import type { PhotoChange } from "./lib/library";

import { mockConnections } from "./mock/connections";
const CONNECT_LIVE_ONLY = "Connecting Search Console needs the live server.";
const CHECKUP_LIVE_ONLY = "The website check-up needs the live server.";
const NUMBERS_LIVE_ONLY = "Adding your numbers needs the live server: your file is read and kept there.";
const STUDIO_LIVE_ONLY = "Making a post from a photo needs the live server: the photos, Miss Influencer's and Fact Checker's checks and the edits all run there.";

import type { AgentMode, CapabilityState, DirectivePreview, DiscordHome, LearnedRuleDto, LibraryDto, Lineage, ProgramScorecard } from "@shared/contracts";
import type {
  ConnectionRow, ConnectionsPage, ConnectStart,
  PostView, AgentDetail, AgentSummary, AgentView, Approval, ApprovalDecision, Brief, DecisionResult, GoalSetup, GraphData, LearningFeed, LiveTurn, NodeDetail,
  CheckupStatus, ConnectorStatus, NumbersImportResult, NumbersPlan, NumbersPreview, OnboardRequest, Overview, Recommendation, SearchHit, SessionDetail, SessionSummary, Standup, Tenant, TurnEventsPage, Usage,
} from "./types-ext";

/** PATCH /api/:t/agents/:id */
export interface AgentPatch { enabled?: boolean; mode?: AgentMode; autonomy?: number; statusNote?: string | null; skillsOff?: string[] }

export type ApiMode = "live" | "mock";

let mode: ApiMode = "live";
let publicMode = false;
let speed = 1;
export const getMode = () => mode;
/** The server is the public read-only demo: approvals and onboarding are refused, Ask replays recorded threads. */
let tenantReadOnly = false;
/** The business on screen is a read-only demo for this browser (owner links on, no link for it): set whenever the business shown changes. */
export const setTenantReadOnly = (on: boolean): void => { tenantReadOnly = on; };
export const getPublicMode = () => publicMode || tenantReadOnly;
export const getSpeed = () => speed;
export const setSpeed = (s: number) => { speed = s; };

type MockApi = typeof import("./mock").mockApi;
let mockPromise: Promise<MockApi> | null = null;
const mock = () => (mockPromise ??= import("./mock").then((m) => m.mockApi));

/** Called when the server stops recognising this browser's sign-in (signed out elsewhere, expired): the app goes to sign in. */
let onSignedOut: (() => void) | null = null;
export const setSignedOutHandler = (fn: (() => void) | null): void => { onSignedOut = fn; };

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" }, ...init });
  if (res.status === 401 && onSignedOut) onSignedOut();
  if (!res.ok) throw await errorFrom(res, path);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new ApiError(`${path} did not return JSON`, res.status);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

/** A GET whose 404 means "not there yet" (no program, no brief), not a failure. */
async function getOrNull<T>(path: string): Promise<T | null> {
  try {
    return await getJson<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

const sendJson = <T>(path: string, method: string, body?: unknown): Promise<T> =>
  getJson<T>(path, {
    method, headers: { "content-type": "application/json", accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** What the app starts with. With sign-in on (ALLEVIA_AUTH=1): `authRequired`, and `account` when this browser is signed in.
 *  `needsLink`: an owner link was tried in the address bar and did not open. */
export interface MeetingCheck {
  recorders: Array<{ id: string; name: string; state: "connected" | "not_connected" | "needs_attention" | "failed"; message: string }>;
  saved: Array<{ recorder: string; title: string; ok: boolean; sessionId: string; turnId: string }>;
  skipped: Array<{ recorder: string; title: string; why: string }>;
}

export interface Startup { mode: ApiMode; tenants: Tenant[]; needsLink?: { failed: boolean }; authRequired?: boolean; account?: Account | null }

/** Decide live vs mock once, at startup: live unless ?mock=1, or the API's health check fails. */
export async function detectMode(): Promise<Startup> {
  const params = new URLSearchParams(location.search);
  const useMock = async (): Promise<Startup> => {
    mode = "mock";
    return { mode, tenants: await (await mock()).tenants() };
  };
  if (params.get("mock") === "1") return useMock();
  // An owner link in the address bar (#key=…) is opened first, so the list below already includes that business.
  const link = await consumeLinkInAddressBar();
  try {
    const health = await withTimeout(2500, (signal) => getJson<{ ok: boolean; publicMode?: boolean; authRequired?: boolean }>("/api/health", { signal }));
    if (!health.ok) throw new Error("unhealthy");
    publicMode = health.publicMode === true;
    const tenants = await withTimeout(8000, (signal) => getJson<Tenant[]>("/api/tenants", { signal }));
    // With sign-in on, the app starts from who this browser is: an account (or none), the businesses it may open, and the demos.
    // main.tsx sends a stranger to the sign-in page, unless they asked to look at the demo.
    if (health.authRequired) {
      mode = "live";
      const account = await withTimeout(8000, () => accountApi.me()).catch(() => null);
      return {
        mode, tenants: Array.isArray(tenants) ? tenants : [], authRequired: true, account,
        ...(link.seen && !link.opened ? { needsLink: { failed: true } } : {}),
      };
    }
    // A live server with no business yet still needs one to show: the demo data stands in until onboarding adds one.
    if (!Array.isArray(tenants) || tenants.length === 0) return useMock();
    mode = "live";
    return { mode, tenants };
  } catch {
    return useMock();
  }
}

export interface BrandAssetDto {
  id: string; kind: string; name: string; origin: string; mime: string | null; w: number | null; h: number | null; status: string;
  description: string | null; family: string | null; value: string | null; colours: string[]; needsBetter: boolean; containsPerson: boolean; url?: string;
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
  /** GET /api/:t/graph/at-work: the Brain page's "graph at work" panel. Live server only (null in mock mode). */
  async graphAtWork(t: string, focus?: string): Promise<import("./components/GraphAtWork").GraphAtWork | null> {
    return mode === "mock" ? null : getJson(`/api/${enc(t)}/graph/at-work${focus ? `?focus=${enc(focus)}` : ""}`);
  },
  /** GET /api/:t/graph/story: how the brain grew (the Brain page's "It keeps growing"). Live server only (null in mock mode). */
  async graphStory(t: string, by: "recorded" | "happened" = "recorded"): Promise<import("./components/GraphGrowth").GraphStoryDto | null> {
    return mode === "mock" ? null : getJson(`/api/${enc(t)}/graph/story?by=${by}`);
  },
  /** GET /api/:t/graph/map: the Brain map and Home's living brain, the `limit` most important things (light for a phone).
   *  Business knowledge only; `general` (the Brain page's "Show general know-how") draws the shared playbooks too. */
  async brainMap(t: string, limit = 400, general = false): Promise<import("./lib/brain-map").BrainMapDto> {
    return mode === "mock" ? (await mock()).brainMap(t, limit) : getJson(`/api/${enc(t)}/graph/map?limit=${limit}${general ? "&general=1" : ""}`);
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
  /** Where this business joins its team on Discord. `enabled: false` when the server has no Discord hub (and always in the mock). */
  async discord(t: string): Promise<DiscordHome> {
    return mode === "mock" ? { enabled: false } : getJson(`/api/${enc(t)}/discord`);
  },
  /** A fresh single-use join link; the old one stops working. */
  async discordNewLink(t: string): Promise<DiscordHome> {
    if (mode === "mock") return { enabled: false };
    return sendJson(`/api/${enc(t)}/discord/invite`, "POST", {});
  },
  // ---- posts to the owner's own accounts (src/server/routes/publish.ts) ----

  /** GET /api/:t/publish: what is scheduled and what went out lately. */
  async publishPosts(t: string): Promise<PostView[]> {
    if (mode === "mock") return [];
    return (await getJson<{ posts: PostView[] }>(`/api/${enc(t)}/publish`)).posts;
  },
  /** Try again on a post that did not go out (`anyway`: the owner has looked, and a post that may have gone out is not there). */
  async publishRetry(t: string, id: string, anyway = false): Promise<{ ok: boolean; message: string; post?: PostView }> {
    if (mode === "mock") throw new ApiError("Posting needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/publish/${enc(id)}/retry`, "POST", anyway ? { anyway: true } : {});
  },
  async publishCancel(t: string, id: string): Promise<{ ok: boolean; message: string; post?: PostView }> {
    if (mode === "mock") throw new ApiError("Posting needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/publish/${enc(id)}/cancel`, "POST", {});
  },
  async recommendations(t: string): Promise<Recommendation[]> {
    return mode === "mock" ? (await mock()).recommendations(t) : getJson(`/api/${enc(t)}/recommendations`);
  },
  async approvals(t: string): Promise<Approval[]> {
    return mode === "mock" ? (await mock()).approvals(t) : getJson(`/api/${enc(t)}/approvals`);
  },
  /** The decision, plus the `learned` events (one per rule an edit taught) and the Action the executor recorded. */
  async decide(t: string, id: string, d: ApprovalDecision): Promise<DecisionResult> {
    if (mode === "mock") return (await mock()).decide(t, id, d);
    return sendJson(`/api/${enc(t)}/approvals/${enc(id)}`, "POST", d);
  },

  // ---- Allevia 90, the capability ladder, the team and what it learned ----

  /** GET /api/:t/program: the "Your 90 days" scorecard; null until the business is enrolled. */
  async program(t: string): Promise<ProgramScorecard | null> {
    return mode === "mock" ? (await mock()).program(t) : getOrNull(`/api/${enc(t)}/program`);
  },
  /** GET /api/:t/goals/setup: the goals the team suggests, and which ones the owner has said OK to. */
  async goalSetup(t: string): Promise<GoalSetup[]> {
    if (mode === "mock") return (await mock()).goalSetup(t);
    return (await getJson<{ goals: GoalSetup[] }>(`/api/${enc(t)}/goals/setup`)).goals;
  },
  /** POST /api/:t/goals/:id: OK as suggested (no target), or OK with the owner's own number. */
  async setGoal(t: string, id: string, target?: number): Promise<GoalSetup> {
    if (mode === "mock") return (await mock()).setGoal(t, id, target);
    return sendJson(`/api/${enc(t)}/goals/${enc(id)}`, "POST", target === undefined ? { confirm: true } : { target });
  },
  async capabilities(t: string): Promise<CapabilityState[]> {
    return mode === "mock" ? (await mock()).capabilities(t) : getJson(`/api/${enc(t)}/capabilities`);
  },
  /** GET /api/:t/agents with settings: on, light or off, autonomy, the owner's instructions and learned rules. */
  async team(t: string): Promise<AgentView[]> {
    return mode === "mock" ? (await mock()).team(t) : getJson(`/api/${enc(t)}/agents`);
  },
  async setAgent(t: string, id: string, patch: AgentPatch): Promise<AgentView> {
    return mode === "mock" ? (await mock()).setAgent(t, id, patch) : sendJson(`/api/${enc(t)}/agents/${enc(id)}`, "PATCH", patch);
  },
  /** "Tell your team": the owner's words as typed patches and a diff. Nothing is written until apply. */
  async previewDirective(t: string, text: string): Promise<DirectivePreview> {
    return mode === "mock" ? (await mock()).previewDirective(t, text) : sendJson(`/api/${enc(t)}/directives`, "POST", { text });
  },
  async applyDirective(t: string, id: string): Promise<DirectivePreview & { errors?: string[] }> {
    return mode === "mock" ? (await mock()).applyDirective(t, id) : sendJson(`/api/${enc(t)}/directives/${enc(id)}/apply`, "POST");
  },
  async learning(t: string, since?: string): Promise<LearningFeed> {
    if (mode === "mock") return (await mock()).learning(t);
    return getJson(`/api/${enc(t)}/learning${since ? `?since=${enc(since)}` : ""}`);
  },
  /** Retire a learned rule: it stops applying to new drafts; the graph keeps it as a Version. */
  async retireRule(t: string, ruleId: string): Promise<LearnedRuleDto> {
    return mode === "mock" ? (await mock()).retireRule(t, ruleId) : sendJson(`/api/${enc(t)}/learning/${enc(ruleId)}`, "DELETE");
  },
  /** Take one of this business's own skill rules or skills out of use (the records keep it, retired). */
  async retireSkillNote(t: string, id: string): Promise<void> {
    if (mode === "mock") return;
    await sendJson(`/api/${enc(t)}/skill-notes/${enc(id)}`, "DELETE");
  },
  /** GET /api/:t/usage?month=YYYY-MM: Studio credits used, answers given, and the honest flags (billing, live actions). */
  async usage(t: string, month?: string): Promise<Usage> {
    if (mode === "mock") return (await mock()).usage(t, month);
    return getJson(`/api/${enc(t)}/usage${month ? `?month=${enc(month)}` : ""}`);
  },
  /** GET /api/:t/week: what the team did in the last 7 days, counted from the graph (Home's "this week" row). */
  async week(t: string): Promise<WeekDto> {
    if (mode === "mock") return (await mock()).week(t);
    return getJson(`/api/${enc(t)}/week`);
  },
  // ---- credits and the plan (src/server/routes/credits.ts) ----

  /** GET /api/:t/credits: this month's credits, what used them, and the price list. */
  async credits(t: string): Promise<CreditsDto> {
    if (mode === "mock") return (await import("./mock/credits")).mockCredits();
    return getJson(`/api/${enc(t)}/credits`);
  },
  /** GET /api/:t/subscription: the plan and how it is paid; null for anyone but the owner (a teammate, the demo). */
  async subscription(t: string): Promise<SubscriptionDto | null> {
    if (mode === "mock") return (await import("./mock/credits")).mockSubscription();
    try {
      return await getJson<SubscriptionDto>(`/api/${enc(t)}/subscription`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) return null;
      throw e;
    }
  },
  async changePlan(t: string, plan: PlanId, cycle: BillingCycle): Promise<BillingResultDto> {
    if (mode === "mock") return (await import("./mock/credits")).mockBilling("change", plan, cycle);
    return sendJson(`/api/${enc(t)}/subscription/change`, "POST", { plan, cycle });
  },
  async buyPack(t: string, packId = "pack100"): Promise<BillingResultDto> {
    if (mode === "mock") return (await import("./mock/credits")).mockBilling("pack");
    return sendJson(`/api/${enc(t)}/credits/packs`, "POST", { packId });
  },
  async pausePlan(t: string): Promise<BillingResultDto> {
    if (mode === "mock") return (await import("./mock/credits")).mockBilling("pause");
    return sendJson(`/api/${enc(t)}/subscription/pause`, "POST", {});
  },
  async cancelPlan(t: string): Promise<BillingResultDto> {
    if (mode === "mock") return (await import("./mock/credits")).mockBilling("cancel");
    return sendJson(`/api/${enc(t)}/subscription/cancel`, "POST", {});
  },

  /** GET /api/:t/brief: today's morning brief; null when none has been written. */
  async brief(t: string): Promise<Brief | null> {
    return mode === "mock" ? (await mock()).brief(t) : getOrNull(`/api/${enc(t)}/brief`);
  },
  /** GET /api/:t/standup: today's team stand-up (what the team noticed and drafted); null before it has run, and in the mock. */
  async standup(t: string): Promise<Standup | null> {
    return mode === "mock" ? null : getOrNull(`/api/${enc(t)}/standup`);
  },
  /** POST /api/:t/brief/run: bring the goals' readings up to date and write today's brief (no language model). */
  async runBrief(t: string): Promise<Brief> {
    return mode === "mock" ? (await mock()).runBrief(t) : sendJson(`/api/${enc(t)}/brief/run`, "POST");
  },

  // ---- live turns: they run on the server to the end even when the tab closes; only stopTurn cancels one ----

  /** GET /api/:t/turns/live: the business's turns still working on the server, newest first. */
  async liveTurns(t: string): Promise<LiveTurn[]> {
    return mode === "mock" || publicMode ? [] : getJson(`/api/${enc(t)}/turns/live`);
  },
  /** GET /api/:t/turns/:id/events?after=N: re-attach to a turn (live server only). */
  async turnEvents(t: string, turnId: string, after: number, signal?: AbortSignal): Promise<TurnEventsPage> {
    if (mode === "mock") throw new ApiError("Re-attaching to a turn needs the live server.", 501);
    return getJson(`/api/${enc(t)}/turns/${enc(turnId)}/events?after=${after}`, signal ? { signal } : undefined);
  },
  /** POST /api/:t/turns/:id/stop: the only way a live turn is cancelled. */
  async stopTurn(t: string, turnId: string): Promise<{ turnId: string; status: string }> {
    if (mode === "mock") throw new ApiError("Stopping a turn on the server needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/turns/${enc(turnId)}/stop`, "POST");
  },

  /** POST /api/:t/ask, an SSE stream of AgentEvent. `seekMs` (mock only) fast-forwards a scripted run. */
  async ask(t: string, body: { question: string; sessionId?: string; target?: AgentId }, onEvent: (e: AgentEvent) => void, opts: { signal?: AbortSignal; seekMs?: number } = {}): Promise<void> {
    if (mode === "mock") return (await mock()).ask(t, body, onEvent, { speed: getSpeed, signal: opts.signal, seekMs: opts.seekMs });
    return postSse<AgentEvent>(`/api/${enc(t)}/ask`, body, onEvent, opts.signal);
  },

  // ---- Photos, pictures and the Library (live server only: the photos, the vision checks and the edits live there) ----

  /** POST /api/:t/chat/photo (multipart): a photo sent in the chat with what the owner wants; the Studio's pipeline runs as a turn
   *  in the conversation and streams back like an ask. */
  async askWithPhoto(t: string, body: { photo: Blob; note: string; sessionId?: string; target?: AgentId }, onEvent: (e: AgentEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    const form = new FormData();
    form.append("photo", body.photo, body.photo instanceof File && body.photo.name ? body.photo.name : "photo.jpg");
    if (body.note.trim()) form.append("note", body.note.trim());
    if (body.sessionId) form.append("sessionId", body.sessionId);
    if (body.target) form.append("target", body.target);
    return postSseForm<AgentEvent>(`/api/${enc(t)}/chat/photo`, form, onEvent, opts.signal);
  },
  /** POST /api/:t/chat/photo/change: a change to a photo's card (the Studio's change path, or the clip the owner said yes to), as a
   *  turn in the photo's thread; streams back like an ask. */
  async changePhoto(t: string, body: PhotoChange, onEvent: (e: AgentEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    return postSse<AgentEvent>(`/api/${enc(t)}/chat/photo/change`, body, onEvent, opts.signal);
  },
  /** POST /api/:t/studio/clip without confirm: the price of a 5 second clip from one option (nothing is made). */
  async studioClipQuote(t: string, body: { approvalId: string; variantId?: string }): Promise<{ ok: boolean; message: string; words?: string; credits?: number; variantId?: string }> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    return getJson(`/api/${enc(t)}/studio/clip`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ ...body, confirm: false }),
    });
  },
  /** GET /api/:t/library: everything the team made and every photo the owner sent, newest first. */
  async library(t: string): Promise<LibraryDto> {
    if (mode === "mock") return { items: [] };
    return getJson(`/api/${enc(t)}/library`);
  },
  async studioApprove(t: string, body: { approvalId: string; variantId?: string; caption?: string }): Promise<{ contentId: string; status: string; variantId: string; approval: Approval | null }> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    return getJson(`/api/${enc(t)}/studio/approve`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
    });
  },
  /** GET /api/:t/studio/settings: "Blur people's faces in my content" (off by default) and the answer language. */
  async studioSettings(t: string): Promise<{ blurFaces: boolean; language: string }> {
    if (mode === "mock") return { blurFaces: false, language: "auto" };
    return getJson(`/api/${enc(t)}/studio/settings`);
  },
  async studioSetSettings(t: string, body: { blurFaces?: boolean; language?: string }): Promise<{ blurFaces: boolean; language: string }> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    return getJson(`/api/${enc(t)}/studio/settings`, {
      method: "PUT", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
    });
  },
  /** GET /api/:t/assets/:id/lineage: how a Studio picture was made, read from the graph (the photo, the options, the OK, the post). Null when there is none. */
  async assetLineage(t: string, id: string): Promise<Lineage | null> {
    if (mode === "mock") return null;
    return getOrNull<Lineage>(`/api/${enc(t)}/assets/${enc(id)}/lineage`);
  },

  // ---- Add your numbers (live server only: the file is read and kept there) ----

  /** POST /api/:t/numbers/preview (multipart): what we found in the owner's spreadsheet, in plain words, with our guess for every column. */
  async previewNumbers(t: string, file: File): Promise<NumbersPreview> {
    if (mode === "mock") throw new ApiError(NUMBERS_LIVE_ONLY, 501);
    const form = new FormData();
    form.append("file", file, file.name);
    return getJson(`/api/${enc(t)}/numbers/preview`, { method: "POST", body: form });
  },
  /** POST /api/:t/numbers/import (multipart): the same file, and the plan as the owner confirmed it. */
  async importNumbers(t: string, file: File, plan: NumbersPlan): Promise<NumbersImportResult> {
    if (mode === "mock") throw new ApiError(NUMBERS_LIVE_ONLY, 501);
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("plan", JSON.stringify(plan));
    return getJson(`/api/${enc(t)}/numbers/import`, { method: "POST", body: form });
  },

  // ---- Connections: every tool a business connects (live server only) ----

  /** GET /api/:t/connections: grouped, recommended first (ordered for this kind of business), with the everyday jobs that unlocks. */
  async connections(t: string): Promise<ConnectionsPage> {
    if (mode === "mock") return mockConnections();
    return getJson(`/api/${enc(t)}/connections`);
  },
  async searchConnections(t: string, q: string): Promise<Array<{ id: string; name: string; description: string }>> {
    if (mode === "mock") return [];
    return (await getJson<{ results: Array<{ id: string; name: string; description: string }> }>(`/api/${enc(t)}/connections/search?q=${encodeURIComponent(q)}`)).results;
  },
  /** POST .../connect: where the owner says yes. `returnTo: "popup"` lands on a "you can close this tab" page. */
  async connectConnection(t: string, id: string, o: { inbox?: boolean; returnTo?: "connections" | "onboard" | "popup" | "home" } = {}): Promise<ConnectStart> {
    if (mode === "mock") throw new ApiError("Connecting your tools needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/connections/${encodeURIComponent(id)}/connect`, "POST", o);
  },
  /** POST .../key: the key the owner pasted on the sheet, sent once; the answer never carries it back. */
  async connectWithKey(t: string, id: string, values: Record<string, string>): Promise<{ message: string; view: ConnectionRow }> {
    if (mode === "mock") throw new ApiError("Connecting your tools needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/connections/${encodeURIComponent(id)}/key`, "POST", { values });
  },
  async selectConnection(t: string, id: string, value: string): Promise<ConnectionRow> {
    if (mode === "mock") throw new ApiError("Connecting your tools needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/connections/${encodeURIComponent(id)}/select`, "POST", { value });
  },
  async disconnectConnection(t: string, id: string): Promise<ConnectionRow> {
    if (mode === "mock") throw new ApiError("Connecting your tools needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/connections/${encodeURIComponent(id)}/disconnect`, "POST", {});
  },
  async pullConnection(t: string, id: string): Promise<{ ok: boolean; message: string; view: ConnectionRow }> {
    if (mode === "mock") throw new ApiError("Connecting your tools needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/connections/${encodeURIComponent(id)}/pull`, "POST", {});
  },
  async connectionsAudit(t: string): Promise<Array<{ at: string; connection: string; did: string; worked: boolean; by: string | null }>> {
    if (mode === "mock") return [];
    return getJson(`/api/${enc(t)}/connections/audit`);
  },

  // ---- Meetings: a recorder's new calls become minutes and routed action items (live server only) ----

  /** POST /api/:t/meetings/check: read the connected recorders now. What was saved (each a new chat thread), skipped, and what to connect. */
  async checkMeetings(t: string): Promise<MeetingCheck> {
    if (mode === "mock") throw new ApiError("Reading your meeting recorder needs the live server.", 501);
    return sendJson(`/api/${enc(t)}/meetings/check`, "POST", {});
  },

  // ---- Connect Search Console (live server only) ----

  /** GET /api/:t/connectors/search-console: not switched on yet, not connected, pick the website, connected, or connect again. */
  async searchConsole(t: string): Promise<ConnectorStatus> {
    if (mode === "mock") throw new ApiError(CONNECT_LIVE_ONLY, 501);
    return getJson(`/api/${enc(t)}/connectors/search-console`);
  },
  /** POST .../connect: Google's consent page; the app sends the owner there. */
  async connectSearchConsole(t: string): Promise<{ url: string }> {
    if (mode === "mock") throw new ApiError(CONNECT_LIVE_ONLY, 501);
    return sendJson(`/api/${enc(t)}/connectors/search-console/connect`, "POST", {});
  },
  async chooseSearchConsoleSite(t: string, siteUrl: string): Promise<ConnectorStatus> {
    if (mode === "mock") throw new ApiError(CONNECT_LIVE_ONLY, 501);
    return sendJson(`/api/${enc(t)}/connectors/search-console/property`, "POST", { siteUrl });
  },
  async disconnectSearchConsole(t: string): Promise<ConnectorStatus> {
    if (mode === "mock") throw new ApiError(CONNECT_LIVE_ONLY, 501);
    return sendJson(`/api/${enc(t)}/connectors/search-console/disconnect`, "POST", {});
  },

  // ---- Check my website (live server only) ----

  /** GET /api/:t/checkup: where the free website check-up stands, the weekly setting, and the latest top five. */
  async checkup(t: string): Promise<CheckupStatus> {
    if (mode === "mock") throw new ApiError(CHECKUP_LIVE_ONLY, 501);
    return getJson(`/api/${enc(t)}/checkup`);
  },
  /** POST /api/:t/checkup: start one now, in the background (a few minutes). */
  async startCheckup(t: string): Promise<CheckupStatus> {
    if (mode === "mock") throw new ApiError(CHECKUP_LIVE_ONLY, 501);
    return sendJson(`/api/${enc(t)}/checkup`, "POST", {});
  },
  /** PUT /api/:t/checkup/schedule: the weekly check-up on or off. */
  async setCheckupWeekly(t: string, weekly: boolean): Promise<CheckupStatus> {
    if (mode === "mock") throw new ApiError(CHECKUP_LIVE_ONLY, 501);
    return sendJson(`/api/${enc(t)}/checkup/schedule`, "PUT", { weekly });
  },

  /** The brand library: what the team puts on posters. */
  async brand(t: string): Promise<{ assets: BrandAssetDto[]; logo: BrandAssetDto | null }> {
    if (mode === "mock") return { assets: [], logo: null };
    return getJson(`/api/${enc(t)}/brand`);
  },
  async brandUpload(t: string, file: File, note = ""): Promise<{ route: string; kind: string; message: string; needsBetter: boolean }> {
    if (mode === "mock") throw new ApiError(STUDIO_LIVE_ONLY, 501);
    const form = new FormData();
    form.append("file", file, file.name);
    if (note.trim()) form.append("note", note.trim());
    return getJson(`/api/${enc(t)}/studio/brand`, { method: "POST", headers: { accept: "application/json" }, body: form });
  },

  /** POST /api/onboard, an SSE stream of OnboardEvent. */
  async onboard(req: OnboardRequest, onEvent: (e: OnboardEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (mode === "mock") return (await mock()).onboard(req, onEvent, { speed: getSpeed, signal: opts.signal });
    return postSse<OnboardEvent>("/api/onboard", req, onEvent, opts.signal);
  },
};
