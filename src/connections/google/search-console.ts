// Search Console as a Connector. The reading, the website choice and the System node are the code that was built and parked first
// (src/connectors/google/searchconsole.ts); this wraps it so it sits on the Connections page beside the other Google products,
// with PKCE and the same single-use state, and so a tool can ask it live questions (top searches and pages).
import { GoogleAuthError, type AnalyticsQuery, type AnalyticsRow } from "../../connectors/google/client.js";
import {
  CONNECTOR, SCOPE, ConnectError, chooseProperty, connectionStatus, disconnectSearchConsole, freshToken, handleCallback, pullSearchConsole, readSystem, writeSystem,
  type GoogleDeps,
} from "../../connectors/google/searchconsole.js";
import { syncCapabilities } from "../../capabilities/ladder.js";
import { NeedsAttentionError, NotConnectedError, type Availability, type CompleteOutcome, type ConnectionHealth, type ConnectionStatus, type Connector, type ConnectorCtx, type ConnectorInfo, type ConnectStart } from "../types.js";
import { once } from "../once.js";
import { consentUrl, googleAvailability, newPkce, type GoogleConnSettings } from "./oauth.js";

export interface SearchConsoleSession {
  property: string;
  query(q: Omit<AnalyticsQuery, "rowLimit"> & { rowLimit?: number }): Promise<AnalyticsRow[]>;
}

export class SearchConsoleConnector implements Connector {
  readonly info: ConnectorInfo = {
    id: CONNECTOR, name: "Google Search Console", group: "google", provider: "google",
    blurb: "Your team sees the searches that bring people to your site, and which pages Google can't find.",
    reads: ["Searches, clicks and pages on your site. Read only."],
    acts: [],
    capabilities: ["search_console"],
  };
  constructor(private deps: GoogleDeps, private settings: GoogleConnSettings) {}

  availability(): Availability {
    return googleAvailability(this.settings, "Google Search Console");
  }

  async status(ctx: ConnectorCtx): Promise<ConnectionStatus> {
    const g = await ctx.graph();
    const s = await connectionStatus(this.deps, g, ctx.tenant, ctx.businessId);
    switch (s.state) {
      case "connected":
        return { state: "connected", message: s.message, ...(s.property ? { selected: s.property } : {}), ...(s.lastPullAt ? { lastReadAt: s.lastPullAt } : {}) };
      case "choose_property":
        return { state: "connected", message: s.message, choose: { label: "Which website should we read?", options: s.sites ?? [] } };
      case "needs_reconnect":
        return { state: "needs_attention", message: s.message };
      default:
        return { state: "not_connected", message: this.info.blurb };
    }
  }

  async connect(ctx: ConnectorCtx): Promise<ConnectStart> {
    const { verifier, challenge } = newPkce();
    return { url: consentUrl(this.settings, { scopes: [SCOPE], state: ctx.beginAuth({ verifier }), challenge }) };
  }

  async complete(ctx: ConnectorCtx, params: Record<string, string>, data: Record<string, string>): Promise<CompleteOutcome> {
    if (!params.code) throw new ConnectError("google", "Google didn't send a sign-in code. Start again from the app.");
    const g = await ctx.graph();
    const r = await handleCallback(this.deps, g, ctx.tenant, params.code, ctx.businessId, data.verifier);
    if (r.state === "choose_property") return { result: "choose" };
    void this.pull(ctx).catch(() => undefined); // the first look; the daily read retries
    return { result: "connected" };
  }

  async select(ctx: ConnectorCtx, value: string): Promise<void> {
    const g = await ctx.graph();
    await chooseProperty(this.deps, g, ctx.tenant, value);
    void this.pull(ctx).catch(() => undefined);
  }

  async disconnect(ctx: ConnectorCtx): Promise<void> {
    await disconnectSearchConsole(this.deps, await ctx.graph(), ctx.tenant);
    await syncCapabilities(await ctx.graph(), { now: ctx.now(), ...(ctx.businessId ? { businessId: ctx.businessId } : {}) }).catch(() => undefined);
  }

  async health(ctx: ConnectorCtx): Promise<ConnectionHealth> {
    const s = await this.status(ctx);
    return { ok: s.state === "connected", message: s.state === "connected" ? "Google still lets us read Search Console." : s.message };
  }

  pull(ctx: ConnectorCtx): Promise<{ ok: boolean; message: string }> {
    return once(`${ctx.tenant}\u0000${CONNECTOR}`, async () => {
      const r = await pullSearchConsole(this.deps, await ctx.graph(), ctx.tenant, ctx.businessId ? { businessId: ctx.businessId } : {});
      return { ok: r.status === "ok", message: r.message };
    });
  }

  /** A live session: the chosen website, and a query that refreshes the access once when Google refuses it. */
  async run<T>(ctx: ConnectorCtx, fn: (s: SearchConsoleSession) => Promise<T>): Promise<T> {
    const g = await ctx.graph();
    const words = `Google stopped letting us read Search Console (the access was removed or has run out). Ask the owner to connect it again on the Connections page.`;
    let tokens = await this.deps.store.get(ctx.tenant, CONNECTOR).catch(() => { throw new NeedsAttentionError(CONNECTOR, this.info.name, words); });
    if (!tokens) throw new NotConnectedError(CONNECTOR, this.info.name, "Search Console isn't connected yet. Ask the owner to connect it: open Connections in Allevia and tap Connect Google Search Console.");
    const sys = await readSystem(g);
    if (sys?.status === "expired") throw new NeedsAttentionError(CONNECTOR, this.info.name, words);
    if (!sys?.property) throw new NeedsAttentionError(CONNECTOR, this.info.name, "Search Console is connected but the owner has not picked which website to read yet. Ask them to pick it on the Connections page.");
    const property = sys.property;
    const expire = async (): Promise<never> => {
      await writeSystem(g, ctx.now(), { status: "expired", lastError: "Google no longer accepts the saved access" });
      await syncCapabilities(g, { now: ctx.now() }).catch(() => undefined);
      throw new NeedsAttentionError(CONNECTOR, this.info.name, words);
    };
    try {
      tokens = await freshToken(this.deps, g, ctx.tenant, tokens);
    } catch (e) {
      if (e instanceof GoogleAuthError) return expire();
      throw e;
    }
    return fn({
      property,
      query: async (q) => {
        const go = (t: { accessToken: string }) => this.deps.client.searchAnalytics(t.accessToken, property, { ...q, rowLimit: q.rowLimit ?? 25 });
        try {
          return await go(tokens!);
        } catch (e) {
          if (!(e instanceof GoogleAuthError)) throw e;
          try {
            tokens = await freshToken(this.deps, g, ctx.tenant, tokens!, true);
            return await go(tokens);
          } catch (e2) {
            if (e2 instanceof GoogleAuthError) return expire();
            throw e2;
          }
        }
      },
    });
  }
}
