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
import { googleConnSettings } from "./google/oauth.js";
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
  // Google products: through Composio (the main path) or on our own Google app (branded consent). Both give the same connection ids.
  const via = cfg.connections.googleVia ?? (composioKey || over.composio ? "composio" : "own");
  const OWN_GOOGLE = new Set(["gmail", "google-calendar", "google-analytics", "search-console", "google-ads"]);
  const composioDeps = { apiKey: composioKey || (over.composio ? "test" : ""), client: composio, connectorKey: key };
  const connectors = [
    ...(via === "own" ? [new SearchConsoleConnector(legacy, settings), ...googleProductConnectors({ settings, store, client, apis })] : []),
    ...composioConnectors(composioDeps, (e) => via === "composio" || !OWN_GOOGLE.has(e.id)),
  ];
  return new ConnectionsService({
    connectors, vault: store as never, audit: over.audit ?? new FileAuditLog(cfg.dataDir), connectorKey: key, webBaseUrl: cfg.webBaseUrl,
    openGraph: over.openGraph,
    dynamic: (slug) => (DYNAMIC_SLUG.test(slug) ? new ComposioConnector(dynamicEntry(slug, slug.replace(/_/g, " "), ""), composioDeps) : null),
    ...(composio ? { search: (q: string) => composio.searchToolkits(q) } : {}), ...(over.businessIdOf ? { businessIdOf: over.businessIdOf } : {}), now,
  });
}
