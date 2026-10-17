// Builds the connections for one server from its config: Google products and Search Console on our own OAuth app, the long tail
// through Composio, one sealed store and one audit log per data dir. Tests pass fakes through `over`; the real Google and
// Composio clients refuse to run under vitest.
import type { AlleviaConfig } from "../config.js";
import { realGoogleClient, type GoogleClient } from "../connectors/google/client.js";
import type { GoogleDeps } from "../connectors/google/searchconsole.js";
import { googleSettings } from "../connectors/google/settings.js";
import { FileTokenStore } from "../connectors/google/store.js";
import type { GraphHandle } from "../graph/client.js";
import { FileAuditLog, type AuditLog } from "./audit.js";
import { composioConnectors, ComposioConnector, DYNAMIC_SLUG, dynamicEntry, realComposioClient, type ComposioClient } from "./composio.js";
import { realGoogleApis, type GoogleApis } from "./google/apis.js";
import { googleAvailability, googleConnSettings } from "./google/oauth.js";
import { SearchConsoleConnector } from "./google/search-console.js";
import { googleProductConnectors } from "./google/specs.js";
import { ConnectionsService } from "./service.js";

export interface WiringOver {
  googleClient?: GoogleClient;
  googleApis?: GoogleApis;
  composio?: ComposioClient | null;
  audit?: AuditLog;
  now?: () => number;
  openGraph: (tenant: string) => Promise<GraphHandle>;
  businessIdOf?: (tenant: string) => Promise<string | undefined>;
}

export function buildConnections(cfg: AlleviaConfig, over: WiringOver): ConnectionsService {
  const settings = googleConnSettings(cfg);
  const key = cfg.google.connectorKey ?? "";
  // a short or missing key cannot seal anything: the store is made with a placeholder only so the page can still list; nothing is sealed (every connector reports "not switched on")
  const store = new FileTokenStore(cfg.dataDir, key.length >= 32 ? key : "x".repeat(32), cfg.connections.previousKeys);
  const client = over.googleClient ?? realGoogleClient({ clientId: settings.clientId, clientSecret: settings.clientSecret, redirectUri: settings.redirectUri });
  const apis = over.googleApis ?? realGoogleApis({
    ...(cfg.connections.googleAdsDeveloperToken ? { adsDeveloperToken: cfg.connections.googleAdsDeveloperToken } : {}),
    ...(cfg.connections.googleAdsLoginCustomerId ? { adsLoginCustomerId: cfg.connections.googleAdsLoginCustomerId } : {}),
    ...(cfg.connections.googleAdsApiVersion ? { adsApiVersion: cfg.connections.googleAdsApiVersion } : {}),
  });
  const now = over.now ?? (() => Date.now());
  const legacy: GoogleDeps = { settings: googleSettings({ ...cfg.google, enabled: true }), store, client, now };
  const composioKey = cfg.connections.composioApiKey ?? "";
  const composio = over.composio === undefined ? (composioKey ? realComposioClient(composioKey) : null) : over.composio;
  // Google products: Composio is the main path. Its Analytics and Ads toolkits cannot run reports (checked against its catalogue;
  // Analytics' daily read goes through Composio's proxy instead), so when our own Google app is set up those two use it; ALLEVIA_GOOGLE_VIA=own|composio forces every Google product one way.
  const GOOGLE_FIVE = ["gmail", "google-calendar", "google-analytics", "search-console", "google-ads"];
  const composioOn = !!(composioKey || over.composio);
  const forced = cfg.connections.googleVia;
  const ownAvailable = (id: string) => googleAvailability(settings, "", { ads: id === "google-ads" }).ok;
  const own = new Set(forced === "own" || (!forced && !composioOn) ? GOOGLE_FIVE : forced === "composio" ? [] : ["google-analytics", "google-ads"].filter(ownAvailable));
  const composioDeps = { apiKey: composioKey || (over.composio ? "test" : ""), client: composio, connectorKey: key };
  const ownConnectors = [new SearchConsoleConnector(legacy, settings), ...googleProductConnectors({ settings, store, client, apis })].filter((c) => own.has(c.info.id));
  const connectors = [...ownConnectors, ...composioConnectors(composioDeps, (e) => !own.has(e.id))];
  return new ConnectionsService({
    connectors, vault: store as never, audit: over.audit ?? new FileAuditLog(cfg.dataDir), connectorKey: key, webBaseUrl: cfg.webBaseUrl,
    openGraph: over.openGraph,
    dynamic: (slug) => (DYNAMIC_SLUG.test(slug) ? new ComposioConnector(dynamicEntry(slug, slug.replace(/_/g, " "), ""), composioDeps) : null),
    ...(composio ? { search: (q: string) => composio.searchToolkits(q) } : {}), ...(over.businessIdOf ? { businessIdOf: over.businessIdOf } : {}), now,
  });
}
