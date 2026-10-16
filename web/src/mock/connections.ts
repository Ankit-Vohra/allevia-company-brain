// The static demo's Connections page: the same catalogue the live server reads (shared/connection-map.ts), nothing connected,
// and connecting says it needs the live app. Real data never appears here.
import { fitOf, recommendedFor, TOOLKIT_CATALOG, type ToolkitEntry } from "@shared/connection-map";
import type { ConnectionRow, ConnectionsPage } from "../types-ext";

const row = (e: ToolkitEntry): ConnectionRow => ({
  id: e.id, name: e.name, group: e.group, blurb: e.blurb, reads: e.reads, acts: e.acts, access: e.acts.length ? "read_act" : "read",
  logo: `https://logos.composio.dev/api/${e.toolkit}`, state: "not_connected", message: e.blurb, available: true,
});

export function mockConnections(business = "jobs platform"): ConnectionsPage {
  const rows = TOOLKIT_CATALOG.map(row);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const recommended = recommendedFor(fitOf(business)).map((e) => byId.get(e.id)!);
  const shown = new Set(recommended.map((r) => r.id));
  return {
    ready: true, fit: fitOf(business), recommended, more: rows.filter((r) => !shown.has(r.id)),
    groups: [], starters: [],
    never: "We never post, send, spend or book without your OK, and your data stays in your own space.",
  };
}
