// Stand-in embeddings for the synthetic demo graphs (and the tests): no model needed. When the local e5 model is present
// the seed command replaces them with real vectors.
import { VECTOR_DIM } from "../graph/indexes.js";

// Deterministic stand-in for e5 embeddings: hashed bag of (crudely stemmed) words, L2-normalised. Texts that share
// words are close; texts that share none are orthogonal.
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(VECTOR_DIM).fill(0);
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    const w = raw.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % VECTOR_DIM]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
