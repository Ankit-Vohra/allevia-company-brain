// Local multilingual embeddings (spec §6.5): Xenova/multilingual-e5-small (q8), 384 dims, mean-pooled and normalised,
// so cosine similarity is a dot product and English, Hindi and Hinglish land in one space. e5 wants a role prefix:
// "passage: " for what is stored (chunks, entities), "query: " for what is asked. The model loads once per process
// from <repo>/models (gitignored; ALLEVIA_MODELS_DIR overrides) and no text leaves the machine.
import { fileURLToPath } from "node:url";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { VECTOR_DIM } from "../graph/indexes.js";
import { idPrefix } from "../util/ids.js";
import type { EntityType } from "../graph/schema.js";

export const EMBED_MODEL = "Xenova/multilingual-e5-small";
export const MODELS_DIR = process.env.ALLEVIA_MODELS_DIR || fileURLToPath(new URL("../../models/", import.meta.url));
export const EMBED_BATCH = 32;
export const EMBED_MAX_CHARS = 2_000; // e5-small reads at most 512 tokens; this keeps the tokenizer's work bounded

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function model(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", cache_dir: MODELS_DIR }).catch((e: unknown) => {
    extractor = undefined; // let the next call try again
    throw e;
  });
  return extractor;
}

// "passage: <text>", trimmed and cut to EMBED_MAX_CHARS without splitting a surrogate pair.
export function prepare(role: "passage" | "query", text: string): string {
  let t = text.trim();
  if (t.length > EMBED_MAX_CHARS) {
    t = t.slice(0, EMBED_MAX_CHARS);
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  }
  return `${role}: ${t}`;
}

async function embed(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const ext = await model();
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    const tensor = await ext(inputs.slice(i, i + EMBED_BATCH), { pooling: "mean", normalize: true });
    const rows = tensor.tolist() as number[][];
    for (const r of rows) {
      if (r.length !== VECTOR_DIM) throw new Error(`${EMBED_MODEL} returned ${r.length} dims, expected ${VECTOR_DIM}`);
      out.push(r);
    }
  }
  return out;
}

export function embedPassages(texts: string[]): Promise<number[][]> {
  return embed(texts.map((t) => prepare("passage", t)));
}

export async function embedQuery(text: string): Promise<number[]> {
  return (await embed([prepare("query", text)]))[0]!;
}

// What an entity's vector stands for: its name, its kind in plain words and what the graph says about it.
// "Google Search Console (system). Google's search analytics tool."
export function entityText(n: { name: string; type: EntityType; summary?: string }): string {
  const kind = idPrefix(n.type).replace(/-/g, " ");
  const summary = n.summary?.trim();
  return `${n.name.trim()} (${kind}).${summary ? ` ${summary}` : ""}`;
}
