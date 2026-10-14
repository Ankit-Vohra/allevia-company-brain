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
  discord: { token?: string; appId?: string; guildId?: string; channelId?: string };
  avsIg: { token?: string; userId?: string };
  // `via` is the ssh alias the box is actually reached through (EC2 Instance Connect); host/user/keyPath describe it.
  opsSsh: { host: string; user: string; keyPath: string; remoteDir: string; via: string };
  githubActionRepo: string;
  publicMode: boolean;
  port: number;
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
    },
    avsIg: { token: get("AVS_IG_LOGIN_ACCESS_TOKEN"), userId: get("AVS_IG_USER_ID") },
    opsSsh: {
      host: get("ALLEVIA_OPS_SSH_HOST") ?? "203.0.113.10",
      user: get("ALLEVIA_OPS_SSH_USER") ?? "ankit",
      keyPath: expandHome(get("ALLEVIA_OPS_SSH_KEY") ?? "~/.ssh/example-key.pem"),
      remoteDir: get("ALLEVIA_OPS_REMOTE_DIR") ?? "/home/ankit/aamdani-social-automation",
      via: get("ALLEVIA_OPS_SSH_VIA") ?? "aamdani-box",
    },
    githubActionRepo: get("ALLEVIA_ACTION_REPO") ?? "Ankit-Vohra/allevia",
    publicMode: /^(1|true|yes|on)$/i.test(get("ALLEVIA_PUBLIC_MODE") ?? ""),
    port,
  };
}
