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

// The env is half the guard; the SDK's own word is the other half. Every query() starts with a system:init message whose
// apiKeySource says where the credential for its API calls came from. "none" means no API key is in use: the claude.ai
// subscription login (or a bearer token or a cloud provider, which subscriptionEnv keeps out of the child's env);
// "oauth" is a legacy value for the same. Anything else ("ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key" —
// a Console API key stored by /login — the legacy "user"/"project"/"org"/"temporary", a value this code does not know,
// or no value at all) means the call may be billed to an API key, so the caller must stop before using it.
const SUBSCRIPTION_KEY_SOURCES = new Set(["none", "oauth"]);

export class NotOnSubscriptionError extends Error {
  override name = "NotOnSubscriptionError";
}

// Returns the apiKeySource when it is the subscription; throws NotOnSubscriptionError otherwise (fail closed).
export function assertSubscription(initMessage: { apiKeySource?: unknown }): string {
  const src = initMessage.apiKeySource;
  if (typeof src === "string" && SUBSCRIPTION_KEY_SOURCES.has(src)) return src;
  const seen = src === undefined ? "apiKeySource missing" : `apiKeySource ${JSON.stringify(src)}`;
  throw new NotOnSubscriptionError(
    `Claude would not run on the founder's subscription (${seen} in the SDK init message): the call may be billed to an ` +
    "API key, so it was stopped. Allevia only runs on the subscription: remove ANTHROPIC_API_KEY and any apiKeyHelper, " +
    "and sign in with `claude /login` using the claude.ai account (not a Console API key).",
  );
}
