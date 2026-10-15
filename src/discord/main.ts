// Starts the Allevia Discord bot for one tenant: the config check (names only, never values), the same ask() deps
// every surface uses (wiring.ts), the API's approval hook, and the discord.js client (client.ts).
// `npm run cli -- discord [--tenant aamdani]` calls startDiscordBot.
import { loadConfig, type AlleviaConfig } from "../config.js";
import { ask } from "../agent/ask.js";
import type { GraphHandle } from "../graph/client.js";
import { AlleviaBot } from "./bot.js";
import type { StartedBot } from "./client.js";

const ENV_NAMES = {
  token: "DISCORD_BOT_TOKEN", appId: "DISCORD_APPLICATION_ID", guildId: "DISCORD_GUILD_ID", channelId: "DISCORD_CHANNEL_ID",
} as const;

// The env names of the Discord settings that are missing (never their values).
export function missingDiscordSettings(cfg: AlleviaConfig): string[] {
  return (Object.keys(ENV_NAMES) as Array<keyof typeof ENV_NAMES>).filter((k) => !cfg.discord[k]).map((k) => ENV_NAMES[k]);
}

// The tenant's IANA time zone (registry entry, else its Business node), for dates in the agents' prompts.
async function tenantTimeZone(tenant: string, g: GraphHandle): Promise<string | undefined> {
  try {
    const { listTenants } = await import("../graph/tenants.js");
    const reg = (await listTenants()).find((t) => t.slug === tenant) as { businessId?: string; timeZone?: string } | undefined;
    if (reg?.timeZone) return reg.timeZone;
    if (!reg?.businessId) return undefined;
    const { businessProps } = await import("../server/reads.js");
    return (await businessProps(g, reg.businessId)).timeZone;
  } catch {
    return undefined;
  }
}

export async function startDiscordBot(o: { tenant: string; model?: string; log?: (line: string) => void }): Promise<StartedBot> {
  const log = o.log ?? ((line: string) => console.error(line));
  const cfg = loadConfig();
  const missing = missingDiscordSettings(cfg);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")} in ~/.config/allevia/allevia.env.`);
  const { token, appId, guildId, channelId } = cfg.discord as Required<AlleviaConfig["discord"]>;

  const { createAskDeps, tenantGraph } = await import("../agent/wiring.js");
  const graph = await tenantGraph(o.tenant);
  const deps = await createAskDeps({ tenant: o.tenant, ...(o.model ? { model: o.model } : {}) }, { graph });
  const timeZone = await tenantTimeZone(o.tenant, graph);
  // The approval hook the API server is given (executors and learning plug in there), so a button press and a web
  // card do the same thing.
  const { productionDeps } = await import("../server/main.js");
  const { onDecision, actions } = productionDeps({ publicMode: false });

  const bot = new AlleviaBot({
    tenant: o.tenant, guildId, channelId, webBase: cfg.webBaseUrl, graph,
    ask: (input, emit) => ask(input, { ...deps, ...(timeZone ? { timeZone } : {}) }, emit),
    ...(onDecision ? { onDecision } : {}),
    ...(actions ? { actions } : {}),
    log,
  });
  const { startClient } = await import("./client.js");
  const started = await startClient(bot, { token, appId, guildId, channelId }, log);
  log(`Allevia on Discord for ${o.tenant}: the demo server's Allevia channel and its threads only. Path links go to ${cfg.webBaseUrl}.`);
  return started;
}
