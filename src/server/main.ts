// Starts the Allevia server: the API (app.ts) with the production deps (tenant registry, tenant graphs, the agent
// company on the Claude subscription through wiring.ts, the local embedder for search) and the built web app from
// web/dist. `npm run cli -- serve` calls startServer; `npx tsx src/server/main.ts` works too.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { closeAll, openGraph } from "../graph/client.js";
import { listTenants } from "../graph/tenants.js";
import { createApp, type ServerDeps } from "./app.js";

export const WEB_DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));

export interface ServeOpts {
  port?: number;
  host?: string;          // default 127.0.0.1; set 0.0.0.0 inside a container
  model?: string;         // override every agent's model for live turns (e.g. "haiku")
  publicMode?: boolean;
  staticDir?: string | null; // null: API only
  over?: Partial<ServerDeps>;
}

export function productionDeps(o: { model?: string; publicMode: boolean; staticDir?: string }): ServerDeps {
  let hub: Promise<import("../discord/hub-service.js").HubService | null> | undefined;
  return {
    publicMode: o.publicMode,
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
      const { productionStudioDeps, studioSample } = await import("../studio/wiring.js");
      const dataDir = loadConfig().dataDir;
      return { deps: productionStudioDeps(dataDir), sample: (tenant) => studioSample(dataDir, tenant) };
    },
    ...(o.staticDir ? { staticDir: o.staticDir } : {}),
  };
}

export async function startServer(opts: ServeOpts = {}): Promise<{ server: ServerType; url: string; close: () => Promise<void> }> {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.port;
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const publicMode = opts.publicMode ?? cfg.publicMode;
  const staticDir = opts.staticDir === null ? undefined : opts.staticDir ?? (existsSync(WEB_DIST) ? WEB_DIST : undefined);
  const deps: ServerDeps = {
    ...productionDeps({ publicMode, ...(opts.model ? { model: opts.model } : {}), ...(staticDir ? { staticDir } : {}) }),
    ...opts.over,
  };
  const app = createApp(deps);
  // A business whose Discord area could not be set up at onboarding is retried in the background.
  const hub = publicMode ? null : await deps.discordHub?.().catch(() => null);
  const stopRetry = hub ? hub.startRetryLoop() : undefined;
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
    s.once("error", reject);
  });
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  console.error(`Allevia on ${url}${publicMode ? " (public read-only mode)" : ""}${staticDir ? "" : " (API only: build the web app with `cd web && npm run build`)"}`);
  return { server, url, close: () => { stopRetry?.(); return new Promise<void>((r) => server.close(() => r())); } };
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
  const { close } = await startServer();
  await untilStopped(close);
  await closeAll();
  process.exit(0);
}
