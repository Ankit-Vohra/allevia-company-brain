// A connections service over fakes: fake Google (OAuth and the products), fake Composio, a temp data dir, a throwaway graph.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AlleviaConfig } from "../../src/config.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { MemoryAuditLog } from "../../src/connections/audit.js";
import { ConnectionsService } from "../../src/connections/service.js";
import { buildConnections } from "../../src/connections/wiring.js";
import { FakeGoogle, tokens } from "../helpers/fake-google.js";
import { FakeGoogleApis, type FakeApisScript } from "../helpers/fake-google-apis.js";
import { FakeComposio } from "../helpers/fake-composio.js";
import { seededGraph } from "../helpers/tools.js";

export const KEY = "test-connector-key-0123456789abcdef0123456789abcdef";
export const WEB = "https://allevia.example";
export const NOW = Date.parse("2026-10-15T09:00:00Z");
const ENV_FILE = fileURLToPath(new URL("../fixtures/allevia.test.env", import.meta.url));

export const SC = "https://www.googleapis.com/auth/";
export const grant = (n: string, ...scopes: string[]) => tokens(n, { scope: ["openid", "email", ...scopes.map((s) => (s.startsWith("http") ? s : `${SC}${s}`))].join(" ") });

export interface ConnHarness {
  svc: ConnectionsService;
  google: FakeGoogle;
  apis: FakeGoogleApis;
  composio: FakeComposio;
  audit: MemoryAuditLog;
  g: GraphHandle;
  dir: string;
  cfg: AlleviaConfig;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

export async function connHarness(o: { env?: Record<string, string>; apis?: FakeApisScript; codes?: Record<string, ReturnType<typeof tokens>>; graph?: boolean } = {}): Promise<ConnHarness> {
  const dir = mkdtempSync(join(tmpdir(), "allevia-connections-"));
  const cfg = loadConfig({
    ALLEVIA_ENV_FILE: ENV_FILE, ALLEVIA_DATA_DIR: dir, ALLEVIA_WEB_URL: WEB,
    ALLEVIA_GOOGLE_CLIENT_ID: "test-client-id.apps.example", ALLEVIA_GOOGLE_CLIENT_SECRET: "test-client-secret-xxxxxxxxxxxx", ALLEVIA_CONNECTOR_KEY: KEY,
    ALLEVIA_GOOGLE_ADS_DEVELOPER_TOKEN: "test-dev-token", ...o.env,
  });
  const clock = { now: NOW };
  const google = new FakeGoogle({ codes: o.codes ?? {} });
  const apis = new FakeGoogleApis(o.apis);
  const composio = new FakeComposio();
  const audit = new MemoryAuditLog();
  const seeded = o.graph === false ? null : await seededGraph();
  const g = seeded?.g as GraphHandle;
  const svc = buildConnections(cfg, {
    googleClient: google, googleApis: apis, composio, audit, now: () => clock.now,
    openGraph: async () => g,
  });
  return { svc, google, apis, composio, audit, g, dir, cfg, clock, cleanup: async () => { rmSync(dir, { recursive: true, force: true }); await seeded?.cleanup(); } };
}

/** Walks the owner's trip: connect, "Google" sends them back with a code. */
export async function connectVia(h: ConnHarness, tenant: string, id: string, code: string, options: Record<string, string> = {}) {
  const { url } = await h.svc.connect(tenant, id, options);
  const state = new URL(url).searchParams.get("state")!;
  const done = await h.svc.complete(state, { code });
  return { url: new URL(url), state, done };
}
