// Entity resolution (spec §6.4): turns one document's Extraction into a GraphWrite. Precision over recall: anything
// the ontology does not allow, whose quote is not in the document, or whose endpoints cannot be pinned down is dropped
// with a reason, never guessed.
//
// Phases (DocResolver): entities → observations → relations (a relation can point at an observation by ref) → write.
//
// Name → id, within one type: unnamed founder/owner references and the tenant's founderNames → person:founder; a name
// already used in this document; the exact id; a known name or alias; similar() ≥ MERGE_SIMILARITY *and* namesAgree;
// else a new entityId(type, name). e5-small scores distinct same-type entities above 0.92 (measured 2026-10-15:
// Instagram~Facebook 0.959, "Pause Facebook posts"~"Pause Instagram posts" 0.964), so a vector score alone never
// merges. A high score with names that do not agree becomes a new node whose MENTIONS edge carries conf < 0.6 and
// `maybeSameAs`, for the librarian (spec §6.4: ambiguous → created with conf < 0.6, not merged).
//
// Existing nodes are never renamed or re-summarised by extraction; they only learn new aliases. Extracted edges are
// never functional: a document read by an LLM does not close facts that came from deterministic sources.
import { isAllowed, type EntityType, type RelType } from "../graph/schema.js";
import { observationId, type EdgeInput, type NodeInput, type ObservationInput, type Prim } from "../graph/upsert.js";
import { entityId, typeFromId } from "../util/ids.js";
import { CONTENT_FORMATS, LIMITS, isExtractableRel, isExtractableType, type Extraction } from "./extract-schema.js";
import { normQuote, numberProblem, quoteProblem } from "./resolve-evidence.js";
import {
  FOUNDER_ID, KnownIndex, clip, isFounderWord, isReservedId, isoDay, metricSlug, namesAgree, normName, type KnownEntity,
} from "./resolve-names.js";
import type { GraphWrite } from "./types.js";

export const MERGE_SIMILARITY = 0.92;
export const MIN_RELATION_CONF = 0.5;
export const AMBIGUOUS_MENTION_CONF = 0.55;
// A number read out of a document by the model. Below 1 (a connector's measurement), so it never replaces one
// (graph/observations.ts keeps the stronger reading).
export const EXTRACTED_OBSERVATION_CONF = 0.8;
const MAX_ALIASES = 12;

export interface ResolveContext {
  docId: string;                          // the Document node the extraction came from
  text: string;                           // the document text: every evidence quote must be found in it
  asOf?: string;                          // the document's date (ISO)
  existing: Map<string, KnownEntity>;     // id → entity already in the graph (or written earlier in this run)
  similar?: (type: EntityType, name: string) => Promise<{ id: string; score: number } | null>;
  founderNames?: string[];                // the tenant founder's own names ("Ankit"); they win over everything else
}

export interface Dropped { item: unknown; reason: string }

type Entity = Extraction["entities"][number];
type Relation = Extraction["relations"][number];
type Observed = Extraction["observations"][number];

interface Slot {
  id: string;
  type: EntityType;
  name: string;
  summary?: string;
  format?: string;
  aliases: string[];          // names this document used besides `name`
  known?: KnownEntity;        // set when the node is in the known map
  existing: boolean;          // the node exists (known, or a similar() hit outside the known map)
  maybeSameAs?: string;
}

interface Match { id: string; known?: KnownEntity; existing: boolean; maybeSameAs?: string }

// An endpoint lookup: an id plus how to register it once the item using it is accepted.
interface Endpoint { id: string; type: EntityType; commit: () => void }

class DocResolver {
  readonly dropped: Dropped[] = [];
  private readonly known: KnownIndex;
  private readonly founderNames: Set<string>;
  private readonly normDoc: string;
  private readonly docDay?: string;
  private readonly prov: { src: string; asOf?: string };
  private readonly edgeBase: { src: string; asOf?: string; since?: number; functional: false };
  private readonly slots = new Map<string, Slot>();
  private readonly docNames = new Map<string, string>();          // `${type}|${norm}` → id
  private readonly docBareNames = new Map<string, Set<string>>(); // norm → ids (an endpoint given with the wrong type)
  private readonly observations = new Map<string, ObservationInput>();
  private readonly obsByRef = new Map<string, string>();
  private readonly obsByMetric = new Map<string, string[]>();
  private readonly relEdges = new Map<string, EdgeInput>();

  constructor(private readonly ctx: ResolveContext) {
    if (typeFromId(ctx.docId) !== "Document") throw new Error(`docId must be a Document id, got ${ctx.docId}`);
    this.known = new KnownIndex(ctx.existing.values());
    this.founderNames = new Set((ctx.founderNames ?? []).map(normName).filter(Boolean));
    this.normDoc = normQuote(ctx.text);
    this.docDay = isoDay(ctx.asOf);
    this.prov = { src: ctx.docId, ...(ctx.asOf ? { asOf: ctx.asOf } : {}) };
    const since = ctx.asOf && Number.isFinite(Date.parse(ctx.asOf)) ? Date.parse(ctx.asOf) : undefined;
    this.edgeBase = { ...this.prov, ...(since !== undefined ? { since } : {}), functional: false };
  }

  private drop(item: unknown, reason: string): void {
    this.dropped.push({ item, reason });
  }

  // ---------- phase 1: entities ----------

  async resolveEntities(list: Entity[]): Promise<void> {
    for (const e of list) {
      if (!isExtractableType(e.type)) {
        this.drop(e, `type ${e.type} is not extractable`);
        continue;
      }
      const names = [e.name, ...(e.aliases ?? [])].map((n) => n.trim()).filter((n) => normName(n));
      if (!names.length) {
        this.drop(e, "entity has no usable name");
        continue;
      }
      const m = await this.match(e.type, names, true);
      if (!m) continue; // match() with similar always returns
      if (isReservedId(m.id)) {
        this.drop(e, `${e.type} "${e.name}" resolves to the reserved id ${m.id}`);
        continue;
      }
      const format = e.type === "Content" && (CONTENT_FORMATS as readonly string[]).includes(e.format ?? "") ? e.format : undefined;
      this.upsertSlot({
        id: m.id, type: e.type, name: this.displayName(m, names[0]!), known: m.known, existing: m.existing,
        maybeSameAs: m.maybeSameAs, format,
      }, names, e.summary.trim() || undefined);
    }
  }

  private isFounder(type: string, names: string[]): boolean {
    if (type !== "Person") return false;
    return names.some((n) => this.founderNames.has(normName(n))) || isFounderWord(names[0]!);
  }

  // Resolve a (type, names) pair to an id. similar() is only consulted for entities the model listed.
  private async match(type: EntityType, names: string[], useSimilar: boolean): Promise<Match | undefined> {
    if (this.isFounder(type, names)) {
      const known = this.known.byId(FOUNDER_ID);
      return { id: FOUNDER_ID, known, existing: !!known || !!this.slots.get(FOUNDER_ID)?.existing };
    }
    // past this point a role word ("founder") is only an alias of a named person, and never identifies anyone
    if (type === "Person") names = names.filter((n) => !isFounderWord(n));
    for (const n of names) {
      const id = this.docNames.get(`${type}|${normName(n)}`);
      if (id) return { id, known: this.slots.get(id)?.known, existing: this.slots.get(id)?.existing ?? false };
    }
    const fresh = entityId(type, names[0]!);
    const exact = this.known.byId(fresh);
    if (exact?.type === type) return { id: fresh, known: exact, existing: true };
    for (const n of names) {
      const k = this.known.byName(type, n);
      if (k) return { id: k.id, known: k, existing: true };
    }
    if (!useSimilar) return undefined;
    const hit = this.ctx.similar ? await this.ctx.similar(type, names[0]!) : null;
    if (hit && !isReservedId(hit.id) && typeFromId(hit.id) === type && Number.isFinite(hit.score) && hit.score >= MERGE_SIMILARITY) {
      if (hit.id === fresh) return { id: fresh, existing: true }; // in the graph, just not in the known map
      const cand = this.known.byId(hit.id);
      if (cand && namesAgree(names, [cand.name, ...(cand.aliases ?? [])])) return { id: hit.id, known: cand, existing: true };
      return { id: fresh, existing: false, maybeSameAs: hit.id };
    }
    return { id: fresh, existing: false };
  }

  private displayName(m: Match, name: string): string {
    if (m.known) return m.known.name;
    if (m.id === FOUNDER_ID && isFounderWord(name)) return this.ctx.founderNames?.[0] ?? "Founder";
    return clip(name, 120);
  }

  private upsertSlot(base: Omit<Slot, "aliases">, names: string[], summary?: string): Slot {
    let s = this.slots.get(base.id);
    if (!s) {
      s = { ...base, aliases: [] };
      this.slots.set(s.id, s);
    }
    if (!s.summary && summary) s.summary = summary;
    s.format ??= base.format;
    for (const n of names) {
      // a role word ("the founder") is not a name: it neither becomes an alias nor points at this person
      if (s.type === "Person" && isFounderWord(n) && s.id !== FOUNDER_ID) continue;
      this.addAlias(s, n);
      this.rememberName(s, n);
    }
    return s;
  }

  private addAlias(s: Slot, a: string): void {
    const norm = normName(a);
    const taken = [s.name, ...s.aliases, ...(s.known?.aliases ?? [])].some((x) => normName(x) === norm);
    if (norm && !taken && s.id !== FOUNDER_ID && !isFounderWord(a) && s.aliases.length < MAX_ALIASES) s.aliases.push(clip(a, 80));
  }

  private rememberName(s: Slot, n: string): void {
    const norm = normName(n);
    if (!norm) return;
    this.docNames.set(`${s.type}|${norm}`, s.id);
    this.docBareNames.set(norm, new Set([...(this.docBareNames.get(norm) ?? []), s.id]));
  }

  // An endpoint named in a relation or observation: an entity of this document, or one the graph already knows.
  private async endpoint(name: string, type: string): Promise<Endpoint | string> {
    const norm = normName(name);
    const label = `${type} "${name}"`;
    const bare = this.docBareNames.get(norm);
    const inDoc = this.docNames.get(`${type}|${norm}`) ?? (bare?.size === 1 ? [...bare][0] : undefined);
    if (inDoc) {
      const s = this.slots.get(inDoc)!;
      return { id: s.id, type: s.type, commit: () => {} };
    }
    if (!isExtractableType(type)) return `unknown endpoint ${label}`;
    const m = await this.match(type, [name], false);
    if (!m) return `unknown endpoint ${label}: not among the document's entities or the graph's`;
    if (isReservedId(m.id)) return `endpoint ${label} resolves to the reserved id ${m.id}`;
    return {
      id: m.id, type,
      commit: () => this.upsertSlot({ id: m.id, type, name: this.displayName(m, name), known: m.known, existing: m.existing }, [name]),
    };
  }

  // ---------- phase 2: observations ----------

  async resolveObservations(list: Observed[]): Promise<void> {
    for (const o of list) {
      const problem = await this.observation(o);
      if (problem) this.drop(o, problem);
    }
  }

  private async observation(o: Observed): Promise<string | undefined> {
    const subj = await this.endpoint(o.subject, o.subjectType);
    if (typeof subj === "string") return `observation subject: ${subj}`;
    const metric = metricSlug(o.metric);
    if (!metric) return `observation metric "${o.metric}" has no usable name`;
    if (!Number.isFinite(o.value)) return "observation value is not a number";
    const quote = quoteProblem(o.evidence, this.normDoc, { value: o.value }) ?? numberProblem(o.value, o.evidence);
    if (quote) return `observation: ${quote}`;
    const [asOf, windowStart, windowEnd] = [o.asOf, o.windowStart, o.windowEnd].map(isoDay);
    const bad = ([["asOf", o.asOf, asOf], ["windowStart", o.windowStart, windowStart], ["windowEnd", o.windowEnd, windowEnd]] as const)
      .find(([, given, day]) => given !== undefined && !day);
    if (bad) return `observation ${bad[0]} "${bad[1]}" is not a YYYY-MM-DD date`;
    if (windowStart && windowEnd && windowStart > windowEnd) return "observation window starts after it ends";
    const day = asOf ?? windowEnd ?? this.docDay;
    if (!day) return "observation has no date: neither the text nor the document gives one";
    const input: ObservationInput = {
      subject: subj.id, metric, value: o.value, ...(o.unit ? { unit: o.unit } : {}), asOf: day,
      ...(windowStart ? { windowStart } : {}), ...(windowEnd ? { windowEnd } : {}), src: this.ctx.docId,
      evidence: clip(o.evidence.trim(), LIMITS.evidenceChars), conf: EXTRACTED_OBSERVATION_CONF,
    };
    const id = observationId(input);
    const prev = this.observations.get(id);
    if (prev && prev.value !== input.value) return `observation ${id} already has the value ${prev.value} in this document`;
    subj.commit();
    this.observations.set(id, prev ?? input);
    if (o.ref) this.obsByRef.set(o.ref.trim(), id);
    this.obsByMetric.set(metric, [...new Set([...(this.obsByMetric.get(metric) ?? []), id])]);
    return undefined;
  }

  // ---------- phase 3: relations ----------

  async resolveRelations(list: Relation[]): Promise<void> {
    for (const r of list) {
      const problem = await this.relation(r);
      if (problem) this.drop(r, problem);
    }
  }

  private async relation(r: Relation): Promise<string | undefined> {
    if (!isExtractableRel(r.type)) return `relationship ${r.type} is not extractable`;
    if (!r.evidence.trim()) return "no evidence quote";
    if (!(r.conf >= MIN_RELATION_CONF && r.conf <= 1)) return `conf ${r.conf} is below ${MIN_RELATION_CONF} or out of range`;
    const quote = quoteProblem(r.evidence, this.normDoc);
    if (quote) return quote;
    const from = await this.endpoint(r.from, r.fromType);
    if (typeof from === "string") return from;
    const to = r.toType === "Observation" ? this.observationEndpoint(r.to) : await this.endpoint(r.to, r.toType);
    if (typeof to === "string") return to;
    if (from.id === to.id) return `${from.id} cannot ${r.type} itself`;
    if (!isAllowed(from.type, r.type, to.type)) return `${from.type} -[${r.type}]-> ${to.type} is not allowed by the ontology`;
    from.commit();
    to.commit();
    this.addRelationEdge(from.id, r.type, to.id, r);
    return undefined;
  }

  private observationEndpoint(ref: string): Endpoint | string {
    const byMetric = this.obsByMetric.get(metricSlug(ref));
    const id = this.obsByRef.get(ref.trim()) ?? (byMetric?.length === 1 ? byMetric[0] : undefined);
    return id ? { id, type: "Observation", commit: () => {} } : `unknown observation ${ref}`;
  }

  // Duplicates within a document keep the most confident one.
  private addRelationEdge(from: string, type: RelType, to: string, r: Relation): void {
    const conf = Math.round(r.conf * 100) / 100;
    const key = `${from}|${type}|${to}`;
    if ((this.relEdges.get(key)?.conf ?? -1) >= conf) return;
    this.relEdges.set(key, { from, type, to, conf, ...this.edgeBase, props: { evidence: clip(r.evidence.trim(), LIMITS.evidenceChars) } });
  }

  // ---------- phase 4: the write ----------

  write(): GraphWrite {
    const nodes: NodeInput[] = [];
    const edges: EdgeInput[] = [];
    for (const s of this.slots.values()) {
      const node = this.nodeFor(s);
      if (node) nodes.push(node);
      edges.push({ from: s.id, type: "SOURCED_FROM", to: this.ctx.docId, ...this.edgeBase });
      edges.push({
        from: this.ctx.docId, type: "MENTIONS", to: s.id, ...this.edgeBase,
        ...(s.maybeSameAs ? { conf: AMBIGUOUS_MENTION_CONF, props: { maybeSameAs: s.maybeSameAs } } : {}),
      });
    }
    edges.push(...this.relEdges.values());
    // belt and braces: nothing reserved leaves the resolver
    return {
      nodes: nodes.filter((n) => !isReservedId(n.id)),
      edges: edges.filter((e) => !isReservedId(e.from) && !isReservedId(e.to)),
      observations: [...this.observations.values()],
    };
  }

  // New nodes get name, summary, aliases and format; existing ones only learn aliases (never a rename).
  private nodeFor(s: Slot): NodeInput | undefined {
    if (!s.existing) {
      const props: Record<string, Prim> = {
        ...(s.aliases.length ? { aliases: s.aliases } : {}), ...(s.format ? { format: s.format } : {}),
      };
      return {
        type: s.type, id: s.id, name: s.name, ...(s.summary ? { summary: clip(s.summary, 400) } : {}),
        ...(Object.keys(props).length ? { props } : {}), ...this.prov,
      };
    }
    if (s.known && s.aliases.length) {
      return { type: s.type, id: s.id, name: s.known.name, props: { aliases: [...(s.known.aliases ?? []), ...s.aliases].slice(0, MAX_ALIASES) } };
    }
    return undefined;
  }
}

export async function resolveExtraction(ex: Extraction, ctx: ResolveContext): Promise<{ write: GraphWrite; dropped: Dropped[] }> {
  const r = new DocResolver(ctx);
  await r.resolveEntities(ex.entities);
  await r.resolveObservations(ex.observations); // before relations: a relation can point at an observation by ref
  await r.resolveRelations(ex.relations);
  return { write: r.write(), dropped: r.dropped };
}

// After a document's write is applied, add its entities to the known map so the next document resolves to them
// instead of minting near-duplicates.
export function rememberWrite(existing: Map<string, KnownEntity>, write: GraphWrite): void {
  for (const n of write.nodes) {
    if (n.type === "Observation") continue;
    const prev = existing.get(n.id);
    const aliases = Array.isArray(n.props?.aliases) ? (n.props!.aliases as string[]) : prev?.aliases;
    existing.set(n.id, { id: n.id, type: n.type, name: prev?.name ?? n.name, ...(aliases ? { aliases } : {}) });
  }
}
