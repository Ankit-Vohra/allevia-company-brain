// Google sign-in for the connections: what the server needs before any business can connect (named for the founder, never shown
// to an owner), PKCE (RFC 7636, S256), and the consent address. Scopes are asked for per connection, never all at once, and
// `include_granted_scopes` is off so each connection holds exactly what it asked for.
import { createHash, randomBytes } from "node:crypto";
import type { AlleviaConfig } from "../../config.js";
import type { Availability, MissingSetting } from "../types.js";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const MIN_KEY = 32;

export interface GoogleConnSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  connectorKey: string;
  adsDeveloperToken: string;
  missing: MissingSetting[];          // what every Google connection needs
  adsMissing: MissingSetting[];       // what Google Ads needs on top
}

export function googleConnSettings(cfg: Pick<AlleviaConfig, "google"> & { connections?: { googleAdsDeveloperToken?: string } }): GoogleConnSettings {
  const g = cfg.google;
  const missing: MissingSetting[] = [];
  if (!g.clientId) missing.push({ setting: "ALLEVIA_GOOGLE_CLIENT_ID", words: "Allevia's Google client ID" });
  if (!g.clientSecret) missing.push({ setting: "ALLEVIA_GOOGLE_CLIENT_SECRET", words: "Allevia's Google client secret" });
  if (!g.connectorKey || g.connectorKey.length < MIN_KEY) missing.push({ setting: "ALLEVIA_CONNECTOR_KEY", words: "the key that locks stored connections (at least 32 characters)" });
  const adsDeveloperToken = cfg.connections?.googleAdsDeveloperToken ?? "";
  return {
    clientId: g.clientId ?? "", clientSecret: g.clientSecret ?? "", redirectUri: g.redirectUri, connectorKey: g.connectorKey ?? "", adsDeveloperToken,
    missing, adsMissing: adsDeveloperToken ? [] : [{ setting: "ALLEVIA_GOOGLE_ADS_DEVELOPER_TOKEN", words: "Allevia's Google Ads developer token" }],
  };
}

export const notConfiguredWords = (what: string): string =>
  `Connecting ${what} isn't switched on yet. Your team is setting up Allevia's Google access and will let you know when it's ready.`;

export function googleAvailability(s: GoogleConnSettings, what: string, o: { ads?: boolean } = {}): Availability {
  const missing = [...s.missing, ...(o.ads ? s.adsMissing : [])];
  return missing.length ? { ok: false, message: notConfiguredWords(what), missing } : { ok: true, message: "", missing: [] };
}

// PKCE: a random verifier kept on the server, and its S256 challenge sent with the consent address.
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function consentUrl(s: GoogleConnSettings, o: { scopes: readonly string[]; state: string; challenge: string; hint?: string }): string {
  const q = new URLSearchParams({
    client_id: s.clientId, redirect_uri: s.redirectUri, response_type: "code", scope: o.scopes.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state: o.state,
    code_challenge: o.challenge, code_challenge_method: "S256",
    ...(o.hint ? { login_hint: o.hint } : {}),
  });
  return `${AUTH_URL}?${q.toString()}`;
}

export const SCOPES = {
  identity: ["openid", "email"],
  calendarBusy: "https://www.googleapis.com/auth/calendar.freebusy",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
  ads: "https://www.googleapis.com/auth/adwords",
  searchConsole: "https://www.googleapis.com/auth/webmasters.readonly",
} as const;
