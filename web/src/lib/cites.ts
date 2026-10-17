// Citations the way Claude and Gemini show them: the answer reads as plain prose with a small superscript number at the end
// of the clause (¹, or ¹, ² when two sit together), one number per source however often it is cited, and the numbered list
// behind one quiet "Sources (N)" row at the end. The numbering and placement are shared with Discord (shared/citations.ts);
// this file says what each number is: its kind, name, where it was read and when. Pure, so the web render tests can check
// it without a browser.
import type { NodeRef, SourceRef } from "../../../shared/contracts.js";
export { CITE_HREF, citeOrder, idsOfHref, markerText, numberCitations, type Numbered } from "../../../shared/citations.js";
import { kindOf, labelOfId, nameOfId } from "./labels.js";
import { humanDates } from "./words.js";

const KIND_IDS: Record<string, string> = { "brand-asset": "BrandAsset", brandasset: "BrandAsset", brandrule: "BrandRule", obs: "Observation" };

export interface CiteInfo {
  id: string;
  n: number;
  label: string;
  /** The kind in the owner's words ("Numbers", "Posts and channels"). */
  kind: string;
  hue: number;
  name: string;
  /** Where it was read and when: "Release notes 2.8.0, read 7 Oct", or "Your records, 15 Oct". */
  from: string;
  /** "approval" opens the draft; anything else opens on the Brain map. */
  open: "approval" | "map";
}

/** Where a cited thing was read, from the run's tool results. */
export type CiteSources = Record<string, SourceRef>;

const day = (iso?: string) => (iso ? humanDates(iso.slice(0, 10)) : "");

export function citeInfo(id: string, n: number, node?: NodeRef, source?: SourceRef): CiteInfo {
  const prefix = id.split(":")[0] ?? "";
  const label = node?.label ?? KIND_IDS[prefix] ?? labelOfId(id);
  const kind = kindOf(label);
  // an approval we have no name for reads as what it is, not its id ("turn:2026 10 16 895be596 1")
  const name = (node?.name ?? (prefix === "approval" ? "A draft waiting for your OK" : nameOfId(id))).trim();
  const when = day(source?.asOf ?? node?.asOf);
  const from = source ? `${source.title}${when ? `, read ${when}` : ""}` : `Your records${when ? `, ${when}` : ""}`;
  return { id, n, label, kind: kind.id === "other" ? label : kind.name, hue: kind.hue, name, from, open: prefix === "approval" ? "approval" : "map" };
}

/** "Source 2: Release notes 2.8.0, read 7 Oct" (the name too, so a screen reader hears what it is). */
export const citeAria = (c: CiteInfo) => `Source ${c.n}: ${c.name}. ${c.from}`;

interface StepLike { nodes: NodeRef[]; sources: SourceRef[] }

/**
 * Where each cited thing was read, from the tool results that returned it: a document is its own source; a result with one
 * source gives it to everything it returned; with several, the one dated the same day as the thing. Unsure means none
 * (the popover then says "Your records" rather than guess).
 */
export function citeSources(steps: StepLike[], all: Record<string, SourceRef> = {}): CiteSources {
  const out: CiteSources = {};
  for (const [id, s] of Object.entries(all)) out[id] = s;
  for (const st of steps) {
    for (const n of st.nodes) {
      if (out[n.id]) continue;
      const own = st.sources.find((s) => s.id === n.id);
      if (own) { out[n.id] = own; continue; }
      if (st.sources.length === 1) { out[n.id] = st.sources[0]!; continue; }
      const same = n.asOf ? st.sources.filter((s) => s.asOf && s.asOf.slice(0, 10) === n.asOf!.slice(0, 10)) : [];
      if (same.length === 1) out[n.id] = same[0]!;
    }
  }
  return out;
}

/** The steps of a run, flattened from its lanes (what citeSources reads). */
export const stepsOf = (lanes: Record<string, { steps: StepLike[] }>): StepLike[] => Object.values(lanes).flatMap((l) => l.steps);
