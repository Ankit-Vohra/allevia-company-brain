// The Connections page's API (src/connections), plus the two places a provider sends the owner back to.
//   GET  /api/:t/connections                    every connection grouped as the page shows it, the recommended ones first and ordered for
//                                               this kind of business, what is connected, and the everyday jobs that unlocks
//   GET  /api/:t/connections/search?q=          Composio's wider catalogue, searched by words
//   POST /api/:t/connections/:id/connect        { inbox?, returnTo? } -> { url, key? }: where the owner says yes; with `key`, a tool
//                                               with no sign-in page, and the page asks for its key instead
//   POST /api/:t/connections/:id/key            { values } -> { message, view }: the key the owner pasted, passed on to Composio
//   POST /api/:t/connections/:id/select         { value }: which website, property or account, when there is more than one
//   POST /api/:t/connections/:id/pull           read it now
//   POST /api/:t/connections/:id/disconnect     forget it and ask the provider to revoke it
//   GET  /api/:t/connections/audit              the newest calls made through this business's connections
//   GET  /api/connectors/google/callback        every provider sends the owner back here (with ?state); the business comes from the
//                                               signed, single-use state. Legacy Search Console links keep working (connectors.ts).
//   GET  /c/:code                               a short one-time link (from Discord) that starts a connection
// Writes are refused in public mode. A tool or an owner reaches only their own business: the tenant comes from the path (and the
// owner's door, when auth is on), never from the body.
import type { Hono } from "hono";
import { z } from "zod";
import { entryById, fitOf, recommendedFor, startersFor, TOOLKIT_CATALOG } from "../../../shared/connection-map.js";
import type { ConnectionsService } from "../../connections/service.js";
import { ComposioError } from "../../connections/composio.js";
import { ConnectProblem, GROUP_LABELS, GROUP_ORDER, NotConfiguredError, type ConnectionView } from "../../connections/types.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";
import { requireOwner } from "../roles.js";
import { businessProps } from "../reads.js";
import { isSampleTenant, SAMPLE_CONNECTED, SAMPLE_WORDS, sampleView } from "../../demo/sample/connections.js";

export interface ConnectionsWiring { service: ConnectionsService; webBaseUrl: string }

// A public demo business with sample data (src/demo/sample) shows Gmail, Google Calendar and Shopify as connected, each saying it is
// sample data; the rest of the catalogue is listed as the server has it (or as not connected in this demo when connecting is off).
// Its sample tools cannot be connected, read again or disconnected: they are not real accounts.
const SAMPLE_REFUSAL = "This is sample data for the demo, not a real account, so there is nothing to connect, read again or disconnect.";
async function sampleViews(w: ConnectionsWiring | null, tenant: string): Promise<ConnectionView[]> {
  const real = w ? await w.service.list(tenant).catch(() => [] as ConnectionView[]) : [];
  const ids = new Set<string>(SAMPLE_CONNECTED);
  const others = real.length ? real.filter((v) => !ids.has(v.id)) : TOOLKIT_CATALOG.filter((e) => e.recommended !== null && !ids.has(e.id)).map((e): ConnectionView => ({
    id: e.id, name: e.name, access: e.acts.length ? "read_act" : "read", group: e.group, blurb: e.blurb, reads: e.reads, acts: e.acts,
    state: "not_connected", message: "Not connected in this demo.", available: false, unavailableWords: "Not connected in this demo.",
  }));
  return [...SAMPLE_CONNECTED.map(sampleView), ...others].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

const Connect = z.object({ inbox: z.boolean().optional(), returnTo: z.enum(["connections", "onboard", "popup", "home"]).optional() });
const Select = z.object({ value: z.string().trim().min(1).max(300) });
// field name -> what the owner pasted; a few fields at most, each a key's length (the connector says which fields it needs)
const Key = z.object({ values: z.record(z.string().regex(/^[A-Za-z0-9_]{1,60}$/), z.string().max(2000)).refine((v) => Object.keys(v).length <= 8, "has too many fields") });

const RETURN_PATH: Record<string, string> = { connections: "/connections", onboard: "/onboard", popup: "/connected", home: "/" };

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

export function registerConnectionRoutes(app: Hono, ctx: RouteCtx, h: { connections?: () => Promise<ConnectionsWiring | null> }): void {
  const wiring = async (): Promise<ConnectionsWiring | null> => (await h.connections?.()) ?? null;
  const need = async (): Promise<ConnectionsWiring> => {
    const w = await wiring();
    if (!w) throw new HttpError(503, "Connecting your tools isn't switched on yet. Your team is setting it up and will let you know when it's ready.");
    return w;
  };
  const known = (w: ConnectionsWiring, id: string): void => {
    if (!w.service.has(id)) throw new HttpError(404, "There is no such connection.");
  };
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NotConfiguredError) throw new HttpError(503, e.message);
      if (e instanceof ConnectProblem) throw new HttpError(e.status, e.message);
      if (e instanceof Error && e.name === "ConnectError") throw new HttpError(400, e.message);
      // anything Composio refused that a connector did not put in words: still a sentence, never "something went wrong on the server"
      if (e instanceof ComposioError) throw new HttpError(400, `Composio couldn't do that just now (it answered ${e.status}). Try again in a minute.`);
      throw e;
    }
  };

  app.get("/api/:t/connections", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    const w = await wiring();
    const sample = isSampleTenant(reg.slug);
    if (!w && !sample) return c.json({ ready: false, message: "Connecting your tools isn't switched on yet.", groups: [], recommended: [], more: [], starters: [] });
    const views = sample ? await sampleViews(w, reg.slug) : await w!.service.list(reg.slug);
    const byId = new Map(views.map((v) => [v.id, v]));
    const props = await businessProps(g, reg.businessId).catch(() => ({}) as Awaited<ReturnType<typeof businessProps>>);
    const fit = fitOf(props.industry, props.name ?? reg.name, props.domain);
    const recommended = recommendedFor(fit).map((e) => byId.get(e.id)).filter((v): v is ConnectionView => !!v);
    const shown = new Set(recommended.map((v) => v.id));
    const more = views.filter((v) => !shown.has(v.id));
    const connected = views.filter((v) => v.state === "connected").map((v) => v.id);
    const missing = new Map<string, string>();
    for (const cn of w?.service.connectors ?? []) for (const m of cn.availability().missing) missing.set(m.setting, m.words);
    return c.json({
      ready: [...byId.values()].some((v) => v.available), fit, ...(sample ? { sample: SAMPLE_WORDS } : {}),
      recommended, more,
      groups: GROUP_ORDER.map((g) => ({ id: g, label: GROUP_LABELS[g], items: views.filter((v) => v.group === g) })).filter((g) => g.items.length),
      starters: startersFor(connected),
      setup: [...missing].map(([setting, words]) => ({ setting, words })),
      never: "We never post, send, spend or book without your OK, and your data stays in your own space.",
    });
  });

  app.get("/api/:t/connections/search", async (c) => {
    await ctx.tenantOf(c);
    const w = await need();
    const q = (c.req.query("q") ?? "").trim();
    if (q.length > 60) throw new HttpError(400, "The search is too long.");
    return c.json({ results: await w.service.search(q) });
  });

  app.post("/api/:t/connections/:id/connect", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner(); // the business's accounts are the owner's to connect (src/server/roles.ts)
    if (isSampleTenant(reg.slug)) throw new HttpError(400, SAMPLE_REFUSAL);
    const w = await need();
    const id = c.req.param("id");
    known(w, id);
    const body = c.req.header("content-length") === "0" ? {} : await readBody(c, Connect).catch(() => ({}) as z.infer<typeof Connect>);
    return c.json(await wrap(() => w.service.connect(reg.slug, id, { ...(body.inbox ? { inbox: "1" } : {}), ...(body.returnTo ? { returnTo: body.returnTo } : {}) })));
  });

  // The paste-your-key sheet: the key goes from this request to Composio and nowhere else (not the log, not the store, not the answer).
  app.post("/api/:t/connections/:id/key", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner();
    if (isSampleTenant(reg.slug)) throw new HttpError(400, SAMPLE_REFUSAL);
    const w = await need();
    const id = c.req.param("id");
    known(w, id);
    const body = await readBody(c, Key);
    return c.json(await wrap(() => w.service.connectWithKey(reg.slug, id, body.values)));
  });

  app.post("/api/:t/connections/:id/select", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner();
    if (isSampleTenant(reg.slug)) throw new HttpError(400, SAMPLE_REFUSAL);
    const w = await need();
    known(w, c.req.param("id"));
    const body = await readBody(c, Select);
    return c.json(await wrap(() => w.service.select(reg.slug, c.req.param("id"), body.value)));
  });

  app.post("/api/:t/connections/:id/pull", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    if (isSampleTenant(reg.slug)) throw new HttpError(400, SAMPLE_REFUSAL);
    const w = await need();
    known(w, c.req.param("id"));
    const r = await wrap(() => w.service.pull(reg.slug, c.req.param("id")));
    return c.json({ ...r, view: await w.service.view(reg.slug, c.req.param("id")) });
  });

  app.post("/api/:t/connections/:id/disconnect", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner();
    if (isSampleTenant(reg.slug)) throw new HttpError(400, SAMPLE_REFUSAL);
    const w = await need();
    known(w, c.req.param("id"));
    return c.json(await wrap(() => w.service.disconnect(reg.slug, c.req.param("id"))));
  });

  app.get("/api/:t/connections/audit", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    const w = await need();
    const rows = await w.service.audit.recent(reg.slug, { limit: 50 });
    return c.json(rows.map((e) => ({ at: new Date(e.at).toISOString(), connection: entryById(e.connector)?.name ?? e.connector, did: e.op, worked: e.ok, by: e.actor ?? null })));
  });

  // A short one-time link: no owner cookie comes with it (it is opened from Discord), so what proves it is the signed, expiring,
  // single-use code that names the business and the connection. It only redirects to the provider's own page.
  app.get("/c/:code", async (c) => {
    const w = await wiring();
    const link = w?.service.redeemLink(c.req.param("code"));
    if (!w || !link) return c.html(page("This link has run out", "Connect links work once, for ten minutes. Ask your team in Discord for a new one with /connect."), 400);
    try {
      const { url } = await w.service.connect(link.tenant, link.id, { ...link.options, returnTo: "connections" });
      return c.redirect(url, 302);
    } catch (e) {
      const words = e instanceof NotConfiguredError || e instanceof ConnectProblem ? e.message : "We couldn't start that connection just now. Try again in a minute.";
      return c.html(page("Not ready yet", words), 503);
    }
  });

  // Every provider sends the owner back here. Registered before the Search Console route in connectors.ts, so a state this
  // service made is finished here and any other state falls through to the older handler.
  app.get("/api/connectors/google/callback", async (c, next) => {
    const w = await wiring();
    const state = c.req.query("state") ?? "";
    if (!w || !w.service.ownsState(state)) return next();
    const params = Object.fromEntries(new URL(c.req.url).searchParams) as Record<string, string>;
    const done = await w.service.complete(state, params);
    if (!done) throw new HttpError(400, "That sign-in link has run out, or it didn't come from the app. Start again from the app.");
    const back = RETURN_PATH[done.returnTo ?? "connections"] ?? "/connections";
    return c.redirect(`${w.webBaseUrl}${back}?${new URLSearchParams({ connect: done.id, result: done.outcome.result, ...(done.outcome.reason ? { reason: done.outcome.reason } : {}) })}`, 302);
  });
}
