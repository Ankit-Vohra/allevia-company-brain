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
// - Live turns (POST /api/:t/ask, turns.ts) run on the server to the end even when the client goes away (owners close
//   tabs); the thread shows the answer when they come back. GET /api/:t/turns/live and the thread's `running` say what
//   is still working, GET /api/:t/turns/:id/events?after=N re-attaches, and only POST /api/:t/turns/:id/stop (or the
//   turn-level time cap on top of the per-agent timeouts) cancels one.
// - Approvals (POST /api/:t/approvals/:id) go through decide() in approvals.ts, the same function Discord's buttons
//   use: the real executors, with GitHub issues and Discord posts as a dry run unless ALLEVIA_ACTIONS_LIVE=1. The
//   answer is the card plus `learned` (the learned-rule AgentEvents, in the JSON) and `action`.
// Focused route files: routes/program.ts (program, capabilities, learning), routes/team.ts (agents, directives),
// routes/goals.ts (the owner says OK to the suggested goals), routes/numbers.ts (the owner adds a spreadsheet of their numbers), routes/actions.ts (where an approved fix lands: tasks, or the business's own GitHub repo), routes/connectors.ts (connect Search Console), routes/work.ts (insights and brief runs), routes/usage.ts (this month's Studio credits and answers, for the plan page), routes/graph-work.ts (the Brain page's "what breaks if something stops").
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { AgentEvent, OnboardEvent } from "../../shared/contracts.js";
import { ask, STOPPED_MESSAGE, type AskDeps } from "../agent/ask.js";
import type { ToolContext } from "../agent/tool.js";
import { loadConfig } from "../config.js";
import type { GraphHandle } from "../graph/client.js";
import { MAX_SLUG_LENGTH, isTenantSlug, RESERVED_SLUGS } from "../graph/slug.js";
import { OPERATOR_SCOPE } from "../auth/tokens.js";
import type { LlmRunner } from "../ingest/llm.js";
import { DecisionError, decide, type ActionOpts, type OnDecision } from "./approvals.js";
import { PRIVATE_MESSAGE, authorize, clearSession, presentedTokens, requestView, scopesOf, setSession, type AuthDeps } from "./auth.js";
import { HttpError, readBody, type RouteCtx } from "./http.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerConnectorRoutes, type GoogleWiring } from "./routes/connectors.js";
import { registerGoalRoutes } from "./routes/goals.js";
import { NUMBERS_UPLOAD_PATH, registerNumbersRoutes } from "./routes/numbers.js";
import { registerProgramRoutes } from "./routes/program.js";
import { registerTeamRoutes } from "./routes/team.js";
import { LinkTooSoon, type HubService } from "../discord/hub-service.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerWorkRoutes } from "./routes/work.js";
import { registerGraphWorkRoutes } from "./routes/graph-work.js";
import * as reads from "./reads.js";
import { sse } from "./sse.js";
import { LiveTurns, type LiveTurn, type LiveTurnsOpts } from "./turns.js";
import { mountStudio, STUDIO_UPLOAD_PATH, studioDecisionHook, type StudioWiring } from "./studio.js";
import type { SessionDetailDto, SessionSummaryDto, TenantDto, TurnEventsDto } from "./types.js";

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
  demo?: boolean;   // a public demo business (graph/tenants.ts setDemo): opens read-only without an owner link when ALLEVIA_AUTH=1
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
  // ALLEVIA_AUTH=1 (src/auth, docs/tenant-isolation.md): every /api/:t/... route needs that business's owner token, and
  // /api/onboard the operator's. Absent (or enabled: false) is local development: no checks.
  auth?: AuthDeps;
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
  // The Discord hub (one shared server for every customer): after onboarding succeeds the business's area is set up there
  // and the owner gets a join link. null or absent: no hub on this server, and nothing Discord shows anywhere.
  discordHub?: () => Promise<HubService | null>;
  loadPlans?: () => Promise<PlansModule | null>;    // null: pricing data is not installed (501)
  studio?: () => Promise<StudioWiring | null>;      // the Studio's assets, vision and engine; absent: 501
  google?: () => Promise<GoogleWiring | null>;      // the Google connectors (Search Console): settings, token store, client; absent: "not switched on yet"
  now?: () => number;
  heartbeatMs?: number;     // SSE keepalive comment interval; 0 turns it off (default 15 s)
  replaySpeed?: number;     // public-mode replay pacing; 1 = about real time, 0 = instant (default 1)
  maxLiveAsks?: number;     // concurrent live turns across tenants (default 2)
  liveTurns?: LiveTurnsOpts; // how long finished turns stay re-attachable, and the turn-level time cap (turns.ts)
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
  slug: z.string().refine(isTenantSlug, { message: "is not a valid business id" }).optional(),
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

// "Kestrel & Oak" -> "kestrel_oak"; a name with no Latin letters falls back to the website's host. A name that comes out as a
// reserved word ("Meta", "Health") gets "_co" so it is a slug (graph/slug.ts).
export function slugFor(name: string, url: string): string {
  const slug = slugFrom(name, url);
  return isTenantSlug(slug) ? slug : `${slug.slice(0, MAX_SLUG_LENGTH - 3).replace(/_+$/, "")}_co`;
}

// The first of base_2, base_3, … that is not taken.
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`;
    const slug = `${base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (!taken.has(slug)) return slug;
  }
  throw new HttpError(409, "That business id is already taken.");
}

function slugFrom(name: string, url: string): string {
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
  const turns = new LiveTurns({ now, ...deps.liveTurns });

  let cache: { at: number; list: Promise<RegistryTenant[]> } | undefined;
  const registry = (): Promise<RegistryTenant[]> => {
    if (!cache || now() - cache.at > cacheMs) {
      const list = deps.listTenants();
      cache = { at: now(), list };
      list.catch(() => { if (cache?.list === list) cache = undefined; });
    }
    return cache.list;
  };

  // The hub is looked at lazily: a server with no hub never loads any of it.
  let hubLoad: Promise<HubService | null> | undefined;
  const discordHub = (): Promise<HubService | null> =>
    (hubLoad ??= (deps.discordHub?.() ?? Promise.resolve(null)).catch((e) => { log(`[api] the Discord hub could not start: ${e instanceof Error ? e.message : String(e)}`); return null; }));

  let embedder: Promise<ToolContext["embedQuery"] | undefined> | undefined;
  const embedQuery = () => (embedder ??= (deps.embedQuery?.() ?? Promise.resolve(undefined)).catch(() => undefined));

  // A registered tenant's graph, or a 404.
  async function tenantBySlug(slug: string): Promise<{ reg: RegistryTenant; g: GraphHandle }> {
    const reg = isTenantSlug(slug) ? (await registry()).find((t) => t.slug === slug) : undefined;
    if (!reg) throw new HttpError(404, "No such business.");
    return { reg, g: await deps.openGraph(slug) };
  }
  const tenantOf = (c: Context): Promise<{ reg: RegistryTenant; g: GraphHandle }> => tenantBySlug(c.req.param("t") ?? "");

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

  // With ALLEVIA_AUTH=1 "public" is decided per request: a demo business without a token is the public read-only view;
  // anyone holding a token for the business they asked for is its owner, and sees (and may change) the real thing.
  const authOn = !!deps.auth?.enabled;
  const isPublic = (): boolean => (authOn ? requestView.getStore()?.publicView ?? true : deps.publicMode);
  const refuseInPublicMode = () => { if (isPublic()) throw new HttpError(403, PUBLIC_REFUSAL); };
  // Studio cards approved anywhere become draft posts; then the server's own hook runs.
  const onDecision = studioDecisionHook(deps.openGraph, now, deps.onDecision);

  // ---- middleware ----
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", xFrameOptions: "DENY" }));
  app.use("/api/*", cors({
    origin: (origin) => (origins.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "accept", "authorization"],
    maxAge: 600,
  }));
  // With owner links on, the browser carries the credential in a cookie, so a page on another site must not be able to make
  // it send a change (SameSite=Strict already keeps the cookie from other sites; this also covers a sibling subdomain, and
  // the "login CSRF" of posting an attacker's own link to /api/auth/open). A change that names an Origin must be from this
  // app's own origin (or the dev server's); one without an Origin (a script, curl, the CLI) must not be a cross-site fetch.
  app.use("/api/*", async (c, next) => {
    if (!authOn || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    let ownOrigin = false;
    if (origin) {
      try { ownOrigin = new URL(origin).host === (c.req.header("host") ?? new URL(c.req.url).host); } catch { ownOrigin = false; }
      if (!ownOrigin && !origins.includes(origin)) throw new HttpError(403, "That request came from another site, so it was not made.");
    } else if (site && site !== "same-origin" && site !== "none") {
      throw new HttpError(403, "That request came from another site, so it was not made.");
    }
    return next();
  });
  // The door (ALLEVIA_AUTH=1): before any body is read or any route runs, a request for a business needs that business's
  // owner token, or the business must be a demo, and then it is the read-only public view. Reserved first segments
  // (health, tenants, plans, onboard, auth) are the global routes below; a first segment that is not a slug is a 404 later.
  app.use("/api/:t/*", async (c, next) => {
    const slug = c.req.param("t") ?? "";
    if (!authOn || RESERVED_SLUGS.includes(slug) || !isTenantSlug(slug)) return next();
    if (await authorize(deps.auth!, c, slug)) return requestView.run({ publicView: false }, next);
    const reg = (await registry()).find((t) => t.slug === slug);
    if (reg?.demo === true) return requestView.run({ publicView: true }, next);
    throw new HttpError(401, PRIVATE_MESSAGE); // the same answer for a business that exists and one that does not
  });
  // 64 KB everywhere except the Studio's photo upload (studio.ts) and the spreadsheet upload (routes/numbers.ts), which set their own limits
  const smallBodies = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "The request body is too large." }, 413) });
  app.use("/api/*", (c, next) => (c.req.method === "POST" && (STUDIO_UPLOAD_PATH.test(c.req.path) || NUMBERS_UPLOAD_PATH.test(c.req.path)) ? next() : smallBodies(c, next)));
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
      // with the flag on the number of businesses is not for strangers
      return c.json({ ok: true, publicMode: deps.publicMode, ...(authOn ? { authRequired: true } : { tenants: tenants.length }) });
    } catch {
      return c.json({ ok: false, publicMode: deps.publicMode, error: "The graph database is not reachable." }, 503);
    }
  });

  app.get("/api/tenants", async (c) => {
    let list = await registry();
    if (authOn) {
      // a stranger sees the demo businesses, an owner also their own, the operator all of them
      const scopes = await scopesOf(deps.auth!, c);
      list = list.filter((t) => scopes.has(OPERATOR_SCOPE) || scopes.has(t.slug) || t.demo === true);
    }
    const out = await Promise.all(list.slice(0, 200).map(async (reg) => {
      let g: GraphHandle | undefined;
      try { g = await deps.openGraph(reg.slug); } catch { g = undefined; }
      return tenantDto(reg, g);
    }));
    return c.json(out);
  });

  // ---- opening a business with its link (only with ALLEVIA_AUTH=1) ----
  // The web app posts the token from the link's #fragment here once; the answer sets an HttpOnly cookie for that business.
  // Every failure is the same sentence, so it says nothing about which tokens or businesses exist.
  app.post("/api/auth/open", async (c) => {
    if (!authOn) throw new HttpError(404, "No such endpoint.");
    const body = await readBody(c, z.object({ token: z.unknown().optional() }));
    const bad = new HttpError(401, "That link is not valid any more. Ask for a new one.");
    if (typeof body.token !== "string") throw bad;
    const v = await deps.auth!.verify(body.token);
    if (!v) throw bad;
    setSession(c, v.scope, body.token);
    return c.json(v.scope === OPERATOR_SCOPE ? { scope: v.scope } : { scope: v.scope, tenant: v.scope });
  });

  app.post("/api/auth/close", async (c) => {
    if (!authOn) throw new HttpError(404, "No such endpoint.");
    const body = await readBody(c, z.object({ tenant: z.string() }));
    if (body.tenant !== OPERATOR_SCOPE && !isTenantSlug(body.tenant)) throw new HttpError(400, "Say which business to close.");
    clearSession(c, body.tenant);
    return c.json({ closed: body.tenant });
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
    if (authOn) {
      // creating a business spends the operator's model access and makes a graph: only the operator does it
      const tokens = presentedTokens(c);
      if (!tokens.length) throw new HttpError(401, PRIVATE_MESSAGE);
      if (!(await scopesOf(deps.auth!, c)).has(OPERATOR_SCOPE)) throw new HttpError(403, "Setting up a business is done by the Allevia team.");
    } else refuseInPublicMode();
    const body = await readBody(c, OnboardBody);
    const run = await (deps.loadOnboard ?? loadOnboardModule)();
    if (!run) throw new HttpError(501, "Website onboarding is not installed on this server yet.");
    if (onboarding) throw new HttpError(429, "Another business is being set up right now. Try again in a few minutes.");
    // Onboarding writes into the graph of the slug it is given. It must never be a business that already exists unless the
    // operator says so by naming it: another business's name, web address or id cannot steer it into that business's graph.
    // (A re-run from the open web is not offered: `npm run cli -- enroll` and scripts/onboard.ts do it.)
    const known = new Set((await registry()).map((t) => t.slug));
    let slug = body.slug ?? slugFor(body.name, body.url);
    if (known.has(slug)) {
      if (body.slug && authOn) {
        // the operator re-runs a business by naming it
      } else if (body.slug) throw new HttpError(409, "That business id is already taken.");
      else slug = freeSlug(slug, known);
    }
    const input: OnboardStart = {
      name: body.name, slug, url: body.url,
      ...Object.fromEntries((["instagram", "country", "currency", "locale", "industry", "vertical"] as const)
        .filter((k) => body[k]).map((k) => [k, k === "currency" ? body[k]!.toUpperCase() : body[k]!])),
      ...(validTimeZone(body.timeZone) ? { timeZone: body.timeZone } : {}),
    };
    onboarding = true;
    return sse<OnboardEvent>(c, { heartbeatMs, log }, async (send, signal) => {
      try {
        const hub = await discordHub();
        // With a hub, the "done" event waits until the business's Discord area is set up, so it can carry the join link.
        // Provisioning never fails onboarding: when it cannot finish, `done` says "later" and the retry loop finishes it.
        let held: Extract<OnboardEvent, { type: "done" }> | undefined;
        // onboarding v2 stores the region itself (its profile stage), so nothing more to write here
        await run(input, (e) => { if (e.type === "done" && hub) held = e; else send(e); }, signal);
        cache = undefined; // a new tenant may be in the registry now
        if (held && hub) send({ ...held, discord: await hub.afterOnboarding(held.tenant) });
      } finally {
        onboarding = false;
      }
    });
  });


  // ---- Discord: where the owner joins their team (the Home page and the onboarding "done" screen read this) ----
  app.get("/api/:t/discord", async (c) => {
    const { reg } = await tenantOf(c);
    // A join link puts a person in this business's Discord area with its role, so only its owner is shown one: not the
    // public demo view, and not (with owner links on) a visitor to a demo business.
    const hub = isPublic() ? null : await discordHub();
    return c.json(hub ? await hub.home(reg.slug) : { enabled: false });
  });

  app.post("/api/:t/discord/invite", async (c) => {
    refuseInPublicMode();
    const { reg } = await tenantOf(c);
    const hub = await discordHub();
    if (!hub) throw new HttpError(501, "Discord is not set up on this server yet.");
    try {
      return c.json(await hub.newLink(reg.slug));
    } catch (e) {
      if (e instanceof LinkTooSoon) throw new HttpError(429, e.message);
      log(`[api] new Discord link for ${reg.slug}: ${e instanceof Error ? e.message : String(e)}`);
      throw new HttpError(503, "We could not make a new Discord link just now. Try again in a minute.");
    }
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
    if (!brief) throw new HttpError(404, "No note has been written for this business yet.");
    return c.json(brief);
  });

  app.get("/api/:t/sessions", async (c) => {
    const { reg, g } = await tenantOf(c);
    const list: SessionSummaryDto[] = await reads.sessions(g, { showcaseOnly: isPublic() });
    const working = isPublic() ? [] : turns.running(reg.slug);
    const ids = new Set(working.map((t) => t.sessionId));
    // a new thread whose first turn is still being set up is not in the graph yet: listed from the live turn
    const fresh = working.filter((t) => t.sessionId && !list.some((s) => s.id === t.sessionId)).map((t): SessionSummaryDto => {
      const d = t.dto();
      return { id: d.sessionId, title: d.question, startedAt: d.startedAt, lastAt: d.startedAt, turns: 0, channel: "web", running: true };
    });
    return c.json([...fresh, ...list.map((s) => (ids.has(s.id) ? { ...s, running: true } : s))]);
  });

  app.get("/api/:t/sessions/:id", async (c) => {
    const { reg, g } = await tenantOf(c);
    const id = c.req.param("id");
    const running = isPublic() ? undefined : turns.runningInSession(reg.slug, id);
    const s: SessionDetailDto | null = await reads.sessionDetail(g, id, { showcaseOnly: isPublic() })
      ?? (running ? { id, title: running.question, turns: [] } : null); // a new thread whose first turn is still being set up
    if (!s) throw new HttpError(404, "No such thread.");
    return c.json(running && !s.turns.some((t) => t.id === running.turnId) ? { ...s, running: running.dto() } : s);
  });

  // ---- live turns (turns.ts): they run to the end on the server; anyone can re-attach, only stop() cancels ----
  app.get("/api/:t/turns/live", async (c) => {
    const { reg } = await tenantOf(c);
    return c.json(turns.running(reg.slug).map((t) => t.dto()));
  });

  app.get("/api/:t/turns/:id/events", async (c) => {
    const { reg, g } = await tenantOf(c);
    const raw = c.req.query("after") ?? "0";
    if (!/^\d{1,7}$/.test(raw)) throw new HttpError(400, "after must be an event index: 0 or more.");
    const after = Number(raw);
    const page = 500;
    const id = c.req.param("id");
    const t = turns.get(reg.slug, id);
    if (t) {
      const events = t.events.slice(after, after + page);
      const next = Math.min(t.events.length, after + events.length);
      const dto: TurnEventsDto = {
        turnId: t.turnId, sessionId: t.sessionId, question: t.question, status: t.status, events, next, done: !t.running && next >= t.events.length,
      };
      return c.json(dto);
    }
    const stored = await reads.storedTurn(g, id, { showcaseOnly: isPublic() });
    if (!stored) throw new HttpError(404, "No such turn.");
    const events = stored.events.slice(after, after + page);
    const next = Math.min(stored.events.length, after + events.length);
    const dto: TurnEventsDto = {
      turnId: stored.id, sessionId: stored.sessionId, question: stored.question,
      status: stored.status === "ok" ? "done" : stored.error === STOPPED_MESSAGE ? "stopped" : "failed",
      events, next, done: next >= stored.events.length,
    };
    return c.json(dto);
  });

  app.post("/api/:t/turns/:id/stop", async (c) => {
    const { reg } = await tenantOf(c);
    refuseInPublicMode();
    const t = turns.get(reg.slug, c.req.param("id"));
    if (!t) throw new HttpError(404, "That turn is not running on this server.");
    if (!t.running) return c.json({ turnId: t.turnId, status: t.status });
    t.stop("stopped by the owner");
    return c.json({ turnId: t.turnId, status: "stopping" });
  });

  app.get("/api/:t/turns/:id/replay", async (c) => {
    const { g } = await tenantOf(c);
    const events = await reads.turnEvents(g, c.req.param("id"), { showcaseOnly: isPublic() });
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

  const routeCtx: RouteCtx = { tenantOf, tenantBySlug, refuseInPublicMode, get publicMode() { return isPublic(); }, now, log };
  registerTeamRoutes(app, routeCtx, deps.directiveLlm !== undefined ? { directiveLlm: deps.directiveLlm } : {});
  registerProgramRoutes(app, routeCtx);
  registerGoalRoutes(app, routeCtx);
  registerNumbersRoutes(app, routeCtx);
  registerActionRoutes(app, routeCtx, { serverRepo: () => deps.actions?.config?.githubActionRepo });
  registerConnectorRoutes(app, routeCtx, { ...(deps.google ? { google: deps.google } : {}) });
  registerWorkRoutes(app, routeCtx);
  registerGraphWorkRoutes(app, routeCtx);
  registerUsageRoutes(app, routeCtx, { actionsLive: () => deps.actions?.live ?? loadConfig().actionsLive });

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
      now: now(), log, onDecision, ...(deps.actions ? { actions: deps.actions } : {}),
    }));
  });

  app.post("/api/:t/ask", async (c) => {
    const { reg, g } = await tenantOf(c);
    const body = await readBody(c, AskBody);
    const question = body.question.trim();

    if (isPublic()) {
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
    // The live slot is held until the turn ends, not until this client leaves: the turn runs on (turns.ts).
    live++;
    let released = false;
    const release = () => { if (!released) { released = true; live--; } };
    let turn: LiveTurn;
    try {
      const tz = (await tenantDto(reg, g)).timeZone;
      const askDeps = await deps.askDeps(reg.slug, tz ? { timeZone: tz } : {});
      turn = turns.start(reg.slug, question, (emit, signal) => ask(
        { tenant: reg.slug, question, channel: "web", ...(body.sessionId ? { sessionId: body.sessionId } : {}) },
        { ...askDeps, ...(tz ? { timeZone: tz } : {}), signal },
        emit,
      ));
    } catch (e) {
      release();
      throw e;
    }
    void turn.done.then(release);
    // This stream follows the turn; when the client goes away only the following stops.
    return sse<AgentEvent>(c, { heartbeatMs, log }, (send, signal) => turn.follow(0, send, signal));
  });

  mountStudio(app, {
    tenantOf, refuseInPublicMode, heartbeatMs, now, log,
    // the Studio's own approve route records the decision the way every surface does (executors, learning loop and the
    // server's hook), then attaches the chosen variant itself; so the studio hook is left out here
    decide: (g, tenant, id, d) => decide(g, tenant, id, d, {
      now: now(), log, ...(deps.onDecision ? { onDecision: deps.onDecision } : {}), ...(deps.actions ? { actions: deps.actions } : {}),
    }),
    fail: (status, message) => { throw new HttpError(status, message); },
    ...(deps.studio ? { studio: deps.studio } : {}),
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
