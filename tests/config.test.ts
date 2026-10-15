import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let dir: string;
  let envFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "allevia-config-"));
    envFile = join(dir, "allevia.env");
    writeFileSync(envFile, [
      "# a comment",
      "",
      "ALLEVIA_MODEL=opus",
      "export ALLEVIA_EXTRACT_MODEL='sonnet'",
      'DISCORD_BOT_TOKEN="tok-from-file # not a comment"',
      "DISCORD_GUILD_ID=123 # trailing comment",
      "DISCORD_HUB_GUILD_ID=555000111",
      "DISCORD_STAFF_ROLE_ID=555000222",
      "ALLEVIA_BRAIN_PATH=~/brain-test",
      "ALLEVIA_PUBLIC_MODE=true",
      "PORT=9999",
      "   # indented comment",
      "not a valid line",
    ].join("\n"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("uses defaults when the env file is missing", () => {
    const c = loadConfig({ ALLEVIA_ENV_FILE: join(dir, "missing.env") });
    expect(c.falkordbUrl).toBe("redis://127.0.0.1:6390");
    expect(c.model).toBe("sonnet");
    expect(c.extractModel).toBe("haiku");
    expect(c.dataDir.endsWith("/data")).toBe(true);
    expect(c.brainPath).toBe(join(homedir(), "aamdani-brain"));
    expect(c.opsSsh).toEqual({ host: "", user: "ankit", keyPath: "",
      remoteDir: "/home/ankit/aamdani-social-automation", via: "aamdani-box" });
    expect(c.githubActionRepo).toBe("Ankit-Vohra/allevia");
    expect(c.publicMode).toBe(false);
    expect(c.port).toBe(8787);
    expect(c.webBaseUrl).toBe("http://127.0.0.1:8787");
    expect(c.discord.token).toBeUndefined();
    expect(c.discord.hubGuildId).toBeUndefined();
    expect(c.avsIg).toEqual({ token: undefined, userId: undefined });
    // Google sign-in is off until the founder sets it up; the redirect address is derived from the web address
    expect(c.google).toEqual({ enabled: false, clientId: undefined, clientSecret: undefined, connectorKey: undefined, redirectUri: "http://127.0.0.1:8787/api/connectors/google/callback" });
  });

  it("reads the Google connector settings from the environment, and the redirect address follows the web address unless set", () => {
    const env = { ALLEVIA_ENV_FILE: join(dir, "missing.env"), ALLEVIA_GOOGLE_CLIENT_ID: "id-1", ALLEVIA_GOOGLE_CLIENT_SECRET: "test-secret-xxxxxxxx", ALLEVIA_CONNECTOR_KEY: "test-key-xxxxxxxxxxxx", ALLEVIA_WEB_URL: "https://app.allevia.example/" };
    expect(loadConfig(env).google).toEqual({ enabled: false, clientId: "id-1", clientSecret: "test-secret-xxxxxxxx", connectorKey: "test-key-xxxxxxxxxxxx", redirectUri: "https://app.allevia.example/api/connectors/google/callback" });
    expect(loadConfig({ ...env, ALLEVIA_GOOGLE_REDIRECT_URI: "https://other.example/cb" }).google.redirectUri).toBe("https://other.example/cb");
  });

  it("reads the env file: comments, blank lines, quotes, export prefix, ~ expansion", () => {
    const c = loadConfig({ ALLEVIA_ENV_FILE: envFile });
    expect(c.model).toBe("opus");
    expect(c.extractModel).toBe("sonnet");
    expect(c.discord.token === "tok-from-file # not a comment").toBe(true); // never print token values
    expect(c.discord.guildId).toBe("123");
    expect(c.discord.hubGuildId).toBe("555000111"); // the hub's own names; the old demo server keeps DISCORD_GUILD_ID
    expect(c.discord.staffRoleId).toBe("555000222");
    expect(c.brainPath).toBe(join(homedir(), "brain-test"));
    expect(c.publicMode).toBe(true);
    expect(c.port).toBe(9999);
  });

  it("lets process env override the file", () => {
    const c = loadConfig({ ALLEVIA_ENV_FILE: envFile, ALLEVIA_MODEL: "haiku", PORT: "1234", ALLEVIA_PUBLIC_MODE: "0",
      ALLEVIA_FALKORDB_URL: "redis://example:1" });
    expect(c.model).toBe("haiku");
    expect(c.port).toBe(1234);
    expect(c.webBaseUrl).toBe("http://127.0.0.1:1234");
    expect(loadConfig({ ALLEVIA_ENV_FILE: envFile, ALLEVIA_WEB_URL: "https://allevia.example/" }).webBaseUrl).toBe("https://allevia.example");
    expect(c.publicMode).toBe(false);
    expect(c.falkordbUrl).toBe("redis://example:1");
    expect(loadConfig({ ALLEVIA_ENV_FILE: envFile, ALLEVIA_OPS_SSH_VIA: "other-box" }).opsSsh.via).toBe("other-box");
  });

  it("rejects a bad port", () => {
    expect(() => loadConfig({ ALLEVIA_ENV_FILE: join(dir, "missing.env"), PORT: "eighty" })).toThrow(/PORT/);
  });
});
