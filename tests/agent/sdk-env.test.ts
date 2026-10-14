import { describe, it, expect } from "vitest";
import { subscriptionEnv } from "../../src/agent/sdk-env.js";

describe("subscriptionEnv", () => {
  const parent = {
    PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", SHELL: "/bin/zsh", LANG: "en_IN.UTF-8", LC_ALL: "en_IN.UTF-8", LC_CTYPE: "UTF-8",
    TMPDIR: "/t", TERM: "xterm", https_proxy: "http://p", HTTPS_PROXY: "http://p", no_proxy: "localhost", NO_PROXY: "localhost",
    http_proxy: "http://p", HTTP_PROXY: "http://p", NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/cert.pem",
    CLAUDE_CONFIG_DIR: "/h/.claude", CLAUDE_CODE_OAUTH_TOKEN: "oauth-placeholder",
    // none of these may reach the child
    ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://proxy.example", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", DISCORD_BOT_TOKEN: "d", AVS_IG_LOGIN_ACCESS_TOKEN: "ig",
    AWS_SECRET_ACCESS_KEY: "aws", NODE_OPTIONS: "--require x", EMPTY: undefined,
  };

  it("passes only the allow-list", () => {
    const env = subscriptionEnv(parent);
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME",
      "NODE_EXTRA_CA_CERTS", "NO_PROXY", "PATH", "SHELL", "SSL_CERT_FILE", "TERM", "TMPDIR", "USER", "http_proxy", "https_proxy", "no_proxy",
    ].sort());
    expect(env.PATH).toBe("/bin");
  });

  it("never passes a token, key or base URL that would move calls off the subscription", () => {
    const env = subscriptionEnv(parent);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
      "DISCORD_BOT_TOKEN", "AVS_IG_LOGIN_ACCESS_TOKEN", "CLAUDECODE", "NODE_OPTIONS"]) {
      expect(k in env).toBe(false);
    }
  });
});
