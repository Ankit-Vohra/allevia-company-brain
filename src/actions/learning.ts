// The visible learning loop (product design §3.2 "Learning made visible", §9 item 3). When the owner edits a draft
// before approving it, the edit is diffed against the draft and turned into learned rules:
//   Rule {kind:'learned', text, confidence, appliedCount, status:'active', op, …}
//     -LEARNED_FROM-> the Approval, -APPLIES_TO-> the agent that drafted it (and the channel), PRODUCED by the copy
//     editor (agent:allevia-copy-editor), and a `learned` AgentEvent for the office and the Approvals chip.
// Extraction is deterministic first: word substitutions ("villa" -> "home"), emoji removed, exclamation marks removed,
// hype words cut, the draft cut to under 70% of its length. Only an edit with none of those that still rewrote a third
// or more of the words goes to the optional Haiku summary (off unless an LlmRunner is passed).
// Later drafts apply the active rules: deterministic ones (replace, remove_emoji, no_exclaim) rewrite the text directly;
// the rest go into the drafting instructions. The draft records USES_RULE for each and the rule's appliedCount grows.
// The same lesson learned again reinforces its rule (confidence +0.1, up to 0.95, each step a Version); a substitution that
// reverses an active one retires the old rule (Version) and records CONTRADICTS.
// In the graph: a card (Recommendation and Approval) is GUIDED_BY each rule that shaped it, with how it did ("rewrote" the
// text, with find and replace, or "instructed" the writer), and so is the draft's USES_RULE; LEARNED_FROM carries the
// approval as its src, the date, the rule's confidence and the fragment before and after the owner's edit.
// recordLearningMetrics writes the Business's allevia.first_pass_rate (30 days), allevia.learned_rules and
// allevia.deliverables_approved Observations, one per day, so the curve is history, not a single number.
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { addObservation, closeEdge, upsertEdge, upsertNode } from "../graph/upsert.js";
import type { LlmRunner } from "../ingest/llm.js";
import { entityId } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { addDays, clip } from "../insights/text.js";
import { skillsForLearnedRule } from "../agent/skills/business.js";
import { ensureAgentNode, existingIds } from "./shared.js";

type Read = Pick<GraphHandle, "roQuery">;
export type LearnedEvent = Extract<AgentEvent, { type: "learned" }>;

export const COPY_EDITOR = "copy-editor";
export const LEARNING_SRC = "allevia:approvals";

export type RuleOp = "replace" | "remove_emoji" | "no_exclaim" | "avoid_words" | "max_words" | "instruction";
export const DETERMINISTIC_OPS: ReadonlySet<RuleOp> = new Set(["replace", "remove_emoji", "no_exclaim"]);

export interface RuleSpec {
  id: string;
  op: RuleOp;
  text: string;
  confidence: number;
  find?: string;
  replace?: string;
  words?: string[];
  max?: number;
}

// ---------- word diff ----------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
const EMOJI_ALL = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\u{FE0F}\u{200D}\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}]*/gu;

// Words people cut when a draft sounds like an ad. Detected on deletion only; the rule is an instruction, not a
// blind delete (removing an adjective mid-sentence can break the grammar).
export const TONE_WORDS = new Set([
  "amazing", "stunning", "incredible", "awesome", "unbelievable", "luxurious", "luxury", "breathtaking", "exquisite",
  "game-changer", "game-changing", "revolutionary", "unlock", "unleash", "elevate", "elevated", "seamless", "seamlessly",
  "cutting-edge", "world-class", "best-in-class", "ultimate", "perfect", "dream", "magical", "epic", "insane", "super",
  "truly", "really", "very", "absolutely", "literally", "exclusive", "premium", "iconic", "spectacular", "jaw-dropping",
]);
const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "is", "are", "be", "it", "this", "that"]);

// Words with surrounding punctuation and emoji stripped (`raw`, as written) and lowercased (`w`, for comparing).
function tokens(text: string): Array<{ w: string; raw: string }> {
  return text.split(/\s+/)
    .map((t) => t.replace(EMOJI_ALL, "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .map((raw) => ({ w: raw.toLowerCase(), raw }))
    .filter((t) => t.w);
}

// Lowercased words with surrounding punctuation and emoji stripped; empty tokens dropped.
export function words(text: string): string[] {
  return tokens(text).map((t) => t.w);
}

// delAt / insAt: where each deleted / inserted word sits in its text (to recover how it was written).
export interface Hunk { del: string[]; ins: string[]; delAt: number[]; insAt: number[] }

const MAX_CELLS = 4_000_000; // LCS table bound; beyond it the edit counts as a rewrite

// Word-level diff (LCS): the runs of deleted and inserted words between unchanged ones. null when too big to diff.
export function wordDiff(a: string[], b: string[]): Hunk[] | null {
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  const flush = () => { if (cur && (cur.del.length || cur.ins.length)) hunks.push(cur); cur = null; };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    cur ??= { del: [], ins: [], delAt: [], insAt: [] };
    if (j < m && (i >= n || L[i]![j + 1]! >= L[i + 1]![j]!)) { cur.insAt.push(j); cur.ins.push(b[j++]!); }
    else { cur.delAt.push(i); cur.del.push(a[i++]!); }
  }
  flush();
  return hunks;
}

// Normalised word-level Levenshtein distance: 0 = same words, 1 = nothing in common. Bounded like wordDiff.
export function editDistance(a: string, b: string): number {
  const x = words(a), y = words(b);
  const n = x.length, m = y.length;
  if (!n && !m) return 0;
  if (!n || !m) return 1;
  if ((n + 1) * (m + 1) > MAX_CELLS) return 1;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = [i];
    for (let j = 1; j <= m; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return Math.round((prev[m]! / Math.max(n, m)) * 1000) / 1000;
}

// ---------- rule extraction ----------

const ruleId = (key: string): string => entityId("Rule", `learned ${key}`);
const quote = (s: string) => `"${s}"`;
const numeric = (w: string) => /^[\p{N}.,%₹$£€]+$/u.test(w);

// find matches case-insensitively; `said` is how the draft wrote it, for the rule's text ("Instagram", not "instagram").
export function replaceRule(find: string, replace: string, occurrences = 1, said = find): RuleSpec {
  return {
    id: ruleId(`say ${replace} not ${find}`), op: "replace", find, replace, text: `Say ${quote(replace)}, not ${quote(said)}.`,
    confidence: Math.min(0.8, 0.6 + 0.1 * (occurrences - 1)),
  };
}

export interface Extraction { rules: RuleSpec[]; complex: boolean; distance: number }

// The lessons in one edit. `complex` marks a substantial rewrite with no deterministic lesson (a Haiku candidate).
export function extractRules(original: string, edited: string): Extraction {
  const distance = editDistance(original, edited);
  const at = tokens(original), a = at.map((t) => t.w), bt = tokens(edited), b = bt.map((t) => t.w);
  const upper = (x: string | undefined) => !!x && /^\p{Lu}/u.test(x);
  const rules: RuleSpec[] = [];
  const hunks = wordDiff(a, b);
  const pairs = new Map<string, { find: string; replace: string; said: string; n: number }>();
  const cut = new Set<string>();
  for (const h of hunks ?? []) {
    const tone = h.del.filter((w) => TONE_WORDS.has(w) && !h.ins.includes(w));
    for (const w of tone) cut.add(w);
    const del = h.del.filter((w) => !TONE_WORDS.has(w));
    const keep = h.ins.map((w, k) => ({ w, raw: bt[h.insAt[k]!]!.raw })).filter((x) => !TONE_WORDS.has(x.w));
    const ins = keep.map((x) => x.w);
    if (!del.length || !ins.length || del.length > 3 || ins.length > 3) continue;
    if ([...del, ...ins].some(numeric)) continue;                       // a corrected number is a fact, not a style
    if ([...del, ...ins].every((w) => STOP.has(w))) continue;           // "a" -> "the" teaches nothing
    if (del.every((w) => STOP.has(w))) continue;                        // "the" -> "our" is one sentence rewritten, not a style (content trial)
    // The replacement as the owner wrote it ("by Friday"), except a capital that only marks a sentence start: "Villa"
    // -> "Home" at the start of a title teaches "home".
    let replace = keep.map((x) => x.raw).join(" ");
    let said = h.del.map((w, k) => ({ w, raw: at[h.delAt[k]!]!.raw })).filter((x) => !TONE_WORDS.has(x.w)).map((x) => x.raw).join(" ");
    if (upper(said) && upper(replace) && /^\p{Lu}\p{Ll}*(\s|$)/u.test(replace)) {
      replace = replace[0]!.toLowerCase() + replace.slice(1);
      said = said[0]!.toLowerCase() + said.slice(1);
    }
    const find = del.join(" ");
    if (find === replace.toLowerCase()) continue;
    const k = `${find}\u0000${replace.toLowerCase()}`;
    const prev = pairs.get(k);
    pairs.set(k, { find, replace: prev?.replace ?? replace, said: prev?.said ?? said, n: (prev?.n ?? 0) + 1 });
  }
  // Many scattered substitutions are a rewrite, not a pattern: keep only the ones the owner made more than once.
  const rewrite = (hunks?.length ?? Infinity) > 6;
  for (const p of pairs.values()) if (!rewrite || p.n >= 2) rules.push(replaceRule(p.find, p.replace, p.n, p.said));
  if (EMOJI.test(original) && !EMOJI.test(edited)) rules.push({ id: ruleId("no emoji"), op: "remove_emoji", text: "No emojis.", confidence: 0.7 });
  if (original.includes("!") && !edited.includes("!")) rules.push({ id: ruleId("no exclamation marks"), op: "no_exclaim", text: "No exclamation marks.", confidence: 0.6 });
  if (cut.size) {
    const ws = [...cut].sort();
    rules.push({ id: ruleId(`avoid ${ws.join(" ")}`), op: "avoid_words", words: ws, text: `Avoid hype words: ${ws.map(quote).join(", ")}.`, confidence: 0.6 });
  }
  if (a.length >= 15 && b.length > 0 && b.length <= 0.7 * a.length) {
    const max = Math.max(10, Math.ceil(b.length / 5) * 5);
    rules.push({ id: ruleId("max words"), op: "max_words", max, text: `Keep it under ${max} words.`, confidence: 0.5 });
  }
  return { rules, complex: !rules.length && distance >= 0.3, distance };
}

// ---------- applying rules ----------

export interface ActiveRule {
  id: string; kind: "learned" | "brand"; text: string; op: RuleOp; confidence: number; appliedCount: number;
  find?: string; replace?: string; words?: string[]; max?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matchCase(found: string, repl: string): string {
  if (found === found.toUpperCase() && /\p{Lu}/u.test(found) && found.length > 1) return repl.toUpperCase();
  return /^\p{Lu}/u.test(found) ? repl[0]!.toUpperCase() + repl.slice(1) : repl;
}

// One deterministic rule over a text; returns the text unchanged when the rule does not apply.
export function applyRule(text: string, r: Pick<ActiveRule, "op" | "find" | "replace">): string {
  switch (r.op) {
    case "replace": {
      if (!r.find || r.replace === undefined) return text;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${r.find.split(/\s+/).map(escapeRe).join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
      return text.replace(re, (m) => matchCase(m, r.replace!));
    }
    case "remove_emoji":
      return text.replace(EMOJI_ALL, "").replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?;:])/g, "$1").replace(/[ \t]+$/gm, "");
    case "no_exclaim":
      return text.replace(/!+/g, ".").replace(/\.{2,}/g, ".");
    default:
      return text;
  }
}

export interface Applied { title: string; body: string; applied: ActiveRule[]; instructions: ActiveRule[] }

// Deterministic rules rewrite title and body (a rule counts as applied only when it changed something); the rest
// become instructions for whoever drafts next (a model prompt, or the brief's checklist).
export function applyRules(input: { title: string; body: string }, rules: ActiveRule[]): Applied {
  let { title, body } = input;
  const applied: ActiveRule[] = [], instructions: ActiveRule[] = [];
  for (const r of rules) {
    if (DETERMINISTIC_OPS.has(r.op)) {
      const t = applyRule(title, r), b = applyRule(body, r);
      if (t !== title || b !== body) applied.push(r);
      title = t;
      body = b;
    } else {
      instructions.push(r);
    }
  }
  return { title, body, applied, instructions };
}

interface RuleRow { id: string; text: string | null; name: string | null; op: string | null; find: string | null; replace: string | null; words: string[] | null; max: number | null; confidence: number | null; appliedCount: number | null }

// Active learned rules in scope (no APPLIES_TO = everywhere; else the drafting agent, the channel or the business),
// most confident first; and brand rules scoped to the agent, the channel or the business (capped, most specific first).
export async function activeRules(g: Read, scope: { agentId?: string; channelId?: string; businessId?: string | null }, opts: { brand?: boolean } = {}): Promise<ActiveRule[]> {
  const ids = [scope.agentId, scope.channelId, scope.businessId].filter((x): x is string => !!x);
  const learned = await g.roQuery<RuleRow>(
    `MATCH (r:Rule) WHERE r.kind = 'learned' AND r.status = 'active'
     OPTIONAL MATCH (r)-[a:APPLIES_TO]->(t:Entity) WHERE a.until IS NULL
     WITH r, collect(t.id) AS scope
     WHERE size(scope) = 0 OR size([s IN scope WHERE s IN $ids]) > 0
     RETURN r.id AS id, r.text AS text, r.name AS name, r.op AS op, r.find AS find, r.replace AS replace, r.words AS words,
            r.max AS max, r.confidence AS confidence, r.appliedCount AS appliedCount
     ORDER BY coalesce(r.confidence, 0) DESC, id LIMIT 50`, { ids });
  const out: ActiveRule[] = learned.map((r) => ({
    id: r.id, kind: "learned", text: r.text ?? r.name ?? r.id, op: (r.op ?? "instruction") as RuleOp, confidence: r.confidence ?? 0.5,
    appliedCount: r.appliedCount ?? 0, ...(r.find ? { find: r.find } : {}), ...(typeof r.replace === "string" ? { replace: r.replace } : {}),
    ...(r.words ? { words: r.words } : {}), ...(typeof r.max === "number" ? { max: r.max } : {}),
  }));
  if (opts.brand !== false && ids.length) {
    const brand = await g.roQuery<{ id: string; text: string | null; name: string | null; specific: boolean }>(
      `MATCH (t:Entity) WHERE t.id IN $ids WITH t
       MATCH (r:BrandRule)-[a:APPLIES_TO]->(t) WHERE a.until IS NULL AND coalesce(r.status, 'active') = 'active'
       WITH r, max(CASE WHEN t.id = $biz THEN 0 ELSE 1 END) = 1 AS specific
       RETURN r.id AS id, r.text AS text, r.name AS name, specific
       ORDER BY specific DESC, id LIMIT 8`, { ids, biz: scope.businessId ?? "" });
    for (const r of brand) out.push({ id: r.id, kind: "brand", text: r.text ?? r.name ?? r.id, op: "instruction", confidence: 1, appliedCount: 0 });
  }
  return out;
}

export async function applyLearnedRules(g: Read, input: { title: string; body: string }, scope: { agentId?: string; channelId?: string; businessId?: string | null }): Promise<Applied> {
  return applyRules(input, await activeRules(g, scope));
}

// How a rule shaped a draft: a rule the code applies (replace, no emoji, no exclamation marks) rewrote its text, and says what
// it swapped; any other (a style note, a length, a brand rule) was handed to whoever wrote it as an instruction.
export interface RuleUse { how: "rewrote" | "instructed"; find?: string; replace?: string }
export function ruleUse(r: { op?: string | null; find?: string | null; replace?: string | null }): RuleUse {
  if (!r.op || !DETERMINISTIC_OPS.has(r.op as RuleOp)) return { how: "instructed" };
  return { how: "rewrote", ...(r.find ? { find: r.find } : {}), ...(typeof r.replace === "string" ? { replace: r.replace } : {}) };
}
const useProps = (u: RuleUse): Record<string, string> => ({ how: u.how, ...(u.find ? { find: u.find } : {}), ...(u.replace !== undefined ? { replace: u.replace } : {}) });

// A card (its Recommendation and Approval) is GUIDED_BY the rules that shaped its draft, each with how. Rules that stopped
// applying (a re-run of a card still waiting for the owner) are closed, kept as history. Best effort: a card without the edges is
// still a card, so nothing here throws. `src` is the id of the Recommendation that applied them.
export async function guideCards(g: GraphHandle, cardIds: string[], rules: ReadonlyArray<Pick<ActiveRule, "id" | "op" | "find" | "replace">>, now: number, src: string): Promise<void> {
  const asOf = isoDate(now);
  const want = new Map(rules.map((r) => [r.id, r] as const));
  for (const from of cardIds) {
    try {
      const had = await g.roQuery<{ id: string }>("MATCH (c:Entity {id:$id})-[e:GUIDED_BY]->(r:Entity) WHERE e.until IS NULL RETURN r.id AS id ORDER BY id", { id: from });
      for (const r of want.values()) await upsertEdge(g, { from, type: "GUIDED_BY", to: r.id, props: useProps(ruleUse(r)), src, asOf, since: now }, now);
      for (const h of had) if (!want.has(h.id)) await closeEdge(g, from, "GUIDED_BY", h.id, now, "no longer applied");
    } catch {
      // the card keeps its payload.rulesApplied either way
    }
  }
}

// USES_RULE from the draft to every rule that shaped it, and appliedCount + 1 on each learned one.
export async function markRulesApplied(g: GraphHandle, contentId: string, ruleIds: string[], now: number): Promise<string[]> {
  const ids = [...(await existingIds(g, ruleIds))];
  if (!ids.length) return [];
  const rows = await g.roQuery<{ id: string; name: string; kind: string | null; n: number | null; labels: string[]; op: string | null; find: string | null; replace: string | null }>(
    `UNWIND $ids AS id MATCH (r:Entity {id:id})
     RETURN r.id AS id, r.name AS name, r.kind AS kind, r.appliedCount AS n, labels(r) AS labels, r.op AS op, r.find AS find, r.replace AS replace`, { ids });
  for (const r of rows) {
    const { created } = await upsertEdge(g, { from: contentId, type: "USES_RULE", to: r.id, props: { applied: true, ...useProps(ruleUse(r)) } }, now);
    if (created && r.kind === "learned" && r.labels.includes("Rule")) {
      await upsertNode(g, { type: "Rule", id: r.id, name: r.name, props: { appliedCount: (r.n ?? 0) + 1, lastAppliedAt: now } }, now);
    }
  }
  return rows.map((r) => r.id);
}

// ---------- learning from an edit ----------

export interface LearnInput {
  approvalId: string;
  original: { title: string; body: string };
  edited: { title: string; body: string };
  agentId?: string;        // roster id of the agent whose draft was edited
  channelId?: string;
  now: number;
  extraRules?: RuleSpec[]; // lessons stated in words (the owner's change note), written the same way as lessons found in an edit
}
export interface LearnDeps { llm?: LlmRunner; model?: string; onLearned?: (e: LearnedEvent) => void }
export interface LearnedRule { id: string; text: string; op: RuleOp; confidence: number; created: boolean; retired: string[] }

const LLM_SCHEMA = {
  type: "object", additionalProperties: false, required: ["rules"],
  properties: { rules: { type: "array", maxItems: 2, items: { type: "string", maxLength: 160 } } },
};

async function summarise(llm: LlmRunner, model: string, input: LearnInput): Promise<RuleSpec[]> {
  const out = (await llm.structured({
    model,
    system: "You are a brand copy editor. From one draft and the owner's edit of it, state at most two short, reusable writing rules the owner applied (style, wording, tone, length). No rule about facts or numbers. Imperative, under 15 words each. Return none if the edit teaches nothing reusable.",
    prompt: `DRAFT:\n${clip(`${input.original.title}\n\n${input.original.body}`, 4000)}\n\nOWNER'S EDIT:\n${clip(`${input.edited.title}\n\n${input.edited.body}`, 4000)}`,
    schema: LLM_SCHEMA,
  })) as { rules?: unknown };
  const texts = Array.isArray(out?.rules) ? out.rules.filter((t): t is string => typeof t === "string" && t.trim().length > 3) : [];
  return texts.slice(0, 2).map((t) => ({ id: ruleId(t.slice(0, 60)), op: "instruction" as const, text: t.trim(), confidence: 0.5 }));
}

// The bit of the draft the lesson is about, before and after the owner's edit (what LEARNED_FROM keeps, so a judge can read
// "villa -> home" on the edge). A lesson in words (a change note, a model's summary) has no fragment.
export function editFragment(s: RuleSpec, original: string, edited: string): { before?: string; after?: string } {
  const frag = (v: string): string => clip(v.replace(/\s+/g, " ").trim(), 120);
  switch (s.op) {
    case "replace": return s.find && s.replace !== undefined ? { before: frag(s.find), after: frag(s.replace) } : {};
    case "remove_emoji": return { before: frag([...new Set(original.match(EMOJI_ALL) ?? [])].join(" ")), after: "" };
    case "no_exclaim": {
      const sentence = original.split(/(?<=[.!?])\s+/).find((x) => x.includes("!"));
      return sentence ? { before: frag(sentence), after: frag(applyRule(sentence, { op: "no_exclaim" })) } : {};
    }
    case "avoid_words": return s.words?.length ? { before: frag(s.words.join(", ")), after: "" } : {};
    case "max_words": return { before: `${words(original).length} words`, after: `${words(edited).length} words` };
    default: return {};
  }
}

// Writes the lessons in one edit and returns them. Never throws on the optional model: a failed summary learns nothing.
export async function learnFromEdit(g: GraphHandle, input: LearnInput, deps: LearnDeps = {}): Promise<LearnedRule[]> {
  const orig = `${input.original.title}\n\n${input.original.body}`;
  const edit = `${input.edited.title}\n\n${input.edited.body}`;
  const { rules: specs, complex } = extractRules(orig, edit);
  if (complex && deps.llm) {
    try {
      specs.push(...(await summarise(deps.llm, deps.model ?? "haiku", input)));
    } catch {
      // optional polish: a deterministic learning loop does not depend on it
    }
  }
  specs.push(...(input.extraRules ?? []));
  if (!specs.length) return [];
  const now = input.now;
  const editor = await ensureAgentNode(g, COPY_EDITOR, now);
  const drafter = input.agentId ? await ensureAgentNode(g, input.agentId, now) : undefined;
  const channel = input.channelId && (await existingIds(g, [input.channelId])).has(input.channelId) ? input.channelId : undefined;
  const date = isoDate(now);
  const out: LearnedRule[] = [];
  for (const s of specs) {
    const skills = skillsForLearnedRule({ agentId: input.agentId, draft: orig, op: s.op });
    const [old] = await g.roQuery<{ confidence: number | null; status: string | null; n: number | null; applied: number | null }>(
      "MATCH (r:Entity:Rule {id:$id}) RETURN r.confidence AS confidence, r.status AS status, r.learnedCount AS n, r.appliedCount AS applied", { id: s.id });
    const confidence = old ? Math.min(0.95, Math.round(((old.confidence ?? s.confidence) + 0.1) * 100) / 100) : s.confidence;
    // Where it came from: the approval whose edit taught it, and the day.
    const from = { src: input.approvalId, asOf: date, since: now } as const;
    await upsertNode(g, {
      type: "Rule", id: s.id, name: s.text,
      summary: `Learned from the owner's edit on ${date} (${input.approvalId}).`,
      props: {
        kind: "learned", text: s.text, op: s.op, confidence, status: "active", appliedCount: old?.applied ?? 0,
        learnedCount: (old?.n ?? 0) + 1, learnedAt: now,
        // the skills it belongs to, so use_skill shows it with the right skill (Miss Influencer's post craft, Wordsmith's voice check)
        ...(skills.length ? { skills } : {}),
        ...(s.find ? { find: s.find } : {}), ...(s.replace !== undefined ? { replace: s.replace } : {}),
        ...(s.words ? { words: s.words } : {}), ...(s.max !== undefined ? { max: s.max } : {}),
      },
      src: input.approvalId, asOf: date,
    }, now);
    const fragment = editFragment(s, orig, edit);
    await upsertEdge(g, { from: s.id, type: "LEARNED_FROM", to: input.approvalId, conf: confidence, props: { op: s.op, ...fragment }, ...from }, now);
    await upsertEdge(g, { from: editor, type: "PRODUCED", to: s.id, ...from }, now);
    if (drafter) await upsertEdge(g, { from: s.id, type: "APPLIES_TO", to: drafter, ...from }, now);
    if (channel) await upsertEdge(g, { from: s.id, type: "APPLIES_TO", to: channel, ...from }, now);
    // The owner reversed an earlier lesson ("home" -> "villa" after "villa" -> "home"): the old rule retires.
    const retired: string[] = [];
    if (s.op === "replace") {
      const rev = await g.roQuery<{ id: string; name: string }>(
        `MATCH (r:Rule) WHERE r.kind = 'learned' AND r.op = 'replace' AND r.status = 'active' AND toLower(r.find) = toLower($find)
           AND toLower(r.replace) = toLower($replace) AND r.id <> $id RETURN r.id AS id, r.name AS name`,
        { find: s.replace, replace: s.find, id: s.id });
      for (const r of rev) {
        await upsertNode(g, { type: "Rule", id: r.id, name: r.name, props: { status: "retired", retiredAt: now, retiredBy: s.id } }, now);
        await upsertEdge(g, { from: s.id, type: "CONTRADICTS", to: r.id, ...from }, now);
        retired.push(r.id);
      }
    }
    out.push({ id: s.id, text: s.text, op: s.op, confidence, created: !old, retired });
    deps.onLearned?.({ type: "learned", ruleId: s.id, text: s.text, fromApprovalId: input.approvalId });
  }
  return out;
}

// A change note the owner wrote ("shorter, and say Raipur") as a rule to follow, the same kind a word-level edit teaches.
export function changeNoteRule(note: string): RuleSpec {
  const t = clip(note.replace(/\s+/g, " ").trim(), 140).replace(/[.!\s]+$/, "");
  return { id: ruleId(`change note ${t.toLowerCase().slice(0, 60)}`), op: "instruction", text: `The owner asked for: ${t}.`, confidence: 0.5 };
}

// ---------- the KPI ----------

export interface LearningMetrics { firstPassRate: number | null; decided30d: number; firstPass30d: number; learnedRules: number; deliverablesApproved: number }

// first-pass rate: approvals decided in the last 30 days that were approved with no edit, over all decided (an edited
// or rejected draft is not first-pass). Written on the Business as Observations dated today.
export async function learningMetrics(g: Read, now: number): Promise<LearningMetrics> {
  const from = now - 30 * 86_400_000;
  const [d] = await g.roQuery<{ n: number; fp: number }>(
    "MATCH (a:Approval) WHERE a.decidedAt >= $from AND a.decidedAt <= $now AND a.firstPass IS NOT NULL RETURN count(a) AS n, sum(CASE WHEN a.firstPass = true THEN 1 ELSE 0 END) AS fp",
    { from, now });
  const [r] = await g.roQuery<{ n: number }>("MATCH (r:Rule) WHERE r.kind = 'learned' AND r.status = 'active' RETURN count(r) AS n");
  const [a] = await g.roQuery<{ n: number }>("MATCH (a:Approval) WHERE a.decision = 'approve' RETURN count(a) AS n");
  const n = d?.n ?? 0, fp = d?.fp ?? 0;
  return { firstPassRate: n ? Math.round((fp / n) * 1000) / 1000 : null, decided30d: n, firstPass30d: fp, learnedRules: r?.n ?? 0, deliverablesApproved: a?.n ?? 0 };
}

export async function recordLearningMetrics(g: GraphHandle, businessId: string | null, now: number): Promise<LearningMetrics> {
  const m = await learningMetrics(g, now);
  if (!businessId) return m;
  const day = isoDate(now);
  const base = { subject: businessId, asOf: day, windowEnd: day, src: LEARNING_SRC };
  if (m.firstPassRate !== null) {
    await addObservation(g, { ...base, metric: "allevia.first_pass_rate", value: m.firstPassRate, unit: "ratio", windowStart: addDays(day, -29) }, now);
  }
  await addObservation(g, { ...base, metric: "allevia.learned_rules", value: m.learnedRules, unit: "count" }, now);
  await addObservation(g, { ...base, metric: "allevia.deliverables_approved", value: m.deliverablesApproved, unit: "count" }, now);
  return m;
}
