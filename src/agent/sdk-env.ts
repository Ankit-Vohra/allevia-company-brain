// The environment a Claude Agent SDK child process gets. An allow-list, not a deny-list: calls must run on the
// founder's subscription login, so anything that could reroute them (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
// ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK/VERTEX, …) and every secret of ours (DISCORD_BOT_TOKEN,
// AVS_IG_LOGIN_ACCESS_TOKEN, …) stays out simply by not being listed. Used by ingestion (src/ingest/llm.ts) and the
// agent runtime.
const ALLOWED = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM",
  "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
]);
const ALLOWED_PREFIXES = ["LC_"];

export function subscriptionEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (ALLOWED.has(k) || ALLOWED_PREFIXES.some((p) => k.startsWith(p)))) out[k] = v;
  }
  return out;
}
