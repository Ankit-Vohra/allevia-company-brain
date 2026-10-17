// The north star for the businesses that were set up before it existed, from what the founder said each one is for and what
// their brains hold (audiences, offer, app-store, WhatsApp and order links). Run with `npm run cli -- north-star:backfill`.
// An owner-set north star is never replaced (unless forced), and running it twice writes nothing more.
import type { GraphHandle } from "../graph/client.js";
import { businessId } from "../graph/tenants.js";
import { findBusiness } from "../capabilities/ladder.js";
import { writeBatch, type NodeInput } from "../graph/upsert.js";
import { entityId } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { deriveNorthStar, loadNorthStar, northStarWrite, type NorthStar, type NorthStarInput } from "./northstar.js";

export interface Preset { preset: Partial<NorthStarInput>; audiencesIfNone?: string[] }

// The founder, 2026-10-17: what each business wants more of.
export const BACKFILL: Record<string, Preset> = {
  aamdani: {
    preset: {
      outcome: "more app downloads and sign-ups", outcomeKind: "downloads",
      audiences: ["Job seekers looking for local work", "Employers hiring nearby"],
      cta: { kind: "download", text: "Download the app" }, altCta: { kind: "signup", text: "Sign up free on the app" },
    },
  },
  avs_atelier: {
    preset: { outcome: "more interior and architecture project enquiries", outcomeKind: "enquiries" },
    audiencesIfNone: ["Homeowners planning a new home or interiors", "Businesses fitting out a space"],
  },
  bluetokai: {
    preset: {
      outcome: "more people visiting our cafés, and more online orders", outcomeKind: "visits",
      cta: { kind: "visit", text: "Visit your nearest café" }, altCta: { kind: "order", text: "Order online" },
    },
    audiencesIfNone: ["Coffee lovers near our cafés", "People who brew coffee at home"],
  },
  demo_growth: {
    preset: { outcome: "more sign-ups", outcomeKind: "signups", cta: { kind: "signup", text: "Sign up free" } },
  },
};

export interface BackfillResult { tenant: string; status: "written" | "same" | "kept-owner" | "dry-run"; northStar: NorthStarInput; previous: NorthStar | null; errors: string[] }

export async function backfillNorthStar(g: GraphHandle, tenant: string, o: { now: number; force?: boolean; dryRun?: boolean }): Promise<BackfillResult> {
  const bid = (await findBusiness(g)) ?? businessId(tenant);
  const p = BACKFILL[tenant];
  const derived = await deriveNorthStar(g, { businessId: bid, source: "backfill", ...(p ? { preset: p.preset } : {}) });
  const ns: NorthStarInput = { ...derived, audiences: derived.audiences.length ? derived.audiences : p?.audiencesIfNone ?? [] };
  const previous = await loadNorthStar(g);
  if (previous?.source === "owner" && !o.force) return { tenant, status: "kept-owner", northStar: ns, previous, errors: [] };
  if (o.dryRun) return { tenant, status: "dry-run", northStar: ns, previous, errors: [] };
  // the run itself is the source: a Document that says where these words came from
  const src = entityId("Document", `north star backfill ${tenant} ${isoDate(o.now)}`);
  const doc: NodeInput = {
    type: "Document", id: src, name: `Main goal, set from the founder's notes and the records (${isoDate(o.now)})`, asOf: isoDate(o.now),
    summary: `What ${tenant} is for, as the founder said on 2026-10-17, with audiences, offer and links from the records.`, props: { kind: "note", origin: "north-star-backfill" },
  };
  const w = await northStarWrite(g, { ...ns, sourceRef: src, businessId: bid, now: o.now });
  if (w.same) return { tenant, status: "same", northStar: ns, previous, errors: [] };
  const s = await writeBatch(g, { nodes: [doc, ...w.write.nodes], edges: w.write.edges }, o.now);
  return { tenant, status: "written", northStar: ns, previous, errors: s.errors.map((e) => e.error) };
}
