// Typed config. Secrets live in ~/.config/allevia/allevia.env (KEY=VALUE lines, # comments), outside the repo;
// process env overrides the file. ALLEVIA_ENV_FILE points somewhere else (tests use a temp file).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AlleviaConfig {
  falkordbUrl: string;
  model: string;
  extractModel: string;
  dataDir: string;
  brainPath: string;
  // guildId/channelId: the old single-channel demo server. hubGuildId/staffRoleId: the customer hub (hub mode is on
  // when DISCORD_HUB_GUILD_ID is set); the token and application id are the one shared bot's, for both.
  discord: { token?: string; appId?: string; guildId?: string; channelId?: string; hubGuildId?: string; staffRoleId?: string };
  avsIg: { token?: string; userId?: string };
  // `via` is the ssh alias the box is actually reached through (EC2 Instance Connect); host/user/keyPath describe it.
  opsSsh: { host: string; user: string; keyPath: string; remoteDir: string; via: string };
  githubActionRepo: string;
  publicMode: boolean;
  authRequired: boolean; // ALLEVIA_AUTH=1: every /api/:t/... route needs that business's owner token (src/auth); only demo businesses open without one
  actionsLive: boolean; // approved github_issue / discord_post cards really create the issue / post (default: dry run)
  actionTenants: string[]; // businesses besides the founder's own (tenant-config.ts) that may use the env file's GitHub repo and Discord channel
  port: number;
  webBaseUrl: string; // where the web app is reached, for links from Discord (default http://127.0.0.1:<port>)
  // The OAuth app a business connects its Google accounts through (docs/connectors-setup.md). redirectUri must be exactly
  // what is registered in the Google Cloud console; connectorKey seals the stored tokens (>= 32 characters).
  // enabled: ALLEVIA_SEARCH_CONSOLE=1; off by default (the connector is built against a fake and parked for now).
  google: { enabled: boolean; clientId?: string; clientSecret?: string; redirectUri: string; connectorKey?: string };
  // The optional paid keyword layer (src/checkup/dataforseo.ts): off unless both are set; a per-business monthly budget.
  dataforseo: { credentials: { login: string; password: string } | null; monthlyBudgetUsd: number };
}

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ENV_FILE = "~/.config/allevia/allevia.env";

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// KEY=VALUE per line. Supports `export KEY=…`, single/double quotes, and ` # comment` after unquoted values.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    const q = value[0];
    if ((q === '"' || q === "'") && value.indexOf(q, 1) > 0) value = value.slice(1, value.indexOf(q, 1));
    else value = value.replace(/\s+#.*$/, "").trim();
    out[m[1]!] = value;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AlleviaConfig {
  const file = expandHome(env.ALLEVIA_ENV_FILE || DEFAULT_ENV_FILE);
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const get = (k: string): string | undefined => {
    const v = env[k] ?? fromFile[k];
    return v === undefined || v === "" ? undefined : v;
  };
  const port = Number(get("PORT") ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a TCP port, got "${get("PORT")}"`);
  const webBaseUrl = (get("ALLEVIA_WEB_URL") ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  return {
    falkordbUrl: get("ALLEVIA_FALKORDB_URL") ?? "redis://127.0.0.1:6390",
    model: get("ALLEVIA_MODEL") ?? "sonnet",
    extractModel: get("ALLEVIA_EXTRACT_MODEL") ?? "haiku",
    dataDir: expandHome(get("ALLEVIA_DATA_DIR") ?? join(REPO_ROOT, "data")),
    brainPath: expandHome(get("ALLEVIA_BRAIN_PATH") ?? "~/aamdani-brain"),
    discord: {
      token: get("DISCORD_BOT_TOKEN"),
      appId: get("DISCORD_APPLICATION_ID"),
      guildId: get("DISCORD_GUILD_ID"),
      channelId: get("DISCORD_CHANNEL_ID"),
      hubGuildId: get("DISCORD_HUB_GUILD_ID"),
      staffRoleId: get("DISCORD_STAFF_ROLE_ID"),
    },
    avsIg: { token: get("AVS_IG_LOGIN_ACCESS_TOKEN"), userId: get("AVS_IG_USER_ID") },
    opsSsh: {
      // Host and key are only needed when ALLEVIA_OPS_SSH_VIA=none; real values live in the env file, not in code.
      host: get("ALLEVIA_OPS_SSH_HOST") ?? "",
      user: get("ALLEVIA_OPS_SSH_USER") ?? "ankit",
      keyPath: expandHome(get("ALLEVIA_OPS_SSH_KEY") ?? ""),
      remoteDir: get("ALLEVIA_OPS_REMOTE_DIR") ?? "/home/ankit/aamdani-social-automation",
      via: get("ALLEVIA_OPS_SSH_VIA") ?? "aamdani-box",
    },
    githubActionRepo: get("ALLEVIA_ACTION_REPO") ?? "Ankit-Vohra/allevia",
    publicMode: /^(1|true|yes|on)$/i.test(get("ALLEVIA_PUBLIC_MODE") ?? ""),
    authRequired: /^(1|true|yes|on)$/i.test(get("ALLEVIA_AUTH") ?? ""),
    actionsLive: (get("ALLEVIA_ACTIONS_LIVE") ?? "") === "1",
    actionTenants: (get("ALLEVIA_ACTION_TENANTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    port,
    webBaseUrl,
    google: {
      enabled: (get("ALLEVIA_SEARCH_CONSOLE") ?? "") === "1",
      clientId: get("ALLEVIA_GOOGLE_CLIENT_ID"),
      clientSecret: get("ALLEVIA_GOOGLE_CLIENT_SECRET"),
      redirectUri: get("ALLEVIA_GOOGLE_REDIRECT_URI") ?? `${webBaseUrl}/api/connectors/google/callback`,
      connectorKey: get("ALLEVIA_CONNECTOR_KEY"),
    },
    dataforseo: {
      credentials: get("DATAFORSEO_LOGIN") && get("DATAFORSEO_PASSWORD") ? { login: get("DATAFORSEO_LOGIN")!, password: get("DATAFORSEO_PASSWORD")! } : null,
      monthlyBudgetUsd: budget(get("DATAFORSEO_MONTHLY_BUDGET_USD")),
    },
  };
}

// A dollar budget from the env file: a non-negative number, else the default of $1.
function budget(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : 1;
}
