// Composio for the long tail (Shopify, HubSpot, Stripe, Slack, Meta while our own Meta app is in review), behind the same
// Connector interface. Composio holds those tokens; Allevia stores only the connected-account id, sealed per business.
//   entity     each business has an opaque Composio user id derived from its slug and the connector key (not the slug, not an
//              email); the server sets it, a model never does
//   connect    ask Composio for a hosted connect link for that user and toolkit; our callback comes back with a signed state
//   complete   Composio sends the owner back; the account is fetched and must belong to THIS business's user id and be active
//              before its id is sealed
//   execute    a tool call for one business: the stored account id is used, and its owner is re-checked against the business
// Off, and plainly explained, without COMPOSIO_API_KEY. The REST shapes below follow Composio's v3 API as documented when this
// was written and have NEVER run against the real service: expect a fix or two the first time (docs/connections-setup.md).
import { createHmac } from "node:crypto";
import { asRecord, realFetch, type FetchFn } from "../connectors/google/client.js";
import { syncCapabilities } from "../capabilities/ladder.js";
import { upsertNode } from "../graph/upsert.js";
import {
  NeedsAttentionError, NotConnectedError,
  type Availability, type CompleteOutcome, type ConnectionHealth, type ConnectionStatus, type Connector, type ConnectorCtx, type ConnectorInfo, type ConnectStart,
} from "./types.js";

const BASE = "https://backend.composio.dev/api/v3";

export interface ComposioAccount { id: string; status: string; userId: string; toolkit: string }

export interface ComposioClient {
  /** Finds or makes the auth config for a toolkit (Composio's own app until ours is approved). */
  authConfigId(toolkit: string): Promise<string>;
  link(o: { authConfigId: string; userId: string; callbackUrl: string }): Promise<{ redirectUrl: string; accountId: string }>;
  account(id: string): Promise<ComposioAccount | null>;
  deleteAccount(id: string): Promise<void>;
  execute(o: { tool: string; accountId: string; userId: string; args: Record<string, unknown> }): Promise<{ ok: boolean; data: unknown; error?: string }>;
}

export class ComposioError extends Error {
  override name = "ComposioError";
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function realComposioClient(apiKey: string, fetchFn: FetchFn = realFetch): ComposioClient {
  const call = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetchFn(`${BASE}${path}`, {
      method: init.method ?? "GET", headers: { "x-api-key": apiKey, "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let body: Record<string, unknown> = {};
    try { body = asRecord(JSON.parse(await res.text())); } catch { body = {}; }
    if (!res.ok && res.status !== 404) throw new ComposioError(`Composio answered ${res.status}.`, res.status);
    return { status: res.status, body };
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    async authConfigId(toolkit) {
      const found = await call(`/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
      const first = (Array.isArray(found.body.items) ? found.body.items : []).map(asRecord).find((i) => str(i.id));
      if (first) return str(first.id);
      const made = await call("/auth_configs", { method: "POST", body: { toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth" } } });
      const id = str(asRecord(made.body.auth_config).id) || str(made.body.id);
      if (!id) throw new ComposioError("Composio did not make an auth config.", 502);
      return id;
    },
    async link(o) {
      const r = await call("/connected_accounts/link", { method: "POST", body: { auth_config_id: o.authConfigId, user_id: o.userId, callback_url: o.callbackUrl } });
      const redirectUrl = str(r.body.redirect_url), accountId = str(r.body.connected_account_id);
      if (!redirectUrl || !accountId) throw new ComposioError("Composio did not give a connect link.", 502);
      return { redirectUrl, accountId };
    },
    async account(id) {
      const r = await call(`/connected_accounts/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      return { id: str(r.body.id) || id, status: str(r.body.status), userId: str(r.body.user_id) || str(asRecord(r.body.user).id), toolkit: str(asRecord(r.body.toolkit).slug) };
    },
    async deleteAccount(id) {
      await call(`/connected_accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async execute(o) {
      const r = await call(`/tools/execute/${encodeURIComponent(o.tool)}`, { method: "POST", body: { connected_account_id: o.accountId, user_id: o.userId, arguments: o.args } });
      const success = r.body.successful === true || r.body.success === true;
      return { ok: success, data: r.body.data ?? null, ...(success ? {} : { error: str(r.body.error) || "The tool did not work." }) };
    },
  };
}

export interface ComposioSpec {
  info: ConnectorInfo;
  toolkit: string;                // Composio's slug ("shopify")
  system: { id: string; name: string };
  soon?: boolean;                 // planned, not built
}

export interface ComposioDeps { apiKey: string; client: ComposioClient | null; connectorKey: string }

/** The opaque Composio user id for one business. */
export function composioUserId(connectorKey: string, tenant: string): string {
  return `al_${createHmac("sha256", connectorKey).update(`composio-user\u0000${tenant}`).digest("hex").slice(0, 24)}`;
}

interface Record_ { accountId: string; userId: string; at: number }

export const COMPOSIO_OFF_WORDS = (what: string) => `Connecting ${what} isn't switched on yet. Your team is setting up the connection service and will let you know when it's ready.`;

export class ComposioConnector implements Connector {
  readonly info: ConnectorInfo;
  constructor(readonly spec: ComposioSpec, private deps: ComposioDeps) {
    this.info = spec.info;
  }

  availability(): Availability {
    if (this.spec.soon) return { ok: false, soon: true, message: `${this.info.name} is coming soon.`, missing: [] };
    const missing = [
      ...(this.deps.apiKey ? [] : [{ setting: "COMPOSIO_API_KEY", words: "the key for Allevia's connection service (Composio)" }]),
      ...(this.deps.connectorKey.length >= 32 ? [] : [{ setting: "ALLEVIA_CONNECTOR_KEY", words: "the key that locks stored connections (at least 32 characters)" }]),
    ];
    return missing.length ? { ok: false, message: COMPOSIO_OFF_WORDS(this.info.name), missing } : { ok: true, message: "", missing: [] };
  }

  private client(): ComposioClient {
    if (!this.deps.client) throw new NotConnectedError(this.info.id, this.info.name, COMPOSIO_OFF_WORDS(this.info.name));
    return this.deps.client;
  }
  private rec(ctx: ConnectorCtx): Promise<Record_ | null> {
    return ctx.vault.get(ctx.tenant, this.info.id) as Promise<Record_ | null>;
  }
  private user(ctx: ConnectorCtx): string { return composioUserId(this.deps.connectorKey, ctx.tenant); }

  private async markSystem(ctx: ConnectorCtx, status: string): Promise<void> {
    try {
      const g = await ctx.graph();
      await upsertNode(g, { type: "System", id: this.spec.system.id, name: this.spec.system.name, props: { kind: "connector", provider: "composio", status } }, ctx.now());
      await syncCapabilities(g, { now: ctx.now(), ...(ctx.businessId ? { businessId: ctx.businessId } : {}) });
    } catch {
      // the ladder catches up on its next sync
    }
  }

  async status(ctx: ConnectorCtx): Promise<ConnectionStatus> {
    const r = await this.rec(ctx);
    if (!r) return { state: "not_connected", message: this.info.blurb };
    if (r.userId !== this.user(ctx)) return { state: "needs_attention", message: `We can't use the saved ${this.info.name} connection any more. Connect it again.` };
    return { state: "connected", message: `${this.info.name} is connected.`, lastReadAt: new Date(r.at).toISOString() };
  }

  async connect(ctx: ConnectorCtx): Promise<ConnectStart> {
    const state = ctx.beginAuth({});
    const authConfigId = await this.client().authConfigId(this.spec.toolkit);
    const callbackUrl = `${ctx.webBaseUrl}/api/connections/callback?${new URLSearchParams({ state })}`;
    const l = await this.client().link({ authConfigId, userId: this.user(ctx), callbackUrl });
    // the account id Composio made is kept with the state's memory by re-reading it on return (Composio sends it back too)
    return { url: l.redirectUrl };
  }

  async complete(ctx: ConnectorCtx, params: Record<string, string>): Promise<CompleteOutcome> {
    if (params.status && params.status !== "success") return { result: "denied" };
    const id = params.connected_account_id || params.connectedAccountId;
    if (!id) return { result: "problem", reason: "no_account" };
    const acct = await this.client().account(id);
    // the account must be this business's own, for this toolkit, and active: never take an id on the word of the address bar
    if (!acct || acct.userId !== this.user(ctx) || acct.toolkit.toLowerCase() !== this.spec.toolkit || acct.status.toUpperCase() !== "ACTIVE") return { result: "problem", reason: "not_active" };
    await ctx.vault.put(ctx.tenant, this.info.id, { accountId: acct.id, userId: acct.userId, at: ctx.now() } satisfies Record_);
    await this.markSystem(ctx, "ok");
    return { result: "connected" };
  }

  async disconnect(ctx: ConnectorCtx): Promise<void> {
    const r = await this.rec(ctx).catch(() => null);
    if (r && this.deps.client) await this.deps.client.deleteAccount(r.accountId).catch(() => undefined);
    await ctx.vault.delete(ctx.tenant, this.info.id);
    await this.markSystem(ctx, "disconnected");
  }

  async health(ctx: ConnectorCtx): Promise<ConnectionHealth> {
    const r = await this.rec(ctx).catch(() => null);
    if (!r) return { ok: false, message: `${this.info.name} isn't connected.` };
    const a = await this.client().account(r.accountId);
    return a && a.userId === this.user(ctx) && a.status.toUpperCase() === "ACTIVE"
      ? { ok: true, message: `${this.info.name} still answers.` }
      : { ok: false, message: `${this.info.name} stopped letting us in. Connect it again.` };
  }

  /** A session for one call: `execute(tool, args)` runs a Composio tool as this business, and only this business. */
  async run<T>(ctx: ConnectorCtx, fn: (s: { execute(tool: string, args: Record<string, unknown>): Promise<unknown> }) => Promise<T>): Promise<T> {
    const r = await this.rec(ctx).catch(() => { throw new NeedsAttentionError(this.info.id, this.info.name, `We can't open the saved ${this.info.name} connection. Ask the owner to connect it again.`); });
    if (!r) throw new NotConnectedError(this.info.id, this.info.name, `${this.info.name} isn't connected yet. Ask the owner to connect it: open Connections in Allevia and tap Connect ${this.info.name}.`);
    if (r.userId !== this.user(ctx)) throw new NeedsAttentionError(this.info.id, this.info.name, `${this.info.name} is not set up for this business. Ask the owner to connect it again.`);
    const client = this.client();
    return fn({
      execute: async (tool, args) => {
        const out = await client.execute({ tool, accountId: r.accountId, userId: r.userId, args });
        if (!out.ok) throw new ComposioError(out.error ?? "The tool did not work.", 502);
        return out.data;
      },
    });
  }
}

const c = (id: string, name: string, group: ConnectorInfo["group"], blurb: string, reads: string[], acts: string[], capabilities: ConnectorInfo["capabilities"] = []): ConnectorInfo =>
  ({ id, name, group, provider: "composio", blurb, reads, acts, capabilities });

export const COMPOSIO_SPECS: ComposioSpec[] = [
  { toolkit: "instagram", system: { id: "system:instagram", name: "Instagram" }, info: c("instagram", "Instagram", "meta", "Your team sees which posts bring you enquiries, and drafts posts for your OK.", ["Reach, followers and how each post did."], ["Posts only after you say OK."], ["instagram_insights"]) },
  { toolkit: "facebook", system: { id: "system:facebook-pages", name: "Facebook Page" }, info: c("facebook-pages", "Facebook Page", "meta", "Your team reads how your Page is doing and drafts posts for your OK.", ["Page visits, reach and posts."], ["Posts only after you say OK."]) },
  { toolkit: "metaads", system: { id: "system:meta-ads", name: "Meta Ads" }, info: c("meta-ads", "Meta Ads", "meta", "Your team reads your Facebook and Instagram ad spend and results.", ["Campaigns, spend and results. Read only."], [], ["ads"]) },
  { toolkit: "whatsapp", soon: true, system: { id: "system:whatsapp", name: "WhatsApp Business" }, info: c("whatsapp", "WhatsApp Business", "meta", "Your team answers customer messages for your OK.", [], []) },
  { toolkit: "shopify", system: { id: "system:shopify", name: "Shopify" }, info: c("shopify", "Shopify", "commerce", "Your team counts your orders and best sellers so it can tell what to push.", ["Orders, products and customers' order counts."], []) },
  { toolkit: "stripe", system: { id: "system:stripe", name: "Stripe" }, info: c("stripe", "Stripe", "commerce", "Your team reads your payments so the morning note has real revenue.", ["Payments and refunds. Read only."], []) },
  { toolkit: "hubspot", system: { id: "system:hubspot", name: "HubSpot" }, info: c("hubspot", "HubSpot", "customers", "Your team sees your leads and deals so Sales can follow up on every one.", ["Contacts, deals and their stages."], ["Notes and follow-ups only after you say OK."]) },
  { toolkit: "slack", system: { id: "system:slack", name: "Slack" }, info: c("slack", "Slack", "team", "Your team posts its morning note and questions in the Slack channel you choose.", ["The channels you pick."], ["Messages only after you say OK."]) },
];

export function composioConnectors(deps: ComposioDeps): ComposioConnector[] {
  return COMPOSIO_SPECS.map((s) => new ComposioConnector(s, deps));
}
