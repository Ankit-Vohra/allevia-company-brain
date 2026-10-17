// Connect Search Console (src/connectors/google/). The owner clicks Connect, signs in to their own Google account on Google's
// page, and comes back here:
//   GET  /api/:t/connectors/search-console              the connection in plain words: not switched on yet, not connected,
//                                                       pick the website, connected (what is read, how fresh), connect again
//   POST /api/:t/connectors/search-console/connect      { url }: where to send the owner (Google's consent page)
//   GET  /api/connectors/google/callback                Google sends the owner back with ?code and ?state; the tenant comes
//                                                       from the signed state, and the owner lands on the app with ?connect=
//   POST /api/:t/connectors/search-console/property     { siteUrl }: which website, when the account has more than one
//   POST /api/:t/connectors/search-console/pull         read it now (the daily pull does this on its own)
//   POST /api/:t/connectors/search-console/disconnect   forget the access (and ask Google to revoke it)
// Writes are refused in public mode. A server with no Google credentials answers the status with a plain sentence and the
// connect call with a 503 saying the same: nothing is called, nothing asked for. NOTE for whoever adds sign-in: Connect and
// the callback must be tied to the signed-in owner of that business (the state only proves the link was made here).
import type { Hono } from "hono";
import { z } from "zod";
import {
  authorizationUrl, chooseProperty, connectionStatus, ConnectError, disconnectSearchConsole, handleCallback, pullSearchConsole, tenantFromState,
  type ConnectorStatus, type GoogleDeps,
} from "../../connectors/google/searchconsole.js";
import { NOT_CONFIGURED_WORDS, NotConfiguredError } from "../../connectors/google/settings.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";
import { requireOwner } from "../roles.js";

export interface GoogleWiring { deps: GoogleDeps; webBaseUrl: string }

const Property = z.object({ siteUrl: z.string().trim().min(3).max(300) });

export function registerConnectorRoutes(app: Hono, ctx: RouteCtx, h: { google?: () => Promise<GoogleWiring | null> }): void {
  const wiring = async (): Promise<GoogleWiring | null> => (await h.google?.()) ?? null;
  const need = async (): Promise<GoogleWiring> => {
    const w = await wiring();
    if (!w || !w.deps.settings.configured) throw new HttpError(503, NOT_CONFIGURED_WORDS);
    return w;
  };
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConnectError) throw new HttpError(e.code === "not_found" ? 404 : 400, e.message);
      if (e instanceof NotConfiguredError) throw new HttpError(503, e.message);
      throw e;
    }
  };

  app.get("/api/:t/connectors/search-console", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    const w = await wiring();
    if (!w) return c.json({ state: "not_configured", message: NOT_CONFIGURED_WORDS } satisfies ConnectorStatus);
    return c.json(await connectionStatus(w.deps, g, reg.slug, reg.businessId));
  });

  app.post("/api/:t/connectors/search-console/connect", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner(); // the business's accounts are the owner's to connect (src/server/roles.ts)
    const w = await need();
    return c.json({ url: authorizationUrl(w.deps, reg.slug) });
  });

  // Google sends the owner here from another site, so no owner cookie or token comes with the request (and with owner links
  // on, a Strict cookie is not sent on that navigation): what proves this was started by this server, for this business, is
  // the signed, expiring, single-use state that `connect` made (and `connect` is behind the owner's door and refused in
  // public mode, so there is no state to forge).
  app.get("/api/connectors/google/callback", async (c) => {
    const w = await need();
    const back = (result: string, extra: Record<string, string> = {}) =>
      c.redirect(`${w.webBaseUrl}/?${new URLSearchParams({ connect: "search-console", result, ...extra }).toString()}`, 302);
    const state = c.req.query("state") ?? "";
    const tenant = tenantFromState(w.deps, state);
    if (!tenant) throw new HttpError(400, "That sign-in link has run out, or it didn't come from the app. Start again from the app.");
    if (c.req.query("error")) return back("denied"); // the owner said no on Google's page
    const code = c.req.query("code") ?? "";
    if (!code) throw new HttpError(400, "Google didn't send a sign-in code. Start again from the app.");
    const { reg, g } = await (ctx.tenantBySlug ?? (async () => { throw new HttpError(404, "No such business."); }))(tenant);
    try {
      const r = await handleCallback(w.deps, g, reg.slug, code, reg.businessId);
      if (r.state === "choose_property") return back("choose");
      await pullSearchConsole(w.deps, g, reg.slug, { businessId: reg.businessId }).catch(() => undefined); // the first look; the daily pull retries
      return back("connected");
    } catch (e) {
      if (e instanceof ConnectError) return back("problem", { reason: e.code });
      throw e;
    }
  });

  app.post("/api/:t/connectors/search-console/property", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner();
    const w = await need();
    const body = await readBody(c, Property);
    await wrap(() => chooseProperty(w.deps, g, reg.slug, body.siteUrl));
    await pullSearchConsole(w.deps, g, reg.slug, { businessId: reg.businessId }).catch(() => undefined);
    return c.json(await connectionStatus(w.deps, g, reg.slug, reg.businessId));
  });

  app.post("/api/:t/connectors/search-console/pull", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const w = await need();
    return c.json(await wrap(() => pullSearchConsole(w.deps, g, reg.slug, { businessId: reg.businessId })));
  });

  app.post("/api/:t/connectors/search-console/disconnect", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner();
    const w = await need();
    await wrap(() => disconnectSearchConsole(w.deps, g, reg.slug));
    return c.json(await connectionStatus(w.deps, g, reg.slug, reg.businessId));
  });
}
