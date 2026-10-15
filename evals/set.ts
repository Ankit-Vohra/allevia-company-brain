// An eval set: one YAML file per tenant (evals/aamdani.yaml, evals/avs.yaml). Each item is a question for the agent
// company and what a good answer must show. Patterns (all optional, every one listed must hold):
// - mustCite: each entry must be matched by at least one valid citation in the answer. An entry is an id ("goal:x"),
//   an id glob ("decision:*paus*"), or a node label ("Observation"); "a|b" means either.
// - mustMatch: regexes the answer's prose (citation ids removed) must match. A plain string is case-insensitive;
//   "/body/flags" is used as written.
// - mustUseTools / mustUseAgents: a tool (or roster agent) the turn must have used; "a|b" means either.
// - forbid: regexes the answer must not match (invented numbers, hard-sell words).
// - simulated: the answer must say the data is simulated.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const patterns = z.array(z.string().min(1)).default([]);

export const EvalItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase words joined by hyphens"),
  question: z.string().min(3),
  tags: z.array(z.string().min(1)).min(1),
  note: z.string().optional(), // the graph facts the expectations rest on
  expect: z.object({
    mustCite: patterns,
    mustMatch: patterns,
    mustUseTools: patterns,
    mustUseAgents: patterns,
    forbid: patterns,
    simulated: z.boolean().default(false),
  }),
});

export const EvalSetSchema = z.object({
  tenant: z.string().regex(/^[a-z0-9_]+$/),
  description: z.string().optional(),
  items: z.array(EvalItemSchema).min(1),
}).superRefine((s, ctx) => {
  const seen = new Set<string>();
  for (const [i, it] of s.items.entries()) {
    if (seen.has(it.id)) ctx.addIssue({ code: "custom", path: ["items", i, "id"], message: `duplicate id "${it.id}"` });
    seen.add(it.id);
  }
});

export type EvalItem = z.infer<typeof EvalItemSchema>;
export type EvalSet = z.infer<typeof EvalSetSchema>;

export const EVALS_DIR = new URL("./", import.meta.url).pathname;

export function parseSet(text: string, source = "eval set"): EvalSet {
  const r = EvalSetSchema.safeParse(parse(text));
  if (!r.success) throw new Error(`${source}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

export function loadSet(path: string): EvalSet {
  return parseSet(readFileSync(path, "utf8"), basename(path));
}

// The set for a tenant: the file named after it ("avs" -> evals/avs.yaml) or the one whose `tenant:` is it.
export function findSet(tenantOrName: string, dir: string = EVALS_DIR): { path: string; set: EvalSet } {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const byName = files.find((f) => f.replace(/\.ya?ml$/, "") === tenantOrName);
  if (byName) return { path: join(dir, byName), set: loadSet(join(dir, byName)) };
  for (const f of files) {
    const set = loadSet(join(dir, f));
    if (set.tenant === tenantOrName) return { path: join(dir, f), set };
  }
  throw new Error(`No eval set for "${tenantOrName}" in ${dir} (have: ${files.join(", ") || "none"}).`);
}

// --only a,b (ids, in the order given), --tags x,y (any of them), --limit N (the first N after filtering).
export function selectItems(items: EvalItem[], o: { only?: string[]; tags?: string[]; limit?: number } = {}): EvalItem[] {
  let out = items;
  if (o.only?.length) {
    const missing = o.only.filter((id) => !items.some((it) => it.id === id));
    if (missing.length) throw new Error(`unknown eval id${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    out = o.only.map((id) => items.find((it) => it.id === id)!);
  }
  if (o.tags?.length) out = out.filter((it) => it.tags.some((t) => o.tags!.includes(t)));
  if (o.limit !== undefined && o.limit >= 0) out = out.slice(0, o.limit);
  return out;
}
