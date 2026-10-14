// Spike: local multilingual embeddings (English + Hindi) with no API. Model cached under ./models (gitignored).
import { pipeline, env } from "@huggingface/transformers";
env.cacheDir = new URL("../../models/", import.meta.url).pathname;
const t0 = Date.now();
const embed = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });
const t1 = Date.now();
const texts = ["query: how many signups this week", "passage: 55 new users signed up between 29 Sep and 5 Oct", "passage: the Instagram token expires every 60 days", "query: kitne naye users aaye is hafte"];
const out = await embed(texts, { pooling: "mean", normalize: true });
const v = out.tolist() as number[][];
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
console.log({ loadMs: t1 - t0, embedMs: Date.now() - t1, dim: v[0]!.length, q_vs_signups: cos(v[0]!, v[1]!).toFixed(3), q_vs_token: cos(v[0]!, v[2]!).toFixed(3), hindiQ_vs_signups: cos(v[3]!, v[1]!).toFixed(3), hindiQ_vs_token: cos(v[3]!, v[2]!).toFixed(3) });
