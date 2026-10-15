// What the server needs before any business can connect a Google account, and how to say plainly what is missing. The
// founder creates these once (docs/connectors-setup.md); a business never sees an environment name.
import type { AlleviaConfig } from "../../config.js";

export interface MissingSetting { setting: string; words: string }

export interface GoogleSettings {
  configured: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  connectorKey: string;
  missing: MissingSetting[];
}

export function googleSettings(g: AlleviaConfig["google"]): GoogleSettings {
  const missing: MissingSetting[] = [];
  if (!g.clientId) missing.push({ setting: "ALLEVIA_GOOGLE_CLIENT_ID", words: "Allevia's Google client ID" });
  if (!g.clientSecret) missing.push({ setting: "ALLEVIA_GOOGLE_CLIENT_SECRET", words: "Allevia's Google client secret" });
  if (!g.connectorKey || g.connectorKey.length < 32) missing.push({ setting: "ALLEVIA_CONNECTOR_KEY", words: "the key that locks stored Google access (at least 32 characters)" });
  return {
    configured: missing.length === 0, clientId: g.clientId ?? "", clientSecret: g.clientSecret ?? "", redirectUri: g.redirectUri,
    connectorKey: g.connectorKey ?? "", missing,
  };
}

export const NOT_CONFIGURED_WORDS =
  "Connecting Search Console isn't switched on yet. Your team is setting up Allevia's Google access and will let you know when it's ready.";

export class NotConfiguredError extends Error {
  override name = "NotConfiguredError";
  constructor(readonly missing: MissingSetting[]) {
    super(NOT_CONFIGURED_WORDS);
  }
}
