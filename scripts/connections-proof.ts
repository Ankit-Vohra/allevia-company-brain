// Live proof of the connections on a real business, against the real Composio (needs COMPOSIO_API_KEY and ALLEVIA_CONNECTOR_KEY in
// ~/.config/allevia/allevia.env). It never prints a secret and never sends or books anything:
//   1. makes a Google Calendar connect link for the business (its own Composio entity) and prints it for the owner to open once
//   2. waits for the account to become active, and completes the connection the way the callback route does
//   3. as an agent would: reads free/busy (calendar_free_slots), then proposes a booking (calendar_book), which becomes an
//      approval card with the full content. Nothing is booked until the owner says OK.
// Usage: npx tsx scripts/connections-proof.ts <tenant> [connection-id] [--wait-minutes 30]
import { parseArgs } from "node:util";
import { AGENT_ID_DEFAULT } from "./connections-proof-ids.js";
import { loadConfig } from "../src/config.js";
import { closeAll, openGraph } from "../src/graph/client.js";
import { getTenant } from "../src/graph/tenants.js";
import { TouchedSet, type ToolContext } from "../src/agent/tool.js";
import { calendarBook, calendarFreeSlots } from "../src/agent/tools/connections.js";
import { realComposioClient, type ComposioClient } from "../src/connections/composio.js";
import { buildConnections } from "../src/connections/wiring.js";
import { z } from "zod";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "wait-minutes": { type: "string" } } });
const tenant = positionals[0];
const id = positionals[1] ?? "google-calendar";
if (!tenant) { console.error("Usage: npx tsx scripts/connections-proof.ts <tenant> [connection-id]"); process.exit(2); }
const cfg = loadConfig();
if (!cfg.connections.composioApiKey) { console.error("COMPOSIO_API_KEY is not set in the env file."); process.exit(1); }
const real = realComposioClient(cfg.connections.composioApiKey);
let callbackUrl = "", accountId = "";
const client: ComposioClient = {
  ...real,
  authConfigId: (t) => real.authConfigId(t),
  link: async (o) => { callbackUrl = o.callbackUrl; const r = await real.link(o); accountId = r.accountId; return r; },
  account: (a) => real.account(a), deleteAccount: (a) => real.deleteAccount(a), execute: (o) => real.execute(o),
  tools: (t, s) => real.tools(t, s), searchToolkits: (q) => real.searchToolkits(q), toolkit: (s) => real.toolkit(s),
};
const svc = buildConnections(cfg, { composio: client, openGraph: (t) => openGraph(t), businessIdOf: async (t) => (await getTenant(t))?.businessId });

const before = await svc.view(tenant, id);
console.log(`${id} for ${tenant}: ${before.state}`);
if (before.state !== "connected") {
  const { url } = await svc.connect(tenant, id);
  console.log(`\nOPEN THIS LINK ONCE (signs in to Google through Composio, for ${tenant} only):\n${url}\n`);
  const state = new URL(callbackUrl).searchParams.get("state")!;
  const until = Date.now() + Number(values["wait-minutes"] ?? 30) * 60_000;
  for (;;) {
    const a = await client.account(accountId);
    if (a?.status.toUpperCase() === "ACTIVE") break;
    if (Date.now() > until) { console.log("Timed out waiting for the owner to open the link."); await closeAll(); process.exit(1); }
    await new Promise((r) => setTimeout(r, 4000));
  }
  const done = await svc.complete(state, { status: "success", connected_account_id: accountId });
  console.log(`connected: ${JSON.stringify(done?.outcome)}`);
}

const g = await openGraph(tenant);
const port = svc.port(tenant, { actor: AGENT_ID_DEFAULT });
const ctx: ToolContext = { graph: g, tenant, turnId: `proof-${Date.now()}`, agentId: AGENT_ID_DEFAULT, asker: "person:founder", touched: new TouchedSet(), now: Date.now(), connections: port };
const slots = await calendarFreeSlots.run(z.object(calendarFreeSlots.input).parse({ minutes: 30, days: 5 }), ctx);
console.log("\ncalendar_free_slots:", JSON.stringify(slots.data, null, 1).slice(0, 1500), "\n", slots.note);
const first = (slots.data as { slots?: Array<{ start: string }> }).slots?.[0];
if (first) {
  const card = await calendarBook.run(z.object(calendarBook.input).parse({ title: "Intro call (proof of the connections, not a real meeting)", start: first.start, minutes: 30, why: "Proof that the team can read free times and prepare a booking for your OK. Reject this card." }), ctx);
  console.log("\ncalendar_book:", JSON.stringify(card.data), "\n", card.note);
}
console.log("\naudit:", JSON.stringify((await svc.audit.recent(tenant, { limit: 6 })).map((e) => `${e.op}:${e.ok ? "ok" : "failed"}`)));
await closeAll();
