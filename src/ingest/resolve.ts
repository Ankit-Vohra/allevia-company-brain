// Entity resolution (spec §6.4): turns one document's Extraction into a GraphWrite. Precision over recall: anything
// the ontology does not allow, that has no evidence in the document, or whose endpoints cannot be pinned down is
// dropped with a reason, never guessed.
//
// Name → id, within one type: the founder's references → person:founder; a name already used in this document; the
// exact id; a known name or alias; similar() ≥ MERGE_SIMILARITY; else a new entityId(type, name). A near miss
// (AMBIGUOUS_SIMILARITY ≤ score < MERGE_SIMILARITY) becomes a new node whose MENTIONS edge carries conf < 0.6 and
// `maybeSameAs`, for the librarian to look at. Existing nodes are never renamed or re-summarised by extraction; they
// only learn new aliases. Extracted edges are never functional: a document read by an LLM does not close facts that
// came from deterministic sources (the librarian handles contradictions).
import { isAllowed, type EntityType } from "../graph/schema.js";
import { observationId, type EdgeInput, type NodeInput, type ObservationInput } from "../graph/upsert.js";
import { entityId, typeFromId } from "../util/ids.js";
import { LIMITS, isExtractableRel, isExtractableType, type Extraction } from "./extract-schema.js";
import type { GraphWrite } from "./types.js";

export const MERGE_SIMILARITY = 0.92;
export const AMBIGUOUS_SIMILARITY = 0.8;
export const MIN_RELATION_CONF = 0.5;
export const AMBIGUOUS_MENTION_CONF = 0.55;
export const FOUNDER_ID = "person:founder";
// Allevia's own staff (shared/roster.ts) lives under these ids; extraction never creates or touches them.
export const RESERVED_ID = /^(agent|team):allevia(-|$)/;
const FOUNDER_WORDS = new Set(["founder", "our founder", "founder ceo", "founder and ceo", "ceo and founder", "co founder and ceo"]);
const MAX_ALIASES = 12;

export interface KnownEntity { id: string; type: EntityType; name: string; aliases?: string[] }

export interface ResolveContext {
  docId: string;                          // the Document node the extraction came from
  asOf?: string;                          // the document's date (ISO)
  existing: Map<string, KnownEntity>;     // id → entity already in the graph (or written earlier in this run)
  similar?: (type: EntityType, name: string) => Promise<{ id: string; score: number } | null>;
  founderNames?: string[];                // the tenant founder's own names ("Ankit") → person:founder
  text?: string;                          // the document text: when given, every evidence quote must be found in it
}

export interface Dropped { item: unknown; reason: string }

// Case, punctuation and a leading "the" do not distinguish names.
export function normName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim().replace(/^the /, "");
}

export function metricSlug(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60).replace(/_+$/, "");
}

// "YYYY-MM-DD" for a valid ISO date or datetime, else undefined.
export function isoDay(s: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s?.trim() ?? "");
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? d.toISOString().slice(0, 10) : undefined;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const quoteNorm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}%₹$]+/gu, " ").trim();

interface Slot {
  id: string;
  type: EntityType;
  name: string;
  summary?: string;
  aliases: string[];          // names this document used besides `name`
  known?: KnownEntity;        // set when the node already exists
  existing: boolean;          // the node exists (known, or a similar() hit outside the known map)
  maybeSameAs?: string;
}

// An endpoint lookup: an id plus how to register it once the item using it is accepted.
interface Endpoint { id: string; type: EntityType; commit: () => void }

export async function resolveExtraction(ex: Extraction, ctx: ResolveContext): Promise<{ write: GraphWrite; dropped: Dropped[] }> {
  if (typeFromId(ctx.docId) !== "Document") throw new Error(`docId must be a Document id, got ${ctx.docId}`);
  const dropped: Dropped[] = [];
  const drop = (item: unknown, reason: string) => dropped.push({ item, reason });
  const docDay = isoDay(ctx.asOf);
  const sinceMs = ctx.asOf && Number.isFinite(Date.parse(ctx.asOf)) ? Date.parse(ctx.asOf) : undefined;
  const prov = { src: ctx.docId, ...(ctx.asOf ? { asOf: ctx.asOf } : {}) };
  const docText = ctx.text === undefined ? undefined : quoteNorm(ctx.text);

  // what the graph already knows, by id and by (type, normalised name or alias)
  const knownById = new Map<string, KnownEntity>();
  const knownByName = new Map<string, string>();
  for (const k of ctx.existing.values()) {
    knownById.set(k.id, k);
    for (const n of [k.name, ...(k.aliases ?? [])]) {
      const key = `${k.type}|${normName(n)}`;
      if (!knownByName.has(key)) knownByName.set(key, k.id);
    }
  }
  const founder = new Set([...FOUNDER_WORDS, ...(ctx.founderNames ?? []).map(normName)]);
  const isFounder = (type: string, names: string[]) => type === "Person" && names.some((n) => founder.has(normName(n)));

  // this document's entities
  const slots = new Map<string, Slot>();
  const docByName = new Map<string, string>();            // `${type}|${norm}` → id
  const docByBareName = new Map<string, Set<string>>();   // norm → ids (for an endpoint given with the wrong type)
  const remember = (s: Slot, n: string) => {
    const norm = normName(n);
    if (!norm) return;
    docByName.set(`${s.type}|${norm}`, s.id);
    docByBareName.set(norm, new Set([...(docByBareName.get(norm) ?? []), s.id]));
  };
  const addAlias = (s: Slot, a: string) => {
    const norm = normName(a);
    const taken = [s.name, ...s.aliases, ...(s.known?.aliases ?? [])].some((x) => normName(x) === norm);
    if (norm && !taken && s.id !== FOUNDER_ID && s.aliases.length < MAX_ALIASES) s.aliases.push(clip(a, 80));
  };
  const upsertSlot = (base: Omit<Slot, "aliases">, names: string[], summary?: string): Slot => {
    let s = slots.get(base.id);
    if (!s) {
      s = { ...base, aliases: [] };
      slots.set(s.id, s);
    }
    if (!s.summary && summary) s.summary = summary;
    for (const n of names) {
      addAlias(s, n);
      remember(s, n);
    }
    return s;
  };

  // Resolve a (type, names) pair to an id. `similar` is only consulted for entities the model listed.
  async function match(type: EntityType, names: string[], useSimilar: boolean): Promise<{ id: string; known?: KnownEntity; existing: boolean; maybeSameAs?: string } | undefined> {
    if (isFounder(type, names)) return { id: FOUNDER_ID, known: knownById.get(FOUNDER_ID), existing: knownById.has(FOUNDER_ID) };
    for (const n of names) {
      const id = docByName.get(`${type}|${normName(n)}`);
      if (id) return { id, known: slots.get(id)?.known, existing: slots.get(id)?.existing ?? false };
    }
    const fresh = entityId(type, names[0]!);
    const exact = knownById.get(fresh);
    if (exact?.type === type) return { id: fresh, known: exact, existing: true };
    for (const n of names) {
      const id = knownByName.get(`${type}|${normName(n)}`);
      if (id) return { id, known: knownById.get(id), existing: true };
    }
    if (!useSimilar) return undefined;
    const hit = ctx.similar ? await ctx.similar(type, names[0]!) : null;
    if (hit && hit.id !== fresh && typeFromId(hit.id) === type && Number.isFinite(hit.score)) {
      if (hit.score >= MERGE_SIMILARITY) return { id: hit.id, known: knownById.get(hit.id), existing: true };
      if (hit.score >= AMBIGUOUS_SIMILARITY) return { id: fresh, existing: false, maybeSameAs: hit.id };
    }
    return { id: fresh, existing: false };
  }

  // An endpoint named in a relation or observation: an entity of this document, or one the graph already knows.
  async function endpoint(name: string, type: string): Promise<Endpoint | string> {
    const norm = normName(name);
    const label = `${type} "${name}"`;
    const inDoc = docByName.get(`${type}|${norm}`) ?? (docByBareName.get(norm)?.size === 1 ? [...docByBareName.get(norm)!][0] : undefined);
    if (inDoc) {
      const s = slots.get(inDoc)!;
      return { id: s.id, type: s.type, commit: () => {} };
    }
    if (!isExtractableType(type)) return `unknown endpoint ${label}`;
    const m = await match(type, [name], false);
    if (!m) return `unknown endpoint ${label}: not among the document's entities or the graph's`;
    if (RESERVED_ID.test(m.id)) return `endpoint ${label} resolves to the reserved id ${m.id}`;
    const isNewFounder = m.id === FOUNDER_ID && !m.existing;
    return {
      id: m.id, type,
      commit: () => upsertSlot({
        id: m.id, type, name: m.known?.name ?? (isNewFounder ? ctx.founderNames?.[0] ?? "Founder" : name), known: m.known, existing: m.existing,
      }, [name]),
    };
  }

  const evidenceProblem = (evidence: string): string | undefined => {
    if (!evidence.trim()) return "no evidence quote";
    if (docText === undefined) return undefined;
    const parts = evidence.split(/\.{3}|…/).map(quoteNorm).filter(Boolean);
    return parts.length && parts.every((p) => docText.includes(p)) ? undefined : "evidence not found in the document";
  };

  // ---- entities ----
  for (const e of ex.entities) {
    if (!isExtractableType(e.type)) {
      drop(e, `type ${e.type} is not extractable`);
      continue;
    }
    const names = [e.name, ...(e.aliases ?? [])].map((n) => n.trim()).filter((n) => normName(n));
    if (!names.length) {
      drop(e, "entity has no usable name");
      continue;
    }
    const m = (await match(e.type, names, true))!;
    if (RESERVED_ID.test(m.id)) {
      drop(e, `${e.type} "${e.name}" resolves to the reserved id ${m.id}`);
      continue;
    }
    const name = m.known?.name ?? (m.id === FOUNDER_ID && !m.existing ? ctx.founderNames?.[0] ?? "Founder" : clip(names[0]!, 120));
    upsertSlot({ id: m.id, type: e.type, name, known: m.known, existing: m.existing, maybeSameAs: m.maybeSameAs }, names, e.summary.trim() || undefined);
  }

  // ---- observations (before relations: a relation can point at one by ref) ----
  const observations = new Map<string, ObservationInput>();
  const obsByRef = new Map<string, string>();
  const obsByMetric = new Map<string, string[]>();
  for (const o of ex.observations) {
    const subj = await endpoint(o.subject, o.subjectType);
    if (typeof subj === "string") {
      drop(o, `observation subject: ${subj}`);
      continue;
    }
    const metric = metricSlug(o.metric);
    if (!metric) {
      drop(o, `observation metric "${o.metric}" has no usable name`);
      continue;
    }
    if (!Number.isFinite(o.value)) {
      drop(o, "observation value is not a number");
      continue;
    }
    const ev = evidenceProblem(o.evidence);
    if (ev) {
      drop(o, `observation: ${ev}`);
      continue;
    }
    const [asOf, windowStart, windowEnd] = [o.asOf, o.windowStart, o.windowEnd].map(isoDay);
    const badDate = ([["asOf", o.asOf, asOf], ["windowStart", o.windowStart, windowStart], ["windowEnd", o.windowEnd, windowEnd]] as const)
      .find(([, given, day]) => given !== undefined && !day);
    if (badDate) {
      drop(o, `observation ${badDate[0]} "${badDate[1]}" is not a YYYY-MM-DD date`);
      continue;
    }
    if (windowStart && windowEnd && windowStart > windowEnd) {
      drop(o, "observation window starts after it ends");
      continue;
    }
    const day = asOf ?? windowEnd ?? docDay;
    if (!day) {
      drop(o, "observation has no date: neither the text nor the document gives one");
      continue;
    }
    const input: ObservationInput = {
      subject: subj.id, metric, value: o.value, ...(o.unit ? { unit: o.unit } : {}), asOf: day,
      ...(windowStart ? { windowStart } : {}), ...(windowEnd ? { windowEnd } : {}), src: ctx.docId,
      evidence: clip(o.evidence.trim(), LIMITS.evidenceChars),
    };
    const id = observationId(input);
    const prev = observations.get(id);
    if (prev && prev.value !== input.value) {
      drop(o, `observation ${id} already has the value ${prev.value} in this document`);
      continue;
    }
    subj.commit();
    observations.set(id, prev ?? input);
    if (o.ref) obsByRef.set(o.ref.trim(), id);
    obsByMetric.set(metric, [...new Set([...(obsByMetric.get(metric) ?? []), id])]);
  }

  // ---- relations ----
  const relEdges = new Map<string, EdgeInput>();
  for (const r of ex.relations) {
    if (!isExtractableRel(r.type)) {
      drop(r, `relationship ${r.type} is not extractable`);
      continue;
    }
    const ev = evidenceProblem(r.evidence);
    if (ev === "no evidence quote") {
      drop(r, ev);
      continue;
    }
    if (!(r.conf >= MIN_RELATION_CONF && r.conf <= 1)) {
      drop(r, `conf ${r.conf} is below ${MIN_RELATION_CONF} or out of range`);
      continue;
    }
    if (ev) {
      drop(r, ev);
      continue;
    }
    const from = await endpoint(r.from, r.fromType);
    if (typeof from === "string") {
      drop(r, from);
      continue;
    }
    let to: Endpoint | string;
    if (r.toType === "Observation") {
      const byMetric = obsByMetric.get(metricSlug(r.to));
      const id = obsByRef.get(r.to.trim()) ?? (byMetric?.length === 1 ? byMetric[0] : undefined);
      to = id ? { id, type: "Observation", commit: () => {} } : `unknown observation ${r.to}`;
    } else {
      to = await endpoint(r.to, r.toType);
    }
    if (typeof to === "string") {
      drop(r, to);
      continue;
    }
    if (from.id === to.id) {
      drop(r, `${from.id} cannot ${r.type} itself`);
      continue;
    }
    if (!isAllowed(from.type, r.type, to.type)) {
      drop(r, `${from.type} -[${r.type}]-> ${to.type} is not allowed by the ontology`);
      continue;
    }
    from.commit();
    to.commit();
    const conf = Math.round(r.conf * 100) / 100;
    const key = `${from.id}|${r.type}|${to.id}`;
    if ((relEdges.get(key)?.conf ?? -1) >= conf) continue;
    relEdges.set(key, {
      from: from.id, type: r.type, to: to.id, conf, ...prov, ...(sinceMs !== undefined ? { since: sinceMs } : {}), functional: false,
      props: { evidence: clip(r.evidence.trim(), LIMITS.evidenceChars) },
    });
  }

  // ---- nodes and provenance edges ----
  const nodes: NodeInput[] = [];
  const edges: EdgeInput[] = [];
  const edgeBase = { ...prov, ...(sinceMs !== undefined ? { since: sinceMs } : {}), functional: false };
  for (const s of slots.values()) {
    if (!s.existing) {
      nodes.push({
        type: s.type, id: s.id, name: s.name, ...(s.summary ? { summary: clip(s.summary, 400) } : {}),
        ...(s.aliases.length ? { props: { aliases: s.aliases } } : {}), ...prov,
      });
    } else if (s.known && s.aliases.length) {
      nodes.push({ type: s.type, id: s.id, name: s.known.name, props: { aliases: [...(s.known.aliases ?? []), ...s.aliases].slice(0, MAX_ALIASES) } });
    }
    edges.push({ from: s.id, type: "SOURCED_FROM", to: ctx.docId, ...edgeBase });
    edges.push({
      from: ctx.docId, type: "MENTIONS", to: s.id, ...edgeBase,
      ...(s.maybeSameAs ? { conf: AMBIGUOUS_MENTION_CONF, props: { maybeSameAs: s.maybeSameAs } } : {}),
    });
  }
  edges.push(...relEdges.values());

  const write: GraphWrite = { nodes, edges, observations: [...observations.values()] };
  // belt and braces: nothing reserved leaves this function
  write.nodes = write.nodes.filter((n) => !RESERVED_ID.test(n.id));
  write.edges = write.edges.filter((e) => !RESERVED_ID.test(e.from) && !RESERVED_ID.test(e.to));
  return { write, dropped };
}

// After a document's write is applied, add its entities to the known map so the next document resolves to them
// instead of minting near-duplicates.
export function rememberWrite(existing: Map<string, KnownEntity>, write: GraphWrite): void {
  for (const n of write.nodes) {
    if (n.type === "Observation") continue;
    const prev = existing.get(n.id);
    const aliases = Array.isArray(n.props?.aliases) ? (n.props.aliases as string[]) : prev?.aliases;
    existing.set(n.id, { id: n.id, type: n.type, name: prev?.name ?? n.name, ...(aliases ? { aliases } : {}) });
  }
}
