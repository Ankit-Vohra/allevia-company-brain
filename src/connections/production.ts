// One connections service per process, built from config and the tenant registry. The server, the Discord bot, the agents'
// wiring and the executors all use this one, so they share the same pending sign-ins and the same audit log.
import { loadConfig } from "../config.js";
import { openGraph } from "../graph/client.js";
import { getTenant } from "../graph/tenants.js";
import type { ConnectionsService } from "./service.js";
import { buildConnections } from "./wiring.js";

let shared: ConnectionsService | undefined;

export function productionConnections(): ConnectionsService {
  return (shared ??= buildConnections(loadConfig(), { openGraph: (t) => openGraph(t), businessIdOf: async (t) => (await getTenant(t))?.businessId }));
}
