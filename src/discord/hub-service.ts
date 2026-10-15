// The hub as the rest of Allevia uses it: built from the config (DISCORD_HUB_GUILD_ID, DISCORD_STAFF_ROLE_ID, and the
// shared bot's DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID), then handed to the API server (onboarding hook, Home page),
// the CLI (`discord-hub`) and the bot process. Hub mode is on exactly when DISCORD_HUB_GUILD_ID is set.
import type { DiscordHome, DiscordInfo } from "../../shared/contracts.js";
import { loadConfig, type AlleviaConfig } from "../config.js";
import { getTenant } from "../graph/tenants.js";
import { checkHub, type Check } from "./hub-check.js";
import { GraphHubStore } from "./hub-store.js";
import { provisionCustomer, homeInfo, retryDue, type ProvisionDeps, type ProvisionResult } from "./hub-provision.js";
import { BOT_PERMISSION_INTEGER, type HubPort, type HubStore } from "./hub-types.js";

export interface HubSettings { token: string; appId?: string; guildId: string; staffRoleId: string }

// Is the hub switched on, and is anything missing (env names only, never values)?
export function hubSettings(cfg: AlleviaConfig): { configured: boolean; settings?: HubSettings; missing: string[] } {
  const d = cfg.discord;
  if (!d.hubGuildId) return { configured: false, missing: [] };
  const missing = [
    ...(d.token ? [] : ["DISCORD_BOT_TOKEN"]),
    ...(d.staffRoleId ? [] : ["DISCORD_STAFF_ROLE_ID"]),
  ];
  if (missing.length) return { configured: true, missing };
  return { configured: true, missing, settings: { token: d.token!, ...(d.appId ? { appId: d.appId } : {}), guildId: d.hubGuildId, staffRoleId: d.staffRoleId! } };
}

// The link that adds the shared bot to the hub with exactly the permissions it needs.
export const hubInviteUrl = (appId: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot%20applications.commands&permissions=${BOT_PERMISSION_INTEGER}`;

export interface HubService {
  guildId: string;
  deps: ProvisionDeps;
  provision(slug: string): Promise<ProvisionResult>;
  /** The onboarding hook: never throws. A link, or `later: true` when it is not ready (the retry loop finishes it). */
  afterOnboarding(slug: string, timeoutMs?: number): Promise<DiscordInfo>;
  home(slug: string): Promise<DiscordHome>;
  /** A fresh single-use link (the old one stops working). At most one a minute per business. */
  newLink(slug: string): Promise<DiscordHome>;
  retryDue(): ReturnType<typeof retryDue>;
  startRetryLoop(everyMs?: number): () => void;
}

export function createHubService(deps: ProvisionDeps): HubService {
  const log = deps.log ?? (() => {});
  const lastLink = new Map<string, number>();
  const now = () => (deps.now ?? Date.now)();
  const svc: HubService = {
    guildId: deps.hub.guildId,
    deps,
    provision: (slug) => provisionCustomer(slug, deps),
    async afterOnboarding(slug, timeoutMs = 20_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const run = provisionCustomer(slug, deps);
        run.catch(() => undefined);
        const r = await Promise.race([
          run,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("still being set up")), timeoutMs); }),
        ]);
        return r.inviteUrl ? { inviteUrl: r.inviteUrl } : {};
      } catch (e) {
        log(`[hub] ${slug}: the Discord area is not ready yet (${e instanceof Error ? e.message : String(e)}); it will be retried`);
        return { later: true };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    home: (slug) => homeInfo(slug, deps),
    async newLink(slug) {
      const last = lastLink.get(slug) ?? 0;
      if (now() - last < 60_000) throw new Error("A new link was made a moment ago. Give it a minute.");
      lastLink.set(slug, now());
      await provisionCustomer(slug, deps, { newInvite: true });
      return homeInfo(slug, deps);
    },
    retryDue: () => retryDue(deps),
    startRetryLoop(everyMs = 5 * 60_000) {
      const tick = () => { svc.retryDue().then((rs) => { for (const r of rs) log(`[hub] retry ${r.slug}: ${r.ok ? "ready" : `failed (${r.error})`}`); }, (e) => log(`[hub] retry: ${e instanceof Error ? e.message : String(e)}`)); };
      tick();
      const t = setInterval(tick, everyMs);
      t.unref();
      return () => clearInterval(t);
    },
  };
  return svc;
}

// The real thing: the REST port with the shared bot's token, the allevia_meta store and the tenant registry. null when
// the hub is off or its settings are incomplete (the reason is logged by the caller via hubSettings).
export async function productionHub(opts: { cfg?: AlleviaConfig; log?: (line: string) => void; store?: HubStore; hub?: HubPort } = {}): Promise<HubService | null> {
  const cfg = opts.cfg ?? loadConfig();
  const s = hubSettings(cfg);
  if (!s.settings) return null;
  let hub = opts.hub;
  let redact = (x: string) => x;
  if (!hub) {
    const { REST } = await import("discord.js");
    const { RestHubPort } = await import("./hub-rest.js");
    const { redactor } = await import("./client.js");
    redact = redactor(s.settings.token);
    hub = new RestHubPort(new REST({ version: "10" }).setToken(s.settings.token), s.settings.guildId);
  }
  return createHubService({
    hub, store: opts.store ?? new GraphHubStore(), staffRoleId: s.settings.staffRoleId, redact,
    tenant: async (slug) => { const t = await getTenant(slug); return t ? { name: t.name } : null; },
    ...(opts.log ? { log: opts.log } : {}),
  });
}

// `discord-hub status`: the read-only checks, built straight from the config (it must work when settings are missing,
// and it never creates or changes anything).
export async function hubStatusChecks(over: { cfg?: AlleviaConfig; hub?: HubPort; store?: HubStore } = {}): Promise<Check[]> {
  const cfg = over.cfg ?? loadConfig();
  const d = cfg.discord;
  let hub = over.hub;
  if (!hub && d.token && d.hubGuildId) {
    const { REST } = await import("discord.js");
    const { RestHubPort } = await import("./hub-rest.js");
    hub = new RestHubPort(new REST({ version: "10" }).setToken(d.token), d.hubGuildId);
  }
  return checkHub({
    settings: { token: !!d.token, appId: !!d.appId, ...(d.hubGuildId ? { guildId: d.hubGuildId } : {}), ...(d.staffRoleId ? { staffRoleId: d.staffRoleId } : {}) },
    ...(hub ? { hub } : {}), store: over.store ?? new GraphHubStore(), ...(d.appId ? { inviteUrl: hubInviteUrl(d.appId) } : {}),
  });
}
