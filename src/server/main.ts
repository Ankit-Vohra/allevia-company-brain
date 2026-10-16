// Starts the Allevia server: the API (app.ts) with the production deps (tenant registry, tenant graphs, the agent
// company on the Claude subscription through wiring.ts, the local embedder for search) and the built web app from
// web/dist. `npm run cli -- serve` calls startServer; `npx tsx src/server/main.ts` works too.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { verifyToken } from "../auth/tokens.js";
import { closeAll, openGraph, redactUrl } from "../graph/client.js";
import { startTelemetrySweep, telemetrySweepOn } from "../graph/telemetry.js";
import { listTenants } from "../graph/tenants.js";
import { realGoogleClient } from "../connectors/google/client.js";
import { startSchedule } from "../connectors/google/schedule.js";
import { googleSettings } from "../connectors/google/settings.js";
import { FileTokenStore } from "../connectors/google/store.js";
import { createApp, type ServerDeps } from "./app.js";
import { checkupJobs } from "../checkup/jobs.js";
import { startCheckupSchedule } from "../checkup/schedule.js";
import { installCrashGuard } from "../util/crash-guard.js";
import { businessProps } from "./reads.js";
import { standupScheduleOn, startStandupSchedule } from "../proactive/schedule.js";
import type { GoogleWiring } from "./routes/connectors.js";

export const WEB_DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));

export interface ServeOpts {
  port?: number;
  host?: string;          // default 127.0.0.1; set 0.0.0.0 inside a container
  model?: string;         // override every agent's model for live turns (e.g. "haiku")
  publicMode?: boolean;
  authRequired?: boolean; // default ALLEVIA_AUTH (config): every business needs its owner link; see src/auth
  staticDir?: string | null; // null: API only
  over?: Partial<ServerDeps>;
}

// The Google connectors from the server's config: always built, "not switched on yet" until the founder has set the Google
// client and the connector key (docs/connectors-setup.md). Nothing is called until then.
export function productionGoogle(): GoogleWiring {
  const cfg = loadConfig();
  const settings = googleSettings(cfg.google);
  return {
    deps: { settings, store: new FileTokenStore(cfg.dataDir, settings.connectorKey), client: realGoogleClient(settings), now: () => Date.now() },
    webBaseUrl: cfg.webBaseUrl,
  };
}

export function productionDeps(o: { model?: string; publicMode: boolean; authRequired?: boolean; staticDir?: string }): ServerDeps {
  let hub: Promise<import("../discord/hub-service.js").HubService | null> | undefined;
  return {
    publicMode: o.publicMode,
    ...(o.authRequired ? { auth: { enabled: true, verify: (token: string) => verifyToken(token) } } : {}),
    // The Discord hub, when DISCORD_HUB_GUILD_ID (and the rest) is set; built once and shared with the retry loop below.
    discordHub: () => (hub ??= o.publicMode ? Promise.resolve(null) : import("../discord/hub-service.js").then((m) => m.productionHub())),
    listTenants: () => listTenants(),
    openGraph: (slug) => openGraph(slug),
    askDeps: async (tenant) => {
      const { createAskDeps } = await import("../agent/wiring.js"); // loads the Agent SDK only when someone asks
      return createAskDeps({ tenant, ...(o.model ? { model: o.model } : {}) });
    },
    embedQuery: async () => (await import("../agent/wiring.js")).localEmbedder(),
    studio: async () => {
      const { productionStudioDeps, studioClip, studioSample } = await import("../studio/wiring.js");
      const dataDir = loadConfig().dataDir;
      const clip = studioClip(dataDir, (slug) => openGraph(slug));
      return { deps: productionStudioDeps(dataDir), ...(clip ? { clip } : {}), sample: (tenant) => studioSample(dataDir, tenant) };
    },
    google: async () => productionGoogle(),
    connections: async () => ({ service: (await import("../connections/production.js")).productionConnections(), webBaseUrl: loadConfig().webBaseUrl }),
    standup: async (slug, g, businessId) => (await import("../proactive/wiring.js")).runDaily(slug, g, businessId, { force: true }),
    ...(o.staticDir ? { staticDir: o.staticDir } : {}),
  };
}

// What an operator should hear at start-up when the settings leave every registered business open to whoever reaches the port.
export function exposureWarnings(o: { host: string; publicMode: boolean; authRequired: boolean; hubEnabled?: boolean }): string[] {
  if (o.authRequired) return [];
  const loopback = o.host === "127.0.0.1" || o.host === "localhost" || o.host === "::1";
  return [
    ...(o.hubEnabled ? ["the Discord hub is on and ALLEVIA_AUTH is off: anyone who knows a business's id can ask this server for a link into that business's Discord area, which lets them ask its team and decide its cards. Set ALLEVIA_AUTH=1 before real customers use the hub."] : []),
    ...(o.publicMode ? ["public mode shows EVERY registered business read-only to anyone who can reach this port. With real customers registered, set ALLEVIA_AUTH=1 and mark only the demo businesses (auth:demo)."] : []),
    ...(!o.publicMode && !loopback ? [`ALLEVIA_AUTH is off and the server listens on ${o.host}: anyone who can reach it can read and change any business. Set ALLEVIA_AUTH=1 before real customers are on it.`] : []),
  ];
}

export async function startServer(opts: ServeOpts = {}): Promise<{ server: ServerType; url: string; close: () => Promise<void> }> {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.port;
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const publicMode = opts.publicMode ?? cfg.publicMode;
  const authRequired = opts.authRequired ?? cfg.authRequired;
  const staticDir = opts.staticDir === null ? undefined : opts.staticDir ?? (existsSync(WEB_DIST) ? WEB_DIST : undefined);
  const deps: ServerDeps = {
    ...productionDeps({ publicMode, authRequired, ...(opts.model ? { model: opts.model } : {}), ...(staticDir ? { staticDir } : {}) }),
    ...opts.over,
  };
  const app = createApp(deps);
  // A business whose Discord area could not be set up at onboarding is retried in the background.
  const hub = publicMode ? null : await deps.discordHub?.().catch(() => null);
  const stopRetry = hub ? hub.startRetryLoop() : undefined;
  // a card made here (a chat turn, Studio, an insight) reaches the business's Discord #approvals within seconds
  const stopNudge = hub ? await (async () => {
    const [{ startApprovalNudge }, { tenantSource }, { AssetStore }] = await Promise.all([import("../discord/hub-nudge.js"), import("../discord/hub-source.js"), import("../studio/store.js")]);
    const store = new AssetStore(cfg.dataDir);
    return startApprovalNudge({ deps: hub.deps, log: (l) => console.error(l), source: async (slug) => tenantSource(await deps.openGraph(slug), slug, { store, webBase: cfg.webBaseUrl }) });
  })() : undefined;
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
    s.once("error", reject);
  });
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  for (const w of exposureWarnings({ host, publicMode, authRequired, hubEnabled: !!hub })) console.error(`WARNING: ${w}`);
  console.error(`Allevia on ${url}${publicMode ? " (public read-only mode)" : ""}${authRequired ? " (owner links required)" : ""}${staticDir ? "" : " (API only: build the web app with `cd web && npm run build`)"}`);
  // the daily Search Console read, for every business that connected it (only when Google is set up, never in public mode)
  const google = productionGoogle();
  const stopSchedule = !publicMode && google.deps.settings.configured && !opts.over?.google
    ? startSchedule({ google: google.deps, tenants: () => listTenants(), openGraph: (slug) => openGraph(slug) })
    : () => undefined;
  // the weekly website check-up per business (src/checkup/schedule.ts): never in public mode; ALLEVIA_CHECKUP_SCHEDULE=0 switches it off
  const stopCheckups = !publicMode && process.env.ALLEVIA_CHECKUP_SCHEDULE !== "0" && !opts.over?.listTenants
    ? startCheckupSchedule({ tenants: () => deps.listTenants(), openGraph: (slug) => deps.openGraph(slug), jobs: deps.checkupJobs ?? checkupJobs() })
    : () => undefined;
  // the daily team stand-up for every business, on its own morning (never in public mode; ALLEVIA_STANDUP=off stops it)
  const stopStandups = !publicMode && standupScheduleOn() && !opts.over?.listTenants
    ? startStandupSchedule({
      tenants: async () => (await listTenants()).map((t) => ({ slug: t.slug, ...(t.businessId ? { businessId: t.businessId } : {}) })),
      openGraph: (slug) => openGraph(slug),
      timeZoneOf: async (t, g) => (t.businessId ? (await businessProps(g, t.businessId)).timeZone : undefined),
      run: async (t, g) => {
        const { runDaily } = await import("../proactive/wiring.js");
        if (!t.businessId) return;
        await runDaily(t.slug, g, t.businessId, { log: (l) => console.error(l) });
      },
      log: (l) => console.error(l),
    })
    : () => undefined;
  // FalkorDB's own telemetry streams are cleared every few minutes (src/graph/telemetry.ts, issue #29); a managed server that
  // refuses plain Redis commands is noticed once and left alone. ALLEVIA_TELEMETRY_SWEEP=off switches it off.
  const stopTelemetry = !publicMode && telemetrySweepOn() && !opts.over?.listTenants
    ? startTelemetrySweep({ log: (l) => console.error(redactUrl(l, cfg.falkordbUrl)) })
    : () => undefined;
  return { server, url, close: () => { stopRetry?.(); stopNudge?.(); stopSchedule(); stopCheckups(); stopStandups(); stopTelemetry(); return new Promise<void>((r) => server.close(() => r())); } };
}

// Resolves on SIGINT/SIGTERM after the server has stopped taking requests.
export async function untilStopped(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  console.error("Stopping…");
  await Promise.race([close(), new Promise((r) => setTimeout(r, 3000))]); // open SSE streams must not hold the exit
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  installCrashGuard();
  const { close } = await startServer();
  await untilStopped(close);
  await closeAll();
  process.exit(0);
}
