// The Allevia HTTP API (spec §10, §11; product design §8), as a Hono app built from injectable deps so tests drive it
// with app.request() over a throwaway graph and a scripted runtime.
//
// Rules every route follows:
// - A tenant in the path must be in the registry (listTenants, cached briefly); anything else is a 404.
// - Graph reads are GRAPH.RO_QUERY (reads.ts), every list has a LIMIT, and props never include embeddings.
// - Errors are JSON {error}; an unexpected failure is logged here and the client gets a plain sentence, no stack.
// - CORS answers only the Vite dev origin; in production the web app is served from this same origin.
// - Public mode (ALLEVIA_PUBLIC_MODE=1, spec §11.3): every write is refused, threads show only showcase turns, and
//   /ask replays a stored showcase turn (Turn.showcase = true) instead of running the model. GETs that bring the graph
//   up to date as they read (program, capabilities) compute the same answer read-only.
// - Approvals (POST /api/:t/approvals/:id) go through decide() in approvals.ts, the same function Discord's buttons
//   use: the real executors, with GitHub issues and Discord posts as a dry run unless ALLEVIA_ACTIONS_LIVE=1. The
//   answer is the card plus `learned` (the learned-rule AgentEvents, in the JSON) and `action`.
// Focused route files: routes/program.ts (program, capabilities, learning), routes/team.ts (agents, directives),
// routes/work.ts (insights and brief runs).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { AgentEvent, OnboardEvent } from "../../shared/contracts.js";
import { ask, type AskDeps } from "../agent/ask.js";
import type { ToolContext } from "../agent/tool.js";
import type { GraphHandle } from "../graph/client.js";
import type { LlmRunner } from "../ingest/llm.js";
import { DecisionError, decide, type ActionOpts, type OnDecision } from "./approvals.js";
import { HttpError, readBody, type RouteCtx } from "./http.js";
import { registerProgramRoutes } from "./routes/program.js";
import { registerTeamRoutes } from "./routes/team.js";
import { registerWorkRoutes } from "./routes/work.js";
import * as reads from "./reads.js";
import { sse } from "./sse.js";
import type { TenantDto } from "./types.js";

// ---------- deps ----------

// What the server needs from the tenant registry (src/graph/tenants.ts Tenant, plus the regional fields onboarding
// may store on it).
export interface RegistryTenant {
  slug: string;
  name: string;
  businessId: string;
  domain?: string;
  industry?: string;
  city?: string;
  country?: string;
  currency?: string;
  locale?: string;
  timeZone?: string;
}

export interface OnboardStart {
  name: string;
  slug: string;
  url: string;
  instagram?: string;
  country?: string;
  currency?: string;
  locale?: string;
  timeZone?: string;
  industry?: string;
  vertical?: string;
}
export type OnboardFn = (input: OnboardStart, emit: (e: OnboardEvent) => void, signal: AbortSignal) => Promise<unknown>;

export interface PlansModule { [k: string]: unknown }

export interface ServerDeps {
  publicMode: boolean;
  listTenants: () => Promise<RegistryTenant[]>;
  openGraph: (slug: string) => Promise<GraphHandle>;
  // ask()'s deps for one live turn (createAskDeps in production; a FakeRuntime in tests).
  askDeps: (tenant: string, o: { timeZone?: string }) => Promise<AskDeps>;
  embedQuery?: () => Promise<ToolContext["embedQuery"] | undefined>; // for /search; absent = full-text only
  // Called after an approval decision is recorded (executors and the learning loop plug in here). Its failure is
  // logged, never the owner's problem: the decision stands.
  onDecision?: OnDecision;
  // How approved actions run (approvals.ts ActionOpts): default the real executors, GitHub/Discord dry-run unless
  // ALLEVIA_ACTIONS_LIVE=1. Tests inject a dataDir for drafts and fakes for gh and HTTP.
  actions?: ActionOpts;
  // The model "Tell your team" uses for what its rules can't parse: undefined = haiku on the subscription, null = rules only.
  directiveLlm?: LlmRunner | null;
  loadOnboard?: () => Promise<OnboardFn | null>;   // null: onboarding is not installed (501)
  loadPlans?: () => Promise<PlansModule | null>;    // null: pricing data is not installed (501)
  now?: () => number;
  heartbeatMs?: number;     // SSE keepalive comment interval; 0 turns it off (default 15 s)
  replaySpeed?: number;     // public-mode replay pacing; 1 = about real time, 0 = instant (default 1)
  maxLiveAsks?: number;     // concurrent live turns across tenants (default 2)
  tenantCacheMs?: number;   // how long the registry is cached (default 5 s)
  staticDir?: string;       // the built web app (web/dist); served with an index.html fallback
  corsOrigins?: string[];   // default: the Vite dev server
  log?: (line: string) => void;
}

export const VITE_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const PUBLIC_REFUSAL = "This is the public read-only demo of Allevia: approvals, onboarding and other changes are turned off.";
const LIVE_CHAT_OFF =
  "Live chat needs the owner's model access, which this public demo does not have. Pick one of the recorded threads to watch the team work.";

export { HttpError };

const TENANT_SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

// ---------- request bodies ----------

const AskBody = z.object({
  question: z.string().max(2000),
  sessionId: z.string().min(1).max(200).optional(),
  turnId: z.string().min(1).max(200).optional(), // public mode: replay this showcase turn
});

const Payload = z.object({ title: z.string().max(500), body: z.string().max(20_000), target: z.string().max(500).optional() });
const DecisionBody = z.object({ decision: z.enum(["approve", "reject"]), editedPayload: Payload.optional() });

const OnboardBody = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(3).max(500),
  slug: z.string().regex(TENANT_SLUG).max(40).optional(),
  instagram: z.string().trim().max(100).optional(),
  country: z.string().trim().max(80).optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  locale: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).optional(),
  timeZone: z.string().trim().max(64).optional(),
  industry: z.string().trim().max(120).optional(),
  vertical: z.string().trim().max(120).optional(),
});

const validTimeZone = (tz: string | undefined): string | undefined => {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
};

// "Kestrel & Oak" -> "kestrel_oak"; a name with no Latin letters falls back to the website's host.
export function slugFor(name: string, url: string): string {
  const fromName = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
  if (fromName) return fromName;
  let host = url;
  try { host = new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname; } catch { /* keep */ }
  const base = host.replace(/^www\./, "").split(".")[0] ?? "";
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "business";
}

const REPLAY_PACE: Partial<Record<AgentEvent["type"], number>> = {
  text: 40, tool_result: 600, tool_call: 250, finding: 800, plan: 900, handoff: 500, review: 600, path: 400,
};
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (ms <= 0 || signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---------- the app ----------

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.error(line));
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const replaySpeed = deps.replaySpeed ?? 1;
  const maxLive = deps.maxLiveAsks ?? 2;
  const cacheMs = deps.tenantCacheMs ?? 5_000;
  const origins = deps.corsOrigins ?? VITE_DEV_ORIGINS;
  let live = 0;
  let onboarding = false;

  let cache: { at: number; list: Promise<RegistryTenant[]> } | undefined;
  const registry = (): Promise<RegistryTenant[]> => {
    if (!cache || now() - cache.at > cacheMs) {
      const list = deps.listTenants();
      cache = { at: now(), list };
      list.catch(() => { if (cache?.list === list) cache = undefined; });
    }
    return cache.list;
  };

  let embedder: Promise<ToolContext["embedQuery"] | undefined> | undefined;
  const embedQuery = () => (embedder ??= (deps.embedQuery?.() ?? Promise.resolve(undefined)).catch(() => undefined));

  // A registered tenant's graph, or a 404.
  async function tenantOf(c: Context): Promise<{ reg: RegistryTenant; g: GraphHandle }> {
    const slug = c.req.param("t") ?? "";
    const reg = TENANT_SLUG.test(slug) ? (await registry()).find((t) => t.slug === slug) : undefined;
    if (!reg) throw new HttpError(404, "No such business.");
    return { reg, g: await deps.openGraph(slug) };
  }

  async function tenantDto(reg: RegistryTenant, g?: GraphHandle): Promise<TenantDto> {
    let biz: reads.BusinessProps = {};
    try { if (g) biz = await reads.businessProps(g, reg.businessId); } catch { biz = {}; }
    const pick = (k: keyof reads.BusinessProps & keyof RegistryTenant) => reg[k] ?? biz[k];
    const t: TenantDto = { id: reg.slug, name: reg.name, domain: pick("domain") ?? "", industry: pick("industry") ?? "" };
    for (const k of ["city", "country", "currency", "locale", "timeZone"] as const) {
      const v = pick(k);
      if (v) t[k] = v;
    }
    if (t.timeZone && !validTimeZone(t.timeZone)) delete t.timeZone;
    return t;
  }

  const refuseInPublicMode = () => { if (deps.publicMode) throw new HttpError(403, PUBLIC_REFUSAL); };

  // ---- middleware ----
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", xFrameOptions: "DENY" }));
  app.use("/api/*", cors({
    origin: (origin) => (origins.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "accept"],
    maxAge: 600,
  }));
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "The request body is too large." }, 413) }));
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.get("cache-control")) c.header("Cache-Control", "no-store");
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof DecisionError) return c.json({ error: err.message }, err.status);
    log(`[api] ${c.req.method} ${c.req.path}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return c.json({ error: "Something went wrong on the server. Try again in a moment." }, 500);
  });

  // ---- global routes ----
  app.get("/api/health", async (c) => {
    try {
      const tenants = await registry();
      return c.json({ ok: true, publicMode: deps.publicMode, tenants: tenants.length });
    } catch {
      return c.json({ ok: false, publicMode: deps.publicMode, error: "The graph database is not reachable." }, 503);
    }
  });

  app.get("/api/tenants", async (c) => {
    const list = await registry();
    const out = await Promise.all(list.slice(0, 200).map(async (reg) => {
      let g: GraphHandle | undefined;
      try { g = await deps.openGraph(reg.slug); } catch { g = undefined; }
      return tenantDto(reg, g);
    }));
    return c.json(out);
  });

  app.get("/api/plans", async (c) => {
    const currency = (c.req.query("currency") ?? "").toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "currency must be an ISO 4217 code such as USD.");
    const mod = await (deps.loadPlans ?? loadPlansModule)();
    if (!mod) throw new HttpError(501, "Pricing is not available yet.");
    const fn = ["plansFor", "pricesFor", "getPlans"].map((k) => mod[k]).find((f): f is (cur?: string) => unknown => typeof f === "function");
    if (fn) return c.json(await fn(currency || undefined) as object);
    const plans = mod.PLANS ?? mod.plans ?? mod.default;
    if (plans === undefined) throw new HttpError(501, "Pricing is not available yet.");
    return c.json({ ...(currency ? { currency } : {}), plans });
  });

  app.post("/api/onboard", async (c) => {
    refuseInPublicMode();
    const body = await readBody(c, OnboardBody);
    const run = await (deps.loadOnboard ?? loadOnboardModule)();
    if (!run) throw new HttpError(501, "Website onboarding is not installed on this server yet.");
    if (onboarding) throw new HttpError(429, "Another business is being set up right now. Try again in a few minutes.");
    let slug = body.slug ?? slugFor(body.name, body.url);
    const taken = (await registry()).find((t) => t.slug === slug);
    if (taken && !body.slug && taken.domain && !body.url.includes(taken.domain.replace(/^www\./, ""))) slug = `${slug}_2`;
    const input: OnboardStart = {
      name: body.name, slug, url: body.url,
      ...Object.fromEntries((["instagram", "country", "currency", "locale", "industry", "vertical"] as const)
        .filter((k) => body[k]).map((k) => [k, k === "currency" ? body[k]!.toUpperCase() : body[k]!])),
      ...(validTimeZone(body.timeZone) ? { timeZone: body.timeZone } : {}),
    };
    onboarding = true;
    return sse<OnboardEvent>(c, { heartbeatMs, log }, async (send, signal) => {
      try {
        let done = false;
        // onboarding v2 stores the region itself (its profile stage), so nothing more to write here
        await run(input, (e) => send(e), signal);
        cache = undefined; // a new tenant may be in the registry now
      } finally {
        onboarding = false;
      }
    });
  });


  // ---- tenant routes ----
  app.get("/api/:t/overview", async (c) => {
    const { reg, g } = await tenantOf(c);
    const [tenant, counts, freshness, brief, recs, pending] = await Promise.all([
      tenantDto(reg, g), reads.labelCounts(g), reads.freshness(g, now()), reads.latestBrief(g), reads.recommendations(g, 3), reads.pendingApprovals(g),
    ]);
    return c.json({ tenant, counts, freshness, brief: brief?.text ?? "", recommendations: recs, approvalsPending: pending });
  });

  app.get("/api/:t/brief", async (c) => {
    const { g } = await tenantOf(c);
    const brief = await reads.latestBrief(g);
    if (!brief) throw new HttpError(404, "No morning brief has been written for this business yet.");
    return c.json(brief);
  });

  app.get("/api/:t/sessions", async (c) => {
    const { g } = await tenantOf(c);
    return c.json(await reads.sessions(g, { showcaseOnly: deps.publicMode }));
  });

  app.get("/api/:t/sessions/:id", async (c) => {
    const { g } = await tenantOf(c);
    const s = await reads.sessionDetail(g, c.req.param("id"), { showcaseOnly: deps.publicMode });
    if (!s) throw new HttpError(404, "No such thread.");
    return c.json(s);
  });

  app.get("/api/:t/turns/:id/replay", async (c) => {
    const { g } = await tenantOf(c);
    const events = await reads.turnEvents(g, c.req.param("id"), { showcaseOnly: deps.publicMode });
    if (!events) throw new HttpError(404, "No stored work log for that turn.");
    return c.json(events);
  });

  app.get("/api/:t/search", async (c) => {
    const { reg, g } = await tenantOf(c);
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json([]);
    if (q.length > 200) throw new HttpError(400, "The search is too long (200 characters at most).");
    return c.json(await reads.searchGraph(g, reg.slug, q, await embedQuery(), now()));
  });

  app.get("/api/:t/node/:id", async (c) => {
    const { g } = await tenantOf(c);
    const d = await reads.nodeDetail(g, c.req.param("id"));
    if (!d) throw new HttpError(404, "No such node.");
    return c.json(d);
  });

  app.get("/api/:t/graph/overview", async (c) => {
    const { g } = await tenantOf(c);
    const limit = Number(c.req.query("limit") ?? reads.LIMITS.overviewNodes);
    return c.json(await reads.overviewGraph(g, Number.isFinite(limit) ? limit : reads.LIMITS.overviewNodes));
  });

  app.get("/api/:t/graph", async (c) => {
    const { g } = await tenantOf(c);
    const focus = c.req.query("focus") ?? "";
    if (!focus) throw new HttpError(400, "Say which node to focus on: ?focus=<id>.");
    const depth = Math.max(1, Math.min(2, Number(c.req.query("depth") ?? 1) || 1));
    const data = await reads.focusGraph(g, focus, depth);
    if (!data) throw new HttpError(404, "No such node.");
    return c.json(data);
  });

  const routeCtx: RouteCtx = { tenantOf, refuseInPublicMode, publicMode: deps.publicMode, now, log };
  registerTeamRoutes(app, routeCtx, deps.directiveLlm !== undefined ? { directiveLlm: deps.directiveLlm } : {});
  registerProgramRoutes(app, routeCtx);
  registerWorkRoutes(app, routeCtx);

  app.get("/api/:t/agents/:id", async (c) => {
    const { g } = await tenantOf(c);
    const d = await reads.agentDetail(g, c.req.param("id"));
    if (!d) throw new HttpError(404, "No such agent on the team.");
    return c.json(d);
  });

  app.get("/api/:t/recommendations", async (c) => {
    const { g } = await tenantOf(c);
    return c.json(await reads.recommendations(g));
  });

  app.get("/api/:t/approvals", async (c) => {
    const { g } = await tenantOf(c);
    return c.json(await reads.approvals(g));
  });

  app.post("/api/:t/approvals/:id", async (c) => {
    const { reg, g } = await tenantOf(c);
    refuseInPublicMode();
    const body = await readBody(c, DecisionBody);
    return c.json(await decide(g, reg.slug, c.req.param("id"), body, {
      now: now(), log, ...(deps.onDecision ? { onDecision: deps.onDecision } : {}), ...(deps.actions ? { actions: deps.actions } : {}),
    }));
  });

  app.post("/api/:t/ask", async (c) => {
    const { reg, g } = await tenantOf(c);
    const body = await readBody(c, AskBody);
    const question = body.question.trim();

    if (deps.publicMode) {
      const turn = await reads.findShowcaseTurn(g, { question, ...(body.turnId ? { turnId: body.turnId } : {}) });
      return sse<AgentEvent>(c, { heartbeatMs, log }, async (send, signal) => {
        if (!turn) { send({ type: "error", message: LIVE_CHAT_OFF }); return; }
        for (const e of turn.events) {
          await sleep((REPLAY_PACE[e.type] ?? 200) * replaySpeed, signal);
          if (signal.aborted) return;
          send(e);
        }
      });
    }

    if (!question) throw new HttpError(400, "Ask a question first.");
    if (live >= maxLive) throw new HttpError(429, "The team is already working on other questions. Try again in a minute.");
    live++;
    let released = false;
    const release = () => { if (!released) { released = true; live--; } };
    try {
      const tz = (await tenantDto(reg, g)).timeZone;
      const askDeps = await deps.askDeps(reg.slug, tz ? { timeZone: tz } : {});
      return sse<AgentEvent>(c, { heartbeatMs, log }, async (send, signal) => {
        try {
          await ask(
            { tenant: reg.slug, question, channel: "web", ...(body.sessionId ? { sessionId: body.sessionId } : {}) },
            { ...askDeps, ...(tz ? { timeZone: tz } : {}), signal },
            send,
          );
        } finally {
          release();
        }
      });
    } catch (e) {
      release();
      throw e;
    }
  });

  app.all("/api/*", () => { throw new HttpError(404, "No such endpoint."); });

  // ---- the web app ----
  if (deps.staticDir && existsSync(join(deps.staticDir, "index.html"))) {
    const root = deps.staticDir;
    const index = readFileSync(join(root, "index.html"), "utf8");
    app.use("*", serveStatic({ root }));
    app.get("*", (c) => c.html(index)); // client-side routes (/ask/…, /brain…) get the app shell
  }
  app.notFound((c) => c.json({ error: "Not found." }, 404));
  return app;
}

// ---------- optional modules (merged from other workstreams) ----------

const firstExisting = (base: URL, names: string[]): URL | undefined => names.map((n) => new URL(n, base)).find((u) => existsSync(u));

// src/onboard/onboard.ts: onboard(input, emit, deps) with an LLM runner on the subscription. Absent -> null (501).
export async function loadOnboardModule(): Promise<OnboardFn | null> {
  const url = firstExisting(new URL("../onboard/", import.meta.url), ["onboard.ts", "onboard.js"]);
  if (!url) return null;
  const mod = (await import(url.href)) as { onboard?: (input: unknown, emit: (e: OnboardEvent) => void, deps: unknown) => Promise<unknown> };
  if (typeof mod.onboard !== "function") return null;
  const onboard = mod.onboard;
  const { AgentSdkRunner } = await import("../ingest/llm.js");
  return (input, emit, signal) => onboard(input, emit, { runner: new AgentSdkRunner({ concurrency: 3 }), signal });
}

// shared/plans.ts: pricing data. Absent -> null (501).
export async function loadPlansModule(): Promise<PlansModule | null> {
  const url = firstExisting(new URL("../../shared/", import.meta.url), ["plans.ts", "plans.js"]);
  return url ? ((await import(url.href)) as PlansModule) : null;
}
