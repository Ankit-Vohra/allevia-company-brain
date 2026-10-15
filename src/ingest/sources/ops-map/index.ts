// Mappers: one recorded aamdani-ops snapshot directory (one envelope JSON per tool call, see ../ops.ts) -> a
// SourceResult. Pure and deterministic, so they are tested on synthetic fixtures. Every number becomes an Observation
// that MEASURES its subject (a Channel, Content, Page, Query, Audience, or the Business) and cites the snapshot Document
// of the file it came from. One file per area: users.ts (users, sign-ups, funnel, marketplace, COE), content.ts,
// search.ts (Search Console, GA4), app-health.ts, system.ts (connectors, PENDING counts).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { entityId } from "../../../util/ids.js";
import type { SourceResult } from "../../types.js";
import { APP_HEALTH_MAPPERS } from "./app-health.js";
import { Builder, obj, str, type Json, type Mapper, type OpsMapContext } from "./builder.js";
import { CONTENT_MAPPERS } from "./content.js";
import { stripPersonalFields } from "./privacy.js";
import { SEARCH_MAPPERS } from "./search.js";
import { SYSTEM_MAPPERS } from "./system.js";
import { USER_MAPPERS } from "./users.js";

export { CHANNELS, type ChannelKey, type OpsMapContext } from "./builder.js";
export { redactText, stripPersonalFields, SENSITIVE_SECTION } from "./privacy.js";
export { FINANCE_METRIC, funnelStep } from "./users.js";

export const MAPPERS: Record<string, Mapper> = {
  ...USER_MAPPERS, ...CONTENT_MAPPERS, ...SEARCH_MAPPERS, ...APP_HEALTH_MAPPERS, ...SYSTEM_MAPPERS,
};

// "search_console.page.json" -> { tool: "search_console", variant: "page" }.
function parseFileName(f: string): { tool: string; variant?: string } {
  const [tool, ...rest] = f.replace(/\.json$/, "").split(".");
  return rest.length ? { tool: tool!, variant: rest.join(".") } : { tool: tool! };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export function mapSnapshot(dir: string, ctx: OpsMapContext): SourceResult {
  const b = new Builder(ctx);
  const manifestPath = join(dir, "manifest.json");
  let callsMeta: Json = {};
  try {
    callsMeta = existsSync(manifestPath) ? obj(obj(JSON.parse(readFileSync(manifestPath, "utf8"))).calls) : {};
  } catch (e) {
    b.skipped.push({ ref: "manifest.json", reason: `unreadable: ${errText(e)}` });
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
  for (const file of files) {
    // One bad file is skipped with its reason; whatever it had added is rolled back.
    const cp = b.checkpoint();
    try {
      const { tool, variant } = parseFileName(file);
      const call = variant ? `${tool}.${variant}` : tool;
      // A tool without a mapper (money, in an older snapshot) is not even read: no Document, no trace.
      const mapper = Object.hasOwn(MAPPERS, tool) ? MAPPERS[tool] : undefined;
      if (!mapper) { b.skipped.push({ ref: file, reason: `no mapper for tool ${tool}` }); continue; }
      const raw = readFileSync(join(dir, file), "utf8");
      const env = obj(JSON.parse(raw));
      const status = str(env.status) ?? "unknown";
      b.src = entityId("Document", `ops snapshot ${tool}${variant ? ` ${variant}` : ""} ${ctx.asOf}`);
      // No `sources`: the envelope's source labels name database roles, tables, env vars and account ids.
      b.node("Document", b.src, `ops snapshot: ${tool}${variant ? ` (${variant})` : ""}, ${ctx.asOf}`, {
        kind: "snapshot", tool, variant, status, path: `snapshots/${ctx.tenantSlug}/${ctx.asOf}/${file}`,
        readAt: str(env.asOf), hash: createHash("sha256").update(raw).digest("hex"),
      });
      if (status !== "ok") { b.skipped.push({ ref: file, reason: `status ${status}${str(env.message) ? `: ${b.text(env.message, 160)}` : ""}` }); continue; }
      const { value, dropped } = stripPersonalFields(env.data ?? {});
      b.count("personal_field", dropped);
      mapper(b, { tool, variant, file, data: obj(value), raw: obj(env.data), args: obj(obj(callsMeta[call]).args) });
    } catch (e) {
      b.restore(cp);
      b.skipped.push({ ref: file, reason: `could not map: ${errText(e)}` });
    }
  }
  return b.result();
}

/** Counts only (no values): nodes by type, edges by type, observations by metric. Safe to print. */
export function countWrite(r: SourceResult): {
  nodes: Record<string, number>; edges: Record<string, number>; observations: Record<string, number>; skipped: number; redactions: Record<string, number>;
} {
  const tally = (keys: string[]) => {
    const out: Record<string, number> = {};
    for (const k of keys.sort()) out[k] = (out[k] ?? 0) + 1;
    return out;
  };
  return {
    nodes: tally(r.write.nodes.map((n) => n.type)),
    edges: tally(r.write.edges.map((e) => e.type)),
    observations: tally(r.write.observations.map((o) => o.metric)),
    skipped: r.skipped.length,
    redactions: r.redactions,
  };
}
