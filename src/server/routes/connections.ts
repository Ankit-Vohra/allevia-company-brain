// The Connections page's API (src/connections), plus the two places a provider sends the owner back to.
//   GET  /api/:t/connections                    every connection grouped as the page shows it, the recommended ones first and ordered for
//                                               this kind of business, what is connected, and the everyday jobs that unlocks
//   GET  /api/:t/connections/search?q=          Composio's wider catalogue, searched by words
//   POST /api/:t/connections/:id/connect        { inbox?, returnTo? } -> { url }: where the owner says yes
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
import { entryById, fitOf, recommendedFor, startersFor } from "../../../shared/connection-map.js";
import type { ConnectionsService } from "../../connections/service.js";
import { GROUP_LABELS, GROUP_ORDER, NotConfiguredError, type ConnectionView } from "../../connections/types.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";
import { businessProps } from "../reads.js";

export interface ConnectionsWiring { service: ConnectionsService; webBaseUrl: string }

const Connect = z.object({ inbox: z.boolean().optional(), returnTo: z.enum(["connections", "onboard"]).optional() });
const Select = z.object({ value: z.string().trim().min(1).max(300) });

const RETURN_PATH: Record<string, string> = { connections: "/connections", onboard: "/onboard" };

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
      if (e instanceof Error && e.name === "ConnectError") throw new HttpError(400, e.message);
      throw e;
    }
  };

  app.get("/api/:t/connections", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    const w = await wiring();
    if (!w) return c.json({ ready: false, message: "Connecting your tools isn't switched on yet.", groups: [], recommended: [], more: [], starters: [] });
    const views = await w.service.list(reg.slug);
    const byId = new Map(views.map((v) => [v.id, v]));
    const props = await businessProps(g, reg.businessId).catch(() => ({}) as Awaited<ReturnType<typeof businessProps>>);
    const fit = fitOf(props.industry, props.name ?? reg.name, props.domain);
    const recommended = recommendedFor(fit).map((e) => byId.get(e.id)).filter((v): v is ConnectionView => !!v);
    const shown = new Set(recommended.map((v) => v.id));
    const more = views.filter((v) => !shown.has(v.id));
    const connected = views.filter((v) => v.state === "connected").map((v) => v.id);
    const missing = new Map<string, string>();
    for (const cn of w.service.connectors) for (const m of cn.availability().missing) missing.set(m.setting, m.words);
    return c.json({
      ready: [...byId.values()].some((v) => v.available), fit,
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
    const w = await need();
    const id = c.req.param("id");
    known(w, id);
    const body = c.req.header("content-length") === "0" ? {} : await readBody(c, Connect).catch(() => ({}) as z.infer<typeof Connect>);
    return c.json(await wrap(() => w.service.connect(reg.slug, id, { ...(body.inbox ? { inbox: "1" } : {}), ...(body.returnTo ? { returnTo: body.returnTo } : {}) })));
  });

  app.post("/api/:t/connections/:id/select", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const w = await need();
    known(w, c.req.param("id"));
    const body = await readBody(c, Select);
    return c.json(await wrap(() => w.service.select(reg.slug, c.req.param("id"), body.value)));
  });

  app.post("/api/:t/connections/:id/pull", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const w = await need();
    known(w, c.req.param("id"));
    const r = await wrap(() => w.service.pull(reg.slug, c.req.param("id")));
    return c.json({ ...r, view: await w.service.view(reg.slug, c.req.param("id")) });
  });

  app.post("/api/:t/connections/:id/disconnect", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
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
      const words = e instanceof NotConfiguredError ? e.message : "We couldn't start that connection just now. Try again in a minute.";
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
