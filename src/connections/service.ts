// The connections registry: every Connector in one place, per business. It is what the Connections page, Discord's /connect, the
// agents' tools and the executors talk to, so they all see the same truth and every call lands in the same audit log.
//   list / view          what each connection says to an owner (state, one line, what the team does with it)
//   connect / complete   the owner's trip to the provider and back; the `state` that carries it is signed, expires in 10 minutes,
//                        works once, names the business and the connection, and holds a PKCE verifier on the server only
//   connectWithKey       a tool with no sign-in page: the key the owner pasted is passed on, never kept, logged or shown again
//   connectLink / redeemLink   a short one-time address (/c/<code>) for Discord: it names the business and the connection and works once
//   port                 what a tool or an executor uses: `google(id, op, fn)` runs a call for one business with the token handled,
//                        the call audited and a refusal in plain words when the connection is missing or stopped working
//   disconnect / revokeAll / rotateKeys   forgetting one connection, all of a business's connections, or sealing everything with a new key
// A business only ever reaches its own records: the tenant is fixed when the port is made and no call takes one as an argument.
import { randomBytes } from "node:crypto";
import { entryById } from "../../shared/connection-map.js";
import { signState, verifyState } from "../connectors/google/crypto.js";
import type { SealedVault } from "../connectors/google/store.js";
import type { GraphHandle } from "../graph/client.js";
import type { AuditLog } from "./audit.js";
import {
  ConnectProblem, GROUP_ORDER, NeedsAttentionError, NotAllowedError, NotConfiguredError, NotConnectedError,
  type CompleteOutcome, type ConnectionHealth, type ConnectionStatus, type ConnectionView, type Connector, type ConnectorCtx,
} from "./types.js";

const STATE_TTL_MS = 10 * 60_000;

/**
 * The agents' own tool for reading each connection that has one (the same on our own Google app and on Composio), and where its
 * daily read sits in the records. Connections not listed are read with connection_tools and connection_read.
 */
export const READ_WITH: Readonly<Record<string, { tool: string; recorded?: string }>> = {
  "google-analytics": { tool: "ga4_report", recorded: "metric_trend on channel:website, metrics ga4_sessions, ga4_users, ga4_new_users, ga4_conversions and ga4_sessions_from_<source>" },
  "search-console": { tool: "gsc_report", recorded: "metric_trend on channel:google-search, metrics gsc_clicks and gsc_impressions" },
  "google-ads": { tool: "ads_report" },
  "google-calendar": { tool: "calendar_free_slots" },
  gmail: { tool: "gmail_inbox" },
};
const MIN_KEY = 32;

export interface ServiceDeps {
  connectors: Connector[];
  vault: SealedVault<unknown>;
  audit: AuditLog;
  connectorKey: string;
  webBaseUrl: string;
  openGraph: (tenant: string) => Promise<GraphHandle>;
  businessIdOf?: (tenant: string) => Promise<string | undefined>;
  now?: () => number;
  /** A connector for any toolkit in the catalogue, by its slug (`app-<slug>`); absent: only the registered ones. */
  dynamic?: (slug: string) => Connector | null;
  /** Searches the catalogue behind the Connections page's search box; absent: no search. */
  search?: (query: string) => Promise<Array<{ slug: string; name: string; description: string }>>;
  /** Calls allowed per business and connection (a runaway agent cannot hammer someone's account). */
  limits?: { perMinute?: number; perDay?: number };
}

interface Pending { tenant: string; connector: string; data: Record<string, string>; exp: number }

// What a tool or an executor holds for one business.
export interface ConnectionsPort {
  readonly tenant: string;
  status(id: string): Promise<ConnectionStatus>;
  /** Every connection with its state, for the agents' "what can I use" and the starter chips. */
  list(): Promise<ConnectionView[]>;
  /** One short paragraph for an agent's prompt: what is connected, what is not (empty when nothing is configured). */
  note(): Promise<string>;
  /** Runs `fn` with a live session on a connection (the session type belongs to the connector). Refusals are thrown as
   *  NotConnectedError, NeedsAttentionError, NotAllowedError or NotConfiguredError, each with `words` for the owner. */
  run<S, T>(id: string, op: string, fn: (session: S) => Promise<T>, o?: { actor?: string }): Promise<T>;
}

export class ConnectionsService {
  private pending = new Map<string, Pending>();
  private spentLinks = new Map<string, number>();
  readonly now: () => number;
  constructor(private d: ServiceDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  get connectors(): readonly Connector[] { return this.d.connectors; }
  get audit(): AuditLog { return this.d.audit; }
  get vault(): SealedVault<unknown> { return this.d.vault; }
  get webBaseUrl(): string { return this.d.webBaseUrl; }

  private dyn = new Map<string, Connector>();
  connector(id: string): Connector {
    const c = this.d.connectors.find((x) => x.info.id === id) ?? this.dyn.get(id);
    if (c) return c;
    if (id.startsWith("app-") && this.d.dynamic) {
      const made = this.d.dynamic(id.slice(4));
      if (made) { this.dyn.set(id, made); return made; }
    }
    throw new UnknownConnection(id);
  }
  has(id: string): boolean {
    try { this.connector(id); return true; } catch { return false; }
  }

  /** The catalogue behind the search box: toolkits Allevia has not listed itself, each as a connection id and a name. */
  async search(query: string): Promise<Array<{ id: string; name: string; description: string }>> {
    if (!this.d.search || query.trim().length < 2) return [];
    const found = await this.d.search(query.trim().slice(0, 60)).catch(() => []);
    return found.filter((f) => /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(f.slug)).slice(0, 20).map((f) => ({ id: `app-${f.slug}`, name: f.name, description: f.description.slice(0, 200) }));
  }

  private keyOk(): boolean { return typeof this.d.connectorKey === "string" && this.d.connectorKey.length >= MIN_KEY; }

  private sweep(): void {
    const t = this.now();
    for (const [k, p] of this.pending) if (p.exp < t) this.pending.delete(k);
    for (const [k, e] of this.spentLinks) if (e < t) this.spentLinks.delete(k);
  }

  ctx(tenant: string, connectorId: string, businessId?: string, extra: Record<string, string> = {}): ConnectorCtx {
    let graph: Promise<GraphHandle> | undefined;
    return {
      tenant, ...(businessId ? { businessId } : {}),
      graph: () => (graph ??= this.d.openGraph(tenant)),
      now: this.now, vault: this.d.vault, webBaseUrl: this.d.webBaseUrl,
      beginAuth: (data = {}) => {
        if (!this.keyOk()) throw new NotConfiguredError(connectorId, { ok: false, message: "Connecting isn't switched on yet.", missing: [{ setting: "ALLEVIA_CONNECTOR_KEY", words: "the key that locks stored connections (at least 32 characters)" }] });
        this.sweep();
        const nonce = randomBytes(16).toString("hex");
        const exp = this.now() + STATE_TTL_MS;
        this.pending.set(nonce, { tenant, connector: connectorId, data: { ...data, ...extra }, exp });
        return signState(this.d.connectorKey, { k: "auth", t: tenant, c: connectorId, e: exp, n: nonce });
      },
      audit: (op, ok, detail) => this.d.audit.append({ at: this.now(), tenant, connector: connectorId, op, ok, ...(detail ? { detail } : {}) }).catch(() => undefined),
    };
  }

  private async businessId(tenant: string): Promise<string | undefined> {
    return this.d.businessIdOf ? await this.d.businessIdOf(tenant).catch(() => undefined) : undefined;
  }

  private async ctxFor(tenant: string, id: string, extra: Record<string, string> = {}): Promise<{ c: Connector; ctx: ConnectorCtx }> {
    const c = this.connector(id);
    return { c, ctx: this.ctx(tenant, id, await this.businessId(tenant), extra) };
  }

  // ---------- what an owner reads ----------

  async view(tenant: string, id: string): Promise<ConnectionView> {
    const { c, ctx } = await this.ctxFor(tenant, id);
    const a = c.availability();
    const slug = entryById(c.info.id)?.toolkit ?? (c.info.id.startsWith("app-") ? c.info.id.slice(4) : undefined);
    const base = {
      id: c.info.id, name: c.info.name, group: c.info.group, blurb: c.info.blurb, reads: c.info.reads, acts: c.info.acts,
      access: c.info.acts.length ? "read_act" as const : "read" as const, ...(slug ? { logo: `https://logos.composio.dev/api/${slug}` } : {}),
    };
    if (!a.ok) {
      return {
        ...base, state: "not_connected", message: a.message, available: false, unavailableWords: a.message, ...(a.soon ? { soon: true } : {}),
      };
    }
    let s: ConnectionStatus;
    try {
      s = await c.status(ctx);
    } catch {
      s = { state: "needs_attention", message: `We can't open the saved ${c.info.name} connection any more. Connect it again.` };
    }
    return { ...base, ...s, available: true };
  }

  async list(tenant: string): Promise<ConnectionView[]> {
    const extra = (await this.d.vault.list(tenant).catch(() => [] as string[])).filter((n) => n.startsWith("app-") && !this.d.connectors.some((c) => c.info.id === n) && this.has(n));
    const views = await Promise.all([...this.d.connectors.map((c) => c.info.id), ...extra].map((id) => this.view(tenant, id)));
    return views.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }

  // ---------- connecting ----------

  async connect(tenant: string, id: string, options: Record<string, string> = {}): Promise<{ url: string }> {
    const { c, ctx } = await this.ctxFor(tenant, id, options.returnTo ? { returnTo: options.returnTo } : {});
    const a = c.availability();
    if (!a.ok) throw new NotConfiguredError(id, a);
    const start = await c.connect(ctx, options);
    await ctx.audit("connect started", true);
    return start;
  }

  /** Connects a tool with the key the owner pasted on the sheet. The key goes to the connector and on to the provider's service;
   *  the audit line says only that it happened, never what was pasted. */
  async connectWithKey(tenant: string, id: string, values: Record<string, string>): Promise<{ message: string; view: ConnectionView }> {
    const { c, ctx } = await this.ctxFor(tenant, id);
    const a = c.availability();
    if (!a.ok) throw new NotConfiguredError(id, a);
    if (!this.keyOk()) throw new NotConfiguredError(id, { ok: false, message: "Connecting isn't switched on yet.", missing: [{ setting: "ALLEVIA_CONNECTOR_KEY", words: "the key that locks stored connections (at least 32 characters)" }] });
    if (!c.connectWithKey) throw new ConnectProblem(id, `${c.info.name} doesn't take a key here. Tap Connect and sign in instead.`);
    try {
      const r = await c.connectWithKey(ctx, values);
      await ctx.audit("connected with a key", true);
      return { message: r.message, view: await this.view(tenant, id) };
    } catch (e) {
      await ctx.audit("connected with a key", false, e instanceof ConnectProblem ? e.message : "failed");
      throw e;
    }
  }

  /** A short address that starts the connection when opened, once, for 10 minutes: for Discord, where there is no web session. */
  connectLink(tenant: string, id: string, options: Record<string, string> = {}): string {
    this.connector(id);
    if (!this.keyOk()) throw new NotConfiguredError(id, { ok: false, message: "Connecting isn't switched on yet.", missing: [{ setting: "ALLEVIA_CONNECTOR_KEY", words: "the key that locks stored connections (at least 32 characters)" }] });
    const code = signState(this.d.connectorKey, { k: "link", t: tenant, c: id, e: this.now() + STATE_TTL_MS, n: randomBytes(12).toString("hex"), ...(options.inbox ? { i: "1" } : {}) });
    return `${this.d.webBaseUrl}/c/${code}`;
  }

  /** The tenant and connection a link was made for, once, while it is fresh; null for anything forged, old or already used. */
  redeemLink(code: string): { tenant: string; id: string; options: Record<string, string> } | null {
    if (!this.keyOk()) return null;
    const p = verifyState<{ k: string; t: string; c: string; e: number; n: string; i?: string }>(this.d.connectorKey, code);
    this.sweep();
    if (!p || p.k !== "link" || typeof p.t !== "string" || typeof p.c !== "string" || typeof p.n !== "string" || typeof p.e !== "number" || p.e < this.now()) return null;
    if (this.spentLinks.has(p.n)) return null;
    this.spentLinks.set(p.n, p.e);
    if (!this.has(p.c)) return null;
    return { tenant: p.t, id: p.c, options: p.i === "1" ? { inbox: "1" } : {} };
  }

  /** True for any state this service signed (even one that has run out or was used), so the older handler never sees it. */
  ownsState(state: string): boolean {
    return this.keyOk() && verifyState<{ k: string }>(this.d.connectorKey, state)?.k === "auth";
  }

  /** The business and connection a returning `state` was made for, without using it up (the callback route needs the tenant first). */
  peekState(state: string): { tenant: string; id: string } | null {
    if (!this.keyOk()) return null;
    const p = verifyState<{ k: string; t: string; c: string; e: number; n: string }>(this.d.connectorKey, state);
    if (!p || p.k !== "auth" || typeof p.e !== "number" || p.e < this.now() || !this.pending.has(p.n)) return null;
    return { tenant: p.t, id: p.c };
  }

  /** The owner came back from the provider. The state is used up here whatever happens next. */
  async complete(state: string, params: Record<string, string>): Promise<{ tenant: string; id: string; outcome: CompleteOutcome; returnTo?: string } | null> {
    if (!this.keyOk()) return null;
    const p = verifyState<{ k: string; t: string; c: string; e: number; n: string }>(this.d.connectorKey, state);
    this.sweep();
    if (!p || p.k !== "auth" || typeof p.e !== "number" || p.e < this.now()) return null;
    const pend = this.pending.get(p.n);
    this.pending.delete(p.n);
    if (!pend || pend.tenant !== p.t || pend.connector !== p.c || !this.has(p.c)) return null;
    const { c, ctx } = await this.ctxFor(p.t, p.c);
    let outcome: CompleteOutcome;
    try {
      outcome = params.error ? { result: "denied" } : await c.complete(ctx, params, pend.data);
    } catch (e) {
      outcome = { result: "problem", reason: e instanceof Error && e.name === "ConnectError" ? (e as { code?: string }).code ?? "problem" : "problem" };
      await ctx.audit("connect finished", false, e instanceof Error ? e.message : "failed");
      return { tenant: p.t, id: p.c, outcome, ...(pend.data.returnTo ? { returnTo: pend.data.returnTo } : {}) };
    }
    await ctx.audit("connect finished", outcome.result === "connected" || outcome.result === "choose", outcome.result);
    return { tenant: p.t, id: p.c, outcome, ...(pend.data.returnTo ? { returnTo: pend.data.returnTo } : {}) };
  }

  async select(tenant: string, id: string, value: string): Promise<ConnectionView> {
    const { c, ctx } = await this.ctxFor(tenant, id);
    if (!c.select) throw new Error("Nothing to pick for this connection.");
    await c.select(ctx, value);
    await ctx.audit("choice made", true);
    return this.view(tenant, id);
  }

  async disconnect(tenant: string, id: string): Promise<ConnectionView> {
    const { c, ctx } = await this.ctxFor(tenant, id);
    await c.disconnect(ctx);
    await ctx.audit("disconnected", true);
    return this.view(tenant, id);
  }

  async health(tenant: string, id: string): Promise<ConnectionHealth> {
    const { c, ctx } = await this.ctxFor(tenant, id);
    if (!c.availability().ok) return { ok: false, message: c.availability().message };
    try {
      return await c.health(ctx);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "It didn't answer." };
    }
  }

  async pull(tenant: string, id: string): Promise<{ ok: boolean; message: string }> {
    const { c, ctx } = await this.ctxFor(tenant, id);
    if (!c.pull) return { ok: false, message: "Nothing to read for this connection." };
    const t0 = this.now();
    const r = await c.pull(ctx);
    await this.d.audit.append({ at: t0, tenant, connector: id, op: "daily read", ok: r.ok, ms: this.now() - t0, ...(r.ok ? {} : { detail: r.message }) }).catch(() => undefined);
    return r;
  }

  /** The daily read for every connected business: `minHours` apart, one bad business never stops the others. */
  async pullDue(tenants: Array<{ slug: string }>, o: { force?: boolean; log?: (l: string) => void } = {}): Promise<Array<{ tenant: string; connector: string; ok: boolean; message: string } | { tenant: string; connector: string; skipped: string }>> {
    const out: Array<{ tenant: string; connector: string; ok: boolean; message: string } | { tenant: string; connector: string; skipped: string }> = [];
    const log = o.log ?? ((l: string) => console.error(l));
    for (const t of tenants) {
      const named = new Set(await this.d.vault.list(t.slug).catch(() => [] as string[]));
      for (const c of this.d.connectors) {
        if (!c.pull || !named.has(c.info.id) || !c.availability().ok) continue;
        try {
          const ctx = this.ctx(t.slug, c.info.id, await this.businessId(t.slug));
          const s = await c.status(ctx);
          if (s.state !== "connected") { out.push({ tenant: t.slug, connector: c.info.id, skipped: s.state === "needs_attention" ? "needs the owner to connect again" : "not connected" }); continue; }
          if (!o.force && s.lastReadAt && this.now() - Date.parse(s.lastReadAt) < 20 * 3_600_000) { out.push({ tenant: t.slug, connector: c.info.id, skipped: "read recently" }); continue; }
          out.push({ tenant: t.slug, connector: c.info.id, ...(await this.pull(t.slug, c.info.id)) });
        } catch (e) {
          log(`[connections] ${t.slug}/${c.info.id}: ${e instanceof Error ? e.message : String(e)}`);
          out.push({ tenant: t.slug, connector: c.info.id, ok: false, message: "Something went wrong reading it. We will try again." });
        }
      }
    }
    return out;
  }

  /** Revokes every connection a business has and forgets everything stored for it. */
  async revokeAll(tenant: string): Promise<{ disconnected: string[] }> {
    const done: string[] = [];
    for (const name of await this.d.vault.list(tenant)) {
      const c = this.d.connectors.find((x) => x.info.id === name);
      if (!c) continue;
      try {
        await c.disconnect(this.ctx(tenant, name, await this.businessId(tenant)));
        done.push(name);
      } catch {
        // the stored copy is deleted below either way
      }
    }
    await this.d.vault.deleteTenant(tenant);
    await this.d.audit.append({ at: this.now(), tenant, connector: "all", op: "revoked everything", ok: true }).catch(() => undefined);
    return { disconnected: done };
  }

  rotateKeys(): Promise<{ rotated: number; unreadable: string[] }> { return this.d.vault.rotateAll(); }

  // ---------- limits and the prompt note ----------

  private calls = new Map<string, number[]>();
  private allow(tenant: string, id: string): boolean {
    const now = this.now();
    const key = `${tenant}\u0000${id}`;
    const day = (this.calls.get(key) ?? []).filter((t) => now - t < 86_400_000);
    const perMinute = this.d.limits?.perMinute ?? 30, perDay = this.d.limits?.perDay ?? 2000;
    if (day.length >= perDay || day.filter((t) => now - t < 60_000).length >= perMinute) { this.calls.set(key, day); return false; }
    day.push(now);
    this.calls.set(key, day);
    return true;
  }

  /** What an agent is told at the start of a turn: which tools of this business it can use, and which it could ask for. */
  async note(tenant: string): Promise<string> {
    const views = await this.list(tenant).catch(() => [] as ConnectionView[]);
    const usable = views.filter((v) => v.available);
    if (!usable.length) return "";
    const on = usable.filter((v) => v.state === "connected");
    const attention = usable.filter((v) => v.state === "needs_attention");
    const off = usable.filter((v) => v.state === "not_connected" && v.id.indexOf("app-") !== 0).slice(0, 8);
    const readable = on.filter((v) => READ_WITH[v.id]);
    return [
      `Connected tools of this business: ${on.length ? on.map((v) => `${v.name} (${v.id})`).join(", ") : "none yet"}.`,
      // a connected tool is readable whichever way it is connected (our own Google app or Composio): name the tool that reads it
      readable.length ? `Read them with their own tools: ${readable.map((v) => `${v.name} with ${READ_WITH[v.id]!.tool}${READ_WITH[v.id]!.recorded ? ` (its daily read is also in the records: ${READ_WITH[v.id]!.recorded})` : ""}`).join("; ")}. Use these before saying a number is not available.` : "",
      attention.length ? `These stopped working and need the owner to connect them again: ${attention.map((v) => v.name).join(", ")}.` : "",
      off.length ? `Not connected yet: ${off.map((v) => `${v.name} (${v.id})`).join(", ")}.` : "",
      "Use connections_available to see which ones you may use, connection_read to look something up and connection_act to propose a change. If a job needs a tool that is not connected, say so plainly and give the owner this link: [Connect <name>](/connections?connect=<id>). Never invent data from a tool that is not connected.",
    ].filter(Boolean).join(" ");
  }

  // ---------- what tools and executors use ----------

  port(tenant: string, defaults: { actor?: string } = {}): ConnectionsPort {
    return {
      tenant,
      status: async (id) => (await this.view(tenant, id)),
      list: () => this.list(tenant),
      note: () => this.note(tenant),
      run: async <S, T>(id: string, op: string, fn: (session: S) => Promise<T>, o: { actor?: string } = {}): Promise<T> => {
        const c = this.connector(id);
        const a = c.availability();
        const actor = o.actor ?? defaults.actor;
        const t0 = this.now();
        const record = (ok: boolean, detail?: string) =>
          this.d.audit.append({ at: t0, tenant, connector: id, op, ok, ms: this.now() - t0, ...(detail ? { detail } : {}), ...(actor ? { actor } : {}) }).catch(() => undefined);
        if (!a.ok) { await record(false, "not switched on"); throw new NotConfiguredError(id, a); }
        if (!this.allow(tenant, id)) { await record(false, "too many calls"); throw new RateLimitedError(id, c.info.name); }
        const run = (c as Connector & { run?: (ctx: ConnectorCtx, fn: (s: unknown) => Promise<unknown>) => Promise<unknown> }).run;
        if (!run) throw new Error(`${c.info.name} has no live session.`);
        const ctx = this.ctx(tenant, id, await this.businessId(tenant));
        try {
          const v = (await run.call(c, ctx, fn as (s: unknown) => Promise<unknown>)) as T;
          await record(true);
          return v;
        } catch (e) {
          const refusal = e instanceof NotConnectedError || e instanceof NeedsAttentionError || e instanceof NotAllowedError;
          await record(false, refusal ? e.name : e instanceof Error ? e.message : "failed");
          throw e;
        }
      },
    };
  }
}

export class RateLimitedError extends Error {
  override name = "RateLimitedError";
  readonly words: string;
  constructor(readonly connector: string, readonly connectorName: string) {
    super(`That is a lot of calls to ${connectorName} in a short time, so this one was held back. Try again in a minute or two.`);
    this.words = this.message;
  }
}

export class UnknownConnection extends Error {
  override name = "UnknownConnection";
  constructor(readonly id: string) {
    super(`There is no connection called "${id.slice(0, 40)}".`);
  }
}
