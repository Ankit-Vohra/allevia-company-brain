// LLM extraction of one document (spec §6.4): prompt + JSON schema (extract-schema.ts) → LlmRunner → parsed
// Extraction, cached on disk so re-ingests only pay for changed documents. resolve.ts then turns an Extraction into a
// GraphWrite. This module is the public face of all three.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ONTOLOGY_VERSION, type EntityType, type RelType } from "../graph/schema.js";
import { sha256 } from "../util/ids.js";
import {
  LIMITS, PROMPT_VERSION, TRUNCATION_MARKER, extractionPrompt, extractionSchema, type BusinessContext, type Extraction,
} from "./extract-schema.js";
import type { LlmRunner } from "./llm.js";
import type { RawDoc } from "./types.js";

export * from "./extract-schema.js";
export * from "./resolve.js";
export * from "./resolve-names.js";
export * from "./resolve-evidence.js";
export type { LlmRunner, StructuredInput } from "./llm.js";
export { AgentSdkRunner } from "./llm.js";

// Cache key: the redacted text's hash and the document kind (both shape what the model sees); the ontology and prompt
// versions; the text of the system prompt (which carries the business context), of the user-prompt template and of the
// JSON schema, so any wording change re-extracts; the cut limits and the truncation marker (a long document's prompt
// depends on them); and the model alias. The template is the user prompt around placeholder documents, with and without
// the optional path and date lines. The resolved model id is only known after a call, so it is not part of the key.
// Title and date are left out on purpose (a re-fetched web page with a new date but the same text is not re-extracted);
// observation dates that fall back to the document date are filled in at resolution time, not cached. The options
// override the module's constants and are only for tests.
export interface CacheKeyOpts {
  ontology?: number;
  prompt?: number;
  docChars?: number;
  lineChars?: number;
  marker?: string;
  build?: typeof extractionPrompt;
}

export function cacheKey(doc: Pick<RawDoc, "hash" | "kind">, business: BusinessContext, model: string, opts: CacheKeyOpts = {}): string {
  const build = opts.build ?? extractionPrompt;
  const placeholder: RawDoc = { id: "document:key", kind: "note", title: "{title}", text: "{text}", hash: "" };
  const bare = build(placeholder, business, { nonce: "{nonce}" });
  const full = build({ ...placeholder, path: "{path}", asOf: "2000-01-01" }, business, { nonce: "{nonce}" });
  return sha256([
    doc.hash, `kind:${doc.kind}`, `ontology:${opts.ontology ?? ONTOLOGY_VERSION}`, `prompt:${opts.prompt ?? PROMPT_VERSION}`,
    `system:${sha256(bare.system)}`, `user:${sha256(JSON.stringify([bare.prompt, full.prompt]))}`,
    `schema:${sha256(JSON.stringify(extractionSchema()))}`,
    `docChars:${opts.docChars ?? LIMITS.docChars}`, `lineChars:${opts.lineChars ?? LIMITS.lineChars}`,
    `marker:${opts.marker ?? TRUNCATION_MARKER}`, `model:${model}`,
  ].join("|"));
}

export interface ExtractOpts { runner: LlmRunner; model: string; cacheDir: string }

export async function extractDoc(doc: RawDoc, business: BusinessContext, opts: ExtractOpts): Promise<{ extraction: Extraction; cached: boolean }> {
  const key = cacheKey(doc, business, opts.model);
  const file = join(opts.cacheDir, `${key}.json`);
  const hit = readCache(file);
  if (hit) return { extraction: hit, cached: true };

  const { system, prompt } = extractionPrompt(doc, business);
  const raw = await opts.runner.structured({ system, prompt, schema: extractionSchema(), model: opts.model });
  const extraction = parseExtraction(raw);
  mkdirSync(opts.cacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    key, docId: doc.id, docHash: doc.hash, model: opts.model, ontologyVersion: ONTOLOGY_VERSION, promptVersion: PROMPT_VERSION,
    createdAt: new Date().toISOString(), extraction,
  }, null, 1));
  renameSync(tmp, file);
  return { extraction, cached: false };
}

function readCache(file: string): Extraction | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { extraction?: unknown };
    return parseExtraction(data.extraction);
  } catch {
    return null; // missing or corrupt: extract again
  }
}

// ---------- parsing ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// "1,200" and "0.8" arrive as strings now and then; anything else that is not a finite number is NaN.
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?[\d,]*\.?\d+$/.test(v.trim())) return Number(v.trim().replace(/,/g, ""));
  return Number.NaN;
}

// Structural check only: keeps items with the right shape. Whether a type, pattern, date or endpoint is acceptable is
// resolve.ts's call, so that every semantic drop is reported with a reason.
export function parseExtraction(raw: unknown): Extraction {
  if (!isObj(raw)) throw new Error(`extraction must be an object, got ${raw === null ? "null" : typeof raw}`);
  const out: Extraction = { entities: [], relations: [], observations: [] };
  for (const e of list(raw.entities)) {
    if (!isObj(e) || !text(e.type) || !text(e.name)) continue;
    const aliases = list(e.aliases).map(text).filter((a): a is string => !!a);
    out.entities.push({
      type: text(e.type) as EntityType, name: text(e.name)!, summary: text(e.summary) ?? "",
      ...(aliases.length ? { aliases } : {}), ...(text(e.format) ? { format: text(e.format) } : {}),
    });
  }
  for (const r of list(raw.relations)) {
    if (!isObj(r)) continue;
    const [from, fromType, type, to, toType] = [r.from, r.fromType, r.type, r.to, r.toType].map(text);
    if (!from || !fromType || !type || !to || !toType) continue;
    out.relations.push({
      from, fromType: fromType as EntityType, type: type as RelType, to, toType: toType as EntityType,
      evidence: text(r.evidence) ?? "", conf: num(r.conf),
    });
  }
  for (const o of list(raw.observations)) {
    if (!isObj(o) || !text(o.metric) || !text(o.subject) || !text(o.subjectType)) continue;
    const value = num(o.value);
    if (!Number.isFinite(value)) continue;
    const opt = (k: "ref" | "unit" | "asOf" | "windowStart" | "windowEnd") => (text(o[k]) ? { [k]: text(o[k]) } : {});
    out.observations.push({
      ...opt("ref"), metric: text(o.metric)!, subject: text(o.subject)!, subjectType: text(o.subjectType) as EntityType, value,
      ...opt("unit"), ...opt("asOf"), ...opt("windowStart"), ...opt("windowEnd"), evidence: text(o.evidence) ?? "",
    });
  }
  return out;
}
