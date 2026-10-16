// One Google product (Calendar, Gmail, Analytics, Ads) as a Connector, on Allevia's own OAuth app. Each product asks Google for
// its own permissions (never all at once), keeps its own sealed grant per business, and is its own row on the Connections page.
//   connect    consent address with PKCE; scopes are what that product needs, nothing more
//   complete   code -> tokens (verifier from the server's memory), the permissions the owner actually ticked are checked, the account
//              is found (for "connected as ..."), and a System node tells the capability ladder this source is live
//   run        a live session for one call: the access token is refreshed when old, a refused token marks the connection "needs
//              attention" (and the ladder drops a rung), and nothing the owner did not allow is attempted
//   disconnect asks Google to revoke, forgets the sealed grant, tells the ladder
// What the graph holds is the System node only (status, when it last read), never a token.
import { ConnectError } from "../../connectors/google/searchconsole.js";
import { GoogleApiError, GoogleAuthError, type GoogleClient } from "../../connectors/google/client.js";
import type { TokenRecord, TokenStore } from "../../connectors/google/store.js";
import {
  NeedsAttentionError, NotConnectedError,
  type Availability, type CompleteOutcome, type ConnectionHealth, type ConnectionStatus, type Connector, type ConnectorCtx, type ConnectorInfo, type ConnectStart,
} from "../types.js";
import { once } from "../once.js";
import { noteConnection, type ConnectionEvent } from "../graph.js";
import type { GoogleApis } from "./apis.js";
import { consentUrl, googleAvailability, newPkce, SCOPES, type GoogleConnSettings } from "./oauth.js";

const REFRESH_MARGIN_MS = 60_000;

export interface GoogleProductDeps {
  settings: GoogleConnSettings;
  store: TokenStore;
  client: GoogleClient;
  apis: GoogleApis;
}

/** What a tool's callback gets for one call. */
export interface GoogleSession {
  apis: GoogleApis;
  accessToken: string;
  meta: Readonly<Record<string, string>>;
  /** True when the owner allowed this permission (full scope address). */
  allowed(scope: string): boolean;
  account?: string;
}

export interface Choice { value: string; label: string }

export interface ProductSpec {
  info: ConnectorInfo;
  system: { id: string; name: string };
  /** The permissions to ask for, given the owner's options (`{ inbox: "1" }`). */
  scopes(o: Record<string, string>): string[];
  /** Permissions without which the connection is no use: the owner must leave them ticked. */
  required: string[];
  ads?: boolean;
  /** After connecting: find what to read (a property, an account). One answer is used; several are left for the owner to pick. */
  discover?(apis: GoogleApis, accessToken: string): Promise<{ key: string; label: string; choices: Choice[] } | null>;
  /** Words for a refusal when the owner has not picked yet. */
  pickWords?: string;
  needsPickToRun?: boolean;
  extras?(scope: string): string[];
  daily?: (deps: GoogleProductDeps, ctx: ConnectorCtx, session: GoogleSession) => Promise<{ ok: boolean; message: string }>;
}

const split = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);

export class GoogleProductConnector implements Connector {
  readonly info: ConnectorInfo;
  constructor(readonly spec: ProductSpec, readonly deps: GoogleProductDeps) {
    this.info = spec.info;
  }

  availability(): Availability {
    return googleAvailability(this.deps.settings, this.info.name, { ads: this.spec.ads === true });
  }

  private async load(ctx: ConnectorCtx): Promise<TokenRecord | null> {
    return this.deps.store.get(ctx.tenant, this.info.id);
  }

  // The graph learns of the change (src/connections/graph.ts): status, who and when, the edges around the System, the ladder.
  private markSystem(ctx: ConnectorCtx, event: ConnectionEvent, extra: Record<string, string | null> = {}): Promise<string[]> {
    return noteConnection(ctx, { id: this.info.id, system: this.spec.system, provider: "google" }, event, extra);
  }

  private words(): { notConnected: string; attention: string } {
    return {
      notConnected: `${this.info.name} isn't connected yet. Ask the owner to connect it: open Connections in Allevia and tap Connect ${this.info.name}.`,
      attention: `Google stopped letting us use ${this.info.name} (the access was removed or has run out). Ask the owner to connect it again on the Connections page.`,
    };
  }

  async status(ctx: ConnectorCtx): Promise<ConnectionStatus> {
    const rec = await this.load(ctx);
    if (!rec) return { state: "not_connected", message: this.info.blurb };
    const m = rec.meta ?? {};
    if (m.attention) return { state: "needs_attention", message: `Google stopped letting us use ${this.info.name}. Connect it again.` };
    const granted = split(rec.scope);
    const extras = granted.flatMap((s) => this.spec.extras?.(s) ?? []);
    const base = { ...(m.lastReadAt ? { lastReadAt: m.lastReadAt } : {}), ...(extras.length ? { extras } : {}) };
    if (m.choices && !m.selected) {
      const options = (JSON.parse(m.choices) as Choice[]).map((c) => c.label);
      return { state: "connected", message: `You're connected. ${this.spec.pickWords ?? "Pick which one to read."}`, choose: { label: m.choiceLabel ?? "Pick one", options }, ...base };
    }
    const where = m.selectedLabel ?? m.selected;
    return {
      state: "connected", message: `Connected${m.account ? ` as ${m.account}` : ""}${where ? `, reading ${where}` : ""}.`,
      ...(where ? { selected: where } : {}), ...base,
    };
  }

  async connect(ctx: ConnectorCtx, options: Record<string, string> = {}): Promise<ConnectStart> {
    const { verifier, challenge } = newPkce();
    const state = ctx.beginAuth({ verifier, ...(options.inbox === "1" ? { inbox: "1" } : {}) });
    return { url: consentUrl(this.deps.settings, { scopes: [...SCOPES.identity, ...this.spec.scopes(options)], state, challenge }) };
  }

  async complete(ctx: ConnectorCtx, params: Record<string, string>, data: Record<string, string>): Promise<CompleteOutcome> {
    const code = params.code;
    if (!code) throw new ConnectError("google", "Google didn't send a sign-in code. Start again from the app.");
    const now = ctx.now();
    let t;
    try {
      t = await this.deps.client.exchangeCode(code, data.verifier);
    } catch (e) {
      if (e instanceof GoogleAuthError) throw new ConnectError("google", "Google did not accept that sign-in (it may have run out). Try connecting again.");
      throw new ConnectError("google", "We couldn't reach Google just now. Try connecting again in a minute.");
    }
    const granted = split(t.scope);
    const missing = this.spec.required.filter((r) => !granted.includes(r));
    if (missing.length) {
      throw new ConnectError("missing_scope", `We need your permission to use ${this.info.name}, and a box on Google's page was not ticked. Connect again and leave every box ticked.`);
    }
    const existing = await this.load(ctx).catch(() => null);
    const refreshToken = t.refreshToken ?? existing?.refreshToken;
    if (!refreshToken) {
      throw new ConnectError("no_refresh", "Google didn't give us lasting access. In your Google account, open the page that lists apps with access, remove Allevia, and connect again.");
    }
    const account = await this.deps.apis.accountEmail(t.accessToken).catch(() => null);
    let meta: Record<string, string> = { ...(account ? { account } : {}) };
    let outcome: CompleteOutcome = { result: "connected" };
    if (this.spec.discover) {
      const found = await this.spec.discover(this.deps.apis, t.accessToken).catch(() => null);
      if (found?.choices.length === 1) meta = { ...meta, selected: found.choices[0]!.value, selectedLabel: found.choices[0]!.label, selectedKey: found.key };
      else if (found && found.choices.length > 1) { meta = { ...meta, choices: JSON.stringify(found.choices), choiceKey: found.key, choiceLabel: found.label }; outcome = { result: "choose" }; }
      else meta = { ...meta, none: "1" };
    }
    await this.deps.store.put(ctx.tenant, this.info.id, { accessToken: t.accessToken, refreshToken, expiresAt: now + t.expiresIn * 1000, scope: t.scope, obtainedAt: now, meta });
    await this.markSystem(ctx, "connected");
    if (outcome.result === "connected" && this.spec.daily) void this.pull(ctx).catch(() => undefined); // the first look; the daily read retries
    return outcome;
  }

  async select(ctx: ConnectorCtx, value: string): Promise<void> {
    const rec = await this.load(ctx);
    if (!rec?.meta?.choices) throw new ConnectError("not_found", `Connect ${this.info.name} first.`);
    const c = (JSON.parse(rec.meta.choices) as Choice[]).find((x) => x.label === value || x.value === value);
    if (!c) throw new ConnectError("not_found", `That isn't one ${this.info.name} can read for your Google account.`);
    const { choices: _c, choiceKey, choiceLabel: _l, none: _n, ...rest } = rec.meta;
    await this.deps.store.put(ctx.tenant, this.info.id, { ...rec, meta: { ...rest, selected: c.value, selectedLabel: c.label, selectedKey: choiceKey ?? "" } });
    if (this.spec.daily) void this.pull(ctx).catch(() => undefined);
  }

  async disconnect(ctx: ConnectorCtx): Promise<void> {
    const rec = await this.load(ctx).catch(() => null);
    if (rec) await this.deps.client.revoke(rec.refreshToken).catch(() => undefined);
    await this.deps.store.delete(ctx.tenant, this.info.id);
    await this.markSystem(ctx, "disconnected");
  }

  async health(ctx: ConnectorCtx): Promise<ConnectionHealth> {
    const rec = await this.load(ctx).catch(() => null);
    if (!rec) return { ok: false, message: `${this.info.name} isn't connected.` };
    if (rec.meta?.attention) return { ok: false, message: `Google stopped letting us use ${this.info.name}. Connect it again.` };
    try {
      await this.token(ctx, rec, true);
      return { ok: true, message: `Google still lets us use ${this.info.name}.` };
    } catch (e) {
      return { ok: false, message: e instanceof NeedsAttentionError ? e.words : "Google didn't answer just now. We will try again." };
    }
  }

  // A token good for at least a minute (refreshing and storing it when old). A refused refresh marks the connection.
  private async token(ctx: ConnectorCtx, rec: TokenRecord, force = false): Promise<TokenRecord> {
    const now = ctx.now();
    if (!force && rec.expiresAt - REFRESH_MARGIN_MS > now) return rec;
    try {
      const t = await this.deps.client.refresh(rec.refreshToken);
      const next: TokenRecord = { ...rec, accessToken: t.accessToken, refreshToken: t.refreshToken ?? rec.refreshToken, expiresAt: now + t.expiresIn * 1000, scope: rec.scope, obtainedAt: now };
      await this.deps.store.put(ctx.tenant, this.info.id, next);
      return next;
    } catch (e) {
      if (e instanceof GoogleAuthError) {
        await this.needsAttention(ctx, rec);
        throw new NeedsAttentionError(this.info.id, this.info.name, this.words().attention);
      }
      throw e;
    }
  }

  private async needsAttention(ctx: ConnectorCtx, rec: TokenRecord): Promise<void> {
    await this.deps.store.put(ctx.tenant, this.info.id, { ...rec, meta: { ...(rec.meta ?? {}), attention: "1" } }).catch(() => undefined);
    await this.markSystem(ctx, "expired", { lastError: "Google no longer accepts the saved access" });
  }

  /** A live session for one call. Refusals are thrown in the owner's words. */
  async run<T>(ctx: ConnectorCtx, fn: (s: GoogleSession) => Promise<T>): Promise<T> {
    let rec = await this.load(ctx).catch(() => { throw new NeedsAttentionError(this.info.id, this.info.name, this.words().attention); });
    if (!rec) throw new NotConnectedError(this.info.id, this.info.name, this.words().notConnected);
    if (rec.meta?.attention) throw new NeedsAttentionError(this.info.id, this.info.name, this.words().attention);
    if (this.spec.needsPickToRun && !rec.meta?.selected) {
      throw new NeedsAttentionError(this.info.id, this.info.name, `${this.info.name} is connected but the owner has not picked which one to read yet. Ask them to pick it on the Connections page.`);
    }
    rec = await this.token(ctx, rec);
    const make = (r: TokenRecord): GoogleSession => ({
      apis: this.deps.apis, accessToken: r.accessToken, meta: r.meta ?? {}, allowed: (s) => split(r.scope).includes(s), ...(r.meta?.account ? { account: r.meta.account } : {}),
    });
    try {
      return await fn(make(rec));
    } catch (e) {
      if (!(e instanceof GoogleAuthError)) throw e;
      rec = await this.token(ctx, rec, true); // the access token was refused: one forced refresh, then once more
      try {
        return await fn(make(rec));
      } catch (e2) {
        if (e2 instanceof GoogleAuthError) {
          await this.needsAttention(ctx, rec);
          throw new NeedsAttentionError(this.info.id, this.info.name, this.words().attention);
        }
        throw e2;
      }
    }
  }

  pull(ctx: ConnectorCtx): Promise<{ ok: boolean; message: string }> {
    return once(`${ctx.tenant}\u0000${this.info.id}`, () => this.pullNow(ctx));
  }

  private async pullNow(ctx: ConnectorCtx): Promise<{ ok: boolean; message: string }> {
    const daily = this.spec.daily;
    if (!daily) return { ok: false, message: "Nothing to read for this connection." };
    try {
      const r = await this.run(ctx, (s) => daily(this.deps, ctx, s));
      if (r.ok) {
        const rec = await this.load(ctx);
        if (rec) await this.deps.store.put(ctx.tenant, this.info.id, { ...rec, meta: { ...(rec.meta ?? {}), lastReadAt: new Date(ctx.now()).toISOString() } });
      }
      return r;
    } catch (e) {
      if (e instanceof NeedsAttentionError || e instanceof NotConnectedError) return { ok: false, message: e.words };
      const retry = e instanceof GoogleApiError ? e.retryable : true;
      return { ok: false, message: `${retry ? "Google is busy or slow right now" : "Google would not give us the numbers"}. We will try again tomorrow.` };
    }
  }
}
