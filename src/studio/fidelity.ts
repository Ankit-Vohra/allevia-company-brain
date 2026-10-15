// Nisha's fidelity check (product design §6, step 7; fails closed). Structural only: is it the same building, with no
// element added or removed? Light, colour, noise, straightening and cropping are allowed changes. Two kinds of evidence:
// - numbers, against the straightened frame each variant was made from: dHash distance (64 bits) and an SSIM-like
//   structure score (image.ts `similarity`; the correlation of edges, so a relight does not count as a change);
// - one vision comparison of every variant against the owner's original, returning {sameBuilding, structuralChange,
//   added, removed} per variant.
// Badge: "unchanged" only when the vision check says same building, no structural change, nothing added or removed, AND
// the structure score clears STRUCTURE_FLOOR. "changed" otherwise. "unchecked" when the vision check could not run.
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { agentNodeId } from "../agent/memory.js";
import { dhash, hamming, similarity, visionCopy } from "./image.js";
import type { VariantRecord } from "./variants.js";
import { visionForGraph, type VisionRunner } from "./vision.js";

export const NISHA = "fact-checker";
export const STRUCTURE_FLOOR = 0.45;

export type FidelityBadge = "unchanged" | "changed" | "unchecked";

export interface VisionVerdict { label: string; sameBuilding: boolean; structuralChange: boolean; added: string[]; removed: string[]; note: string }

export interface FidelityResult {
  assetId: string;
  label: string;
  badge: FidelityBadge;
  dhashDistance: number;
  ssim: number;
  structure: number;
  vision: VisionVerdict | null;
  note: string;
}

const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
export const FIDELITY_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: str, sameBuilding: { type: "boolean" }, structuralChange: { type: "boolean" }, added: strs, removed: strs, note: str,
        },
        required: ["label", "sameBuilding", "structuralChange", "added", "removed", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
} as const;

export function fidelitySystem(businessName: string): string {
  return `You are Nisha, the fact checker on ${businessName}'s AI team. You check edited photos against the original before ` +
    "the owner sees them. Your one question is structural: is it still the same real place? You never judge taste.";
}

export function fidelityPrompt(labels: string[], locks: string[]): string {
  return [
    `"original" is the owner's photo. "frame" is the straightened 4:5 crop the variants were made from. ${labels.map((l) => `"${l}"`).join(" and ")} ${labels.length > 1 ? "are" : "is"} the edited variant${labels.length > 1 ? "s" : ""}.`,
    "Allowed: straightening, cropping to the frame, exposure, white balance, relighting, a cleaner sky, less noise, a blurred person.",
    "Not allowed: any added, removed, moved or reshaped physical element: walls, roofline, arches, openings and their glazing bars,",
    "columns, steps, pool edges, furniture, plants, people or objects.",
    locks.length ? `The owner's locks (must not change): ${locks.join("; ")}.` : "",
    "For each variant give: label; sameBuilding (true if it is recognisably the same building and site); structuralChange (true if",
    "any physical element was added, removed, moved or reshaped); added and removed (physical elements only; empty when none);",
    "note (one short sentence: what changed, e.g. 'relit and straightened; nothing added').",
  ].filter(Boolean).join("\n");
}

function parseVerdicts(raw: unknown, labels: string[]): Map<string, VisionVerdict> {
  const out = new Map<string, VisionVerdict>();
  const list = (raw && typeof raw === "object" && Array.isArray((raw as { variants?: unknown }).variants)) ? (raw as { variants: unknown[] }).variants : [];
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 120)).slice(0, 8) : []);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const label = String(o.label ?? "").replace(/^variant\s*/i, "").trim().toUpperCase();
    if (!labels.includes(label) || out.has(label)) continue;
    out.set(label, {
      label, sameBuilding: o.sameBuilding === true, structuralChange: o.structuralChange !== false,
      added: strList(o.added), removed: strList(o.removed), note: typeof o.note === "string" ? o.note.trim().slice(0, 240) : "",
    });
  }
  return out;
}

export function badgeFor(v: VisionVerdict | null, structure: number): FidelityBadge {
  if (!v) return "unchecked";
  const clean = v.sameBuilding && !v.structuralChange && v.added.length === 0 && v.removed.length === 0;
  return clean && structure >= STRUCTURE_FLOOR ? "unchanged" : "changed";
}

export function badgeNote(r: Pick<FidelityResult, "badge" | "vision" | "structure">): string {
  if (r.badge === "unchecked") return "Not checked: the comparison could not run, so this variant is held back.";
  const v = r.vision!;
  if (r.badge === "unchanged") return `Building unchanged${v.note ? ` · ${v.note}` : ""}`;
  const what = [...v.added.map((x) => `added ${x}`), ...v.removed.map((x) => `removed ${x}`)];
  if (!v.sameBuilding) what.unshift("not the same building");
  if (!what.length && r.structure < STRUCTURE_FLOOR) what.push(`edges moved (structure ${r.structure.toFixed(2)})`);
  return `Changed: ${what.join(", ") || v.note || "structural change"}`;
}

export interface FidelityInput {
  businessName: string;
  original: Buffer;    // the owner's photo (normalized)
  base: Buffer;        // the straightened 4:5 frame
  locks: string[];
  variants: VariantRecord[];
}

export async function checkFidelity(
  g: GraphHandle, input: FidelityInput, deps: { vision: VisionRunner; model: string; now: number },
): Promise<FidelityResult[]> {
  const labels = input.variants.map((v) => v.label);
  const baseHash = await dhash(input.base);
  let verdicts = new Map<string, VisionVerdict>();
  try {
    const raw = await visionForGraph(deps.vision, g.name).see({
      agent: NISHA, model: deps.model, system: fidelitySystem(input.businessName), prompt: fidelityPrompt(labels, input.locks),
      schema: FIDELITY_SCHEMA,
      images: [
        { label: "original", mime: "image/jpeg", data: await visionCopy(input.original, 1024) },
        { label: "frame", mime: "image/jpeg", data: await visionCopy(input.base, 1024) },
        ...await Promise.all(input.variants.map(async (v) => ({ label: v.label, mime: "image/jpeg" as const, data: await visionCopy(v.buffer, 1024) }))),
      ],
    });
    verdicts = parseVerdicts(raw, labels);
  } catch {
    verdicts = new Map(); // fails closed: every variant is "unchecked"
  }
  const out: FidelityResult[] = [];
  for (const v of input.variants) {
    const sim = await similarity(input.base, v.buffer);
    const vision = verdicts.get(v.label) ?? null;
    const badge = badgeFor(vision, sim.structure);
    const r: FidelityResult = {
      assetId: v.id, label: v.label, badge, dhashDistance: hamming(baseHash, v.dhash), ssim: sim.ssim, structure: sim.structure, vision, note: "",
    };
    r.note = badgeNote(r);
    out.push(r);
    const [row] = await g.roQuery<{ name: string }>("MATCH (x:Entity:Asset {id:$id}) RETURN x.name AS name", { id: v.id });
    await upsertNode(g, {
      type: "Asset", id: v.id, name: row?.name ?? v.id,
      props: { fidelityBadge: badge, fidelityNote: r.note, dhashDistance: r.dhashDistance, ssim: r.ssim, structure: r.structure, fidelity: JSON.stringify(vision) },
    }, deps.now);
    await upsertEdge(g, {
      from: agentNodeId(NISHA), type: "REVIEWED", to: v.id,
      props: { verdict: badge === "unchanged" ? "ok" : "reject", badge, note: r.note.slice(0, 300), step: "fidelity" },
    }, deps.now);
  }
  return out;
}
