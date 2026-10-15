// "Does AI know you?": a few natural questions a customer would ask an AI assistant about the business's kind of work
// and city ("Who is the best interior architect in Raipur?"), asked of Claude on the Claude Code subscription ($0, no
// API key), and whether and how the business is named in the answers. Repeated over time it shows a trend.
//
// What it is and is not, said to the owner every time: it measures what ONE model (Claude, from what it learned, with no
// web search) answers today, for these questions. It is not a Google ranking, not ChatGPT or Gemini, and the same
// question can be answered differently tomorrow. The questions are fixed per business, so runs can be compared.
//
// Mention matching follows open-seo (every-app/open-seo, MIT, aiVisibilityMatching.ts; see NOTICE.md): URLs and
// e-mails blanked first, NFD-normalised, case-insensitive, on Unicode word boundaries, whitespace flexible; the names
// tried are the business name, its domain and the domain's stem. A question the model failed to answer is not counted
// as "not mentioned".
import type { EdgeInput, NodeInput, ObservationInput } from "../graph/upsert.js";
import type { LlmRunner } from "../ingest/llm.js";
import type { GraphWrite } from "../ingest/types.js";
import { entityId } from "../util/ids.js";

export interface AiBusiness {
  name: string;
  domain?: string;           // "avsatelier.in"
  category: string;          // what a customer would call it: "interior architect", "AI hiring platform"
  city?: string;             // where it works; absent for an online business
  audience?: string;         // optional: "for homes", "for small businesses"
}

export interface AiAnswer {
  question: string;
  answered: boolean;
  answer: string;            // clipped
  named: string[];           // the businesses the answer named, in the model's own list
  mentioned: boolean;        // this business is named in the answer
  cited: boolean;            // its website is given
  position: number | null;   // 1 = named first among the businesses named
  others: string[];          // the other businesses named (competitors, as the model sees them)
  platforms?: string[];      // directories, marketplaces and apps the answer sent people to instead (Justdial, Houzz)
  error?: string;
}

export interface AiVisibilityRun {
  asOf: string;
  model: string;
  business: AiBusiness;
  answers: AiAnswer[];
  asked: number;
  answered: number;
  mentioned: number;
  mentionPct: number | null; // of the answered questions
}

export const HONEST_NOTE =
  "This is what one AI model (Claude, answering from what it learned, without searching the web) says today for these questions. It is not your Google ranking, and ChatGPT or Gemini may answer differently.";

// ---------- questions ----------

const plural = (s: string): string => {
  const t = s.trim();
  if (/s$/i.test(t)) return t;
  if (/(ch|sh|x)$/i.test(t)) return `${t}es`;
  if (/[^aeiou]y$/i.test(t)) return `${t.slice(0, -1)}ies`;
  return `${t}s`;
};
const article = (s: string) => (/^[aeiou]/i.test(s.trim()) ? "an" : "a");

/** Fixed, natural questions for this business: the same every run, so runs compare. */
export function customerQuestions(b: AiBusiness, n = 4): string[] {
  const c = b.category.trim();
  const aud = b.audience?.trim() ? ` ${b.audience.trim()}` : "";
  const qs = b.city?.trim()
    ? [
      `Who is the best ${c} in ${b.city}?`,
      `Can you recommend ${article(c)} ${c} in ${b.city}${aud}?`,
      `I'm looking for ${article(c)} ${c} near ${b.city}. Which ones should I contact?`,
      `Which ${plural(c)} in ${b.city} have the best reviews?`,
      `What are the top ${plural(c)} in ${b.city} and what are they known for?`,
    ]
    : [
      `What is the best ${c}${aud}?`,
      `Can you recommend ${article(c)} ${c}${aud}?`,
      `What are the top ${plural(c)} right now, and how do they compare?`,
      `Which ${c} would you suggest for a small business?`,
      `What are some good alternatives to the popular ${plural(c)}?`,
    ];
  return qs.slice(0, Math.max(1, Math.min(n, qs.length)));
}

// ---------- matching (after open-seo, MIT) ----------

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function brandNames(b: Pick<AiBusiness, "name" | "domain">): string[] {
  const out = new Set<string>();
  if (b.name.trim().length >= 2) out.add(b.name.trim());
  const d = b.domain?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (d) {
    out.add(d);
    const stem = d.split(".")[0] ?? "";
    // a stem that is a real word-length name ("avsatelier", "aamdani") is how people write the brand; "ai" is not
    if (stem.length >= 4) out.add(stem);
  }
  return [...out];
}

/** Character offsets where any of the names appear as whole words; overlapping spans collapsed. */
export function mentionSpans(text: string, names: string[]): Array<{ start: number; end: number }> {
  const blanked = text.replace(/https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => " ".repeat(m.length));
  const hay = norm(blanked);
  const spans: Array<{ start: number; end: number }> = [];
  for (const name of names) {
    const n = norm(name).trim();
    if (n.length < 2) continue;
    const pattern = n.split(/\s+/).map(esc).join("\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${pattern}(?![\\p{L}\\p{M}\\p{N}_])`, "gu");
    for (let m = re.exec(hay); m; m = re.exec(hay)) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: typeof spans = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export function ownedDomain(hostname: string, owned: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const domain = owned.toLowerCase().replace(/^www\./, "");
  return !!domain && (host === domain || host.endsWith(`.${domain}`));
}

/** Whether and where the business is named in one answer. */
export function matchAnswer(question: string, answer: string, named: string[], b: AiBusiness): AiAnswer {
  const names = brandNames(b);
  const spans = mentionSpans(answer, names);
  const urls = [...answer.matchAll(/https?:\/\/([^/\s)]+)/g)].map((m) => m[1]!);
  const cited = !!b.domain && (urls.some((h) => ownedDomain(h, b.domain!)) || mentionSpans(answer, [b.domain]).length > 0);
  const mine = (x: string) => mentionSpans(x, names).length > 0;
  const others = [...new Set(named.map((x) => x.trim()).filter((x) => x && !mine(x)))].slice(0, 12);
  let position: number | null = null;
  if (spans.length) {
    const firsts = others.map((o) => mentionSpans(answer, [o])[0]?.start).filter((x): x is number => x !== undefined);
    position = 1 + firsts.filter((x) => x < spans[0]!.start).length;
  }
  return { question, answered: true, answer: answer.slice(0, 4000), named, mentioned: spans.length > 0, cited, position, others };
}

// ---------- asking ----------

const SYSTEM = `You are a helpful assistant answering a member of the public. Answer their question the way you normally would, from what you know, in a few short paragraphs or a short list. If you are not sure which businesses are good, say so; do not invent businesses. After answering, list separately (exact names as written): the businesses that do this work that you named, and the directories, marketplaces, apps or organisations you pointed the person to.`;

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "your answer to the question, as you would give it" },
    named: { type: "array", items: { type: "string" }, description: "the businesses or firms that do this work named in the answer" },
    platforms: { type: "array", items: { type: "string" }, description: "directories, marketplaces, apps, associations or websites the answer points to (not firms doing the work)" },
  },
  required: ["answer", "named", "platforms"],
};

export interface AskOpts { model?: string; questions?: string[]; log?: (line: string) => void; now?: () => number }

/** Asks each question once and records whether and how the business is named. */
export async function checkAiVisibility(b: AiBusiness, runner: LlmRunner, o: AskOpts = {}): Promise<AiVisibilityRun> {
  const model = o.model ?? "sonnet";
  const questions = o.questions?.length ? o.questions : customerQuestions(b);
  const answers: AiAnswer[] = [];
  for (const q of questions) {
    try {
      const raw = (await runner.structured({ system: SYSTEM, prompt: q, schema: SCHEMA, model })) as { answer?: unknown; named?: unknown; platforms?: unknown } | null;
      const answer = typeof raw?.answer === "string" ? raw.answer : "";
      const named = Array.isArray(raw?.named) ? raw!.named.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 120)) : [];
      if (!answer.trim()) throw new Error("empty answer");
      const platforms = Array.isArray(raw?.platforms) ? raw!.platforms.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 120)).slice(0, 12) : [];
      const a = { ...matchAnswer(q, answer, named, b), ...(platforms.length ? { platforms } : {}) };
      o.log?.(`[ai-visibility] "${q}": ${a.mentioned ? `named${a.position ? ` (#${a.position})` : ""}` : "not named"}; others: ${a.others.slice(0, 5).join(", ") || "none"}`);
      answers.push(a);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      o.log?.(`[ai-visibility] "${q}" failed: ${error}`);
      answers.push({ question: q, answered: false, answer: "", named: [], mentioned: false, cited: false, position: null, others: [], error: error.slice(0, 200) });
    }
  }
  const answered = answers.filter((a) => a.answered).length;
  const mentioned = answers.filter((a) => a.mentioned).length;
  return {
    asOf: new Date((o.now ?? Date.now)()).toISOString().slice(0, 19) + "Z", model, business: b, answers, asked: answers.length, answered, mentioned,
    mentionPct: answered ? Math.round((100 * mentioned) / answered) : null,
  };
}

// ---------- the graph and the owner ----------

export const aiVisibilityDocId = (name: string, asOf: string) => entityId("Document", `ai visibility ${name} ${asOf}`);

/** The run as a report Document and readings on the Business (mention %, questions answered), sourced to the report. */
export function aiVisibilityWrite(run: AiVisibilityRun, businessId: string): GraphWrite {
  const doc = aiVisibilityDocId(run.business.name, run.asOf);
  const others = topOthers(run, 8);
  const nodes: NodeInput[] = [{
    type: "Document", id: doc, name: `Does AI know ${run.business.name}? ${run.asOf.slice(0, 10)}`, asOf: run.asOf,
    summary: `${run.mentioned} of ${run.answered} answers from Claude named ${run.business.name}.${others.length ? ` Named instead: ${others.map((o) => o.name).join(", ")}.` : ""}`.slice(0, 900),
    props: {
      kind: "report", checkup: "ai-visibility", title: `AI visibility check, ${run.asOf.slice(0, 10)}`, model: run.model,
      questions: run.answers.map((a) => a.question), mentioned: run.answers.map((a) => (a.answered ? (a.mentioned ? "yes" : "no") : "failed")),
      others: others.map((o) => `${o.name}|${o.count}`), answers: JSON.stringify(run.answers.map((a) => ({ ...a, answer: a.answer.slice(0, 1500) }))).slice(0, 40_000),
      category: run.business.category, ...(run.business.city ? { city: run.business.city } : {}), note: HONEST_NOTE,
    },
  }];
  const edges: EdgeInput[] = [];
  const observations: ObservationInput[] = [];
  if (run.mentionPct !== null) {
    observations.push({ subject: businessId, metric: "ai_mention_pct", value: run.mentionPct, unit: "%", asOf: run.asOf, src: doc,
      evidence: `${run.mentioned} of ${run.answered} answers from ${run.model} named the business` });
  }
  observations.push({ subject: businessId, metric: "ai_questions_answered", value: run.answered, asOf: run.asOf, src: doc, evidence: `${run.answered} of ${run.asked} questions answered` });
  return { nodes, edges, observations };
}

export const topPlatforms = (run: AiVisibilityRun, n = 5) => tally(run.answers.map((a) => a.platforms ?? []), n);
export const topOthers = (run: AiVisibilityRun, n = 5) => tally(run.answers.map((a) => a.others), n);

function tally(lists: string[][], n: number): Array<{ name: string; count: number }> {
  const counts = new Map<string, { name: string; count: number }>();
  for (const list of lists) for (const o of new Set(list.map((x) => x.trim()).filter(Boolean))) {
    const k = norm(o);
    const c = counts.get(k) ?? { name: o, count: 0 };
    c.count++;
    counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n);
}

/** The owner's answer: one line verdict, what was asked, who was named instead, the honest note; previous run if any. */
export function aiVisibilityReport(run: AiVisibilityRun, previous?: { mentionPct: number | null; asOf: string }): string {
  const b = run.business.name;
  const lines: string[] = [];
  if (!run.answered) lines.push("We could not get answers from the AI this time; nothing was measured.");
  else if (!run.mentioned) lines.push(`AI does not know ${b} yet: Claude named you in 0 of ${run.answered} answers.`);
  else lines.push(`Claude named ${b} in ${run.mentioned} of ${run.answered} answers.`);
  if (previous && previous.mentionPct !== null && run.mentionPct !== null) {
    lines.push(previous.mentionPct === run.mentionPct
      ? `Same as last time (${previous.asOf.slice(0, 10)}).`
      : `Last time (${previous.asOf.slice(0, 10)}) it was ${previous.mentionPct}% of answers; now ${run.mentionPct}%.`);
  }
  lines.push("", "What we asked:");
  for (const a of run.answers) {
    lines.push(`- "${a.question}": ${!a.answered ? "no answer (not counted)" : a.mentioned ? `named you${a.position ? `, #${a.position} in the answer` : ""}${a.cited ? ", with your website" : ""}` : `not named${a.others.length ? `; named ${a.others.slice(0, 3).join(", ")}` : ""}`}`);
  }
  const others = topOthers(run);
  if (others.length) lines.push("", `Firms named instead: ${others.map((o) => `${o.name} (${o.count})`).join(", ")}.`);
  const places = topPlatforms(run);
  if (places.length) lines.push(`${others.length ? "It also sent people to" : "Instead of naming firms, it sent people to"}: ${places.map((o) => o.name).join(", ")}. Being listed and reviewed there is the most direct way into these answers.`);
  lines.push("", HONEST_NOTE);
  if (!run.mentioned && run.answered) {
    lines.push("What helps: be named on the sites AI learns from (Google reviews, Justdial or local directories, press, lists of the best firms in your city), keep your business name and city on every page, and let AI search crawlers read your site.");
  }
  return lines.join("\n");
}

// ---------- stored runs ----------

type Read = { roQuery<T>(q: string, p?: Record<string, unknown>): Promise<T[]> };

export interface StoredAiRun { docId: string; asOf: string; mentionPct: number | null; questions: string[]; mentioned: string[]; others: string[] }

/** The latest stored AI visibility runs, newest first. */
export async function storedAiRuns(g: Read, limit = 2): Promise<StoredAiRun[]> {
  const docs = await g.roQuery<{ id: string; asOf: string; questions: string[] | null; mentioned: string[] | null; others: string[] | null }>(
    `MATCH (d:Document) WHERE d.checkup = 'ai-visibility'
     RETURN d.id AS id, d.asOf AS asOf, d.questions AS questions, d.mentioned AS mentioned, d.others AS others
     ORDER BY asOf DESC, id DESC LIMIT $limit`, { limit });
  if (!docs.length) return [];
  const obs = await g.roQuery<{ src: string; v: number }>(
    `MATCH (o:Observation)-[m:MEASURES]->(b:Business) WHERE m.until IS NULL AND o.metric = 'ai_mention_pct' AND o.src IN $docs
     RETURN o.src AS src, o.value AS v LIMIT 100`, { docs: docs.map((d) => d.id) });
  return docs.map((d) => ({
    docId: d.id, asOf: d.asOf, mentionPct: obs.find((o) => o.src === d.id)?.v ?? null,
    questions: d.questions ?? [], mentioned: d.mentioned ?? [], others: d.others ?? [],
  }));
}
