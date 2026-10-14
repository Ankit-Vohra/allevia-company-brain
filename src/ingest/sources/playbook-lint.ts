// Deterministic checkers built on the vendored playbook data (no LLM):
// - classifyHook: which Instagram Reel hook formula does a caption open with?
// - voiceLint: which AI-writing tells (vocabulary, stock phrases, chatbot leftovers…) does a text contain?
// Both read the validated vendored JSON; neither executes anything from the upstream repos.
import { loadHooks, loadPatterns, ruleId, type RegexSpec } from "./playbook-data.js";

// ---------- hook classification ----------

// The hook is what comes first, so only the opening of the text is considered. This also keeps the third-party
// regexes away from long inputs.
const HOOK_WINDOW = 280;

interface CompiledHook { ruleId: string; name: string; re: RegExp }
let compiledHooks: CompiledHook[] | undefined;

function hookMatchers(): CompiledHook[] {
  if (compiledHooks) return compiledHooks;
  const { hooks, classify_order } = loadHooks().data;
  const byId = new Map(hooks.map((h) => [h.id, h]));
  // classify_order lists hook ids most specific first; the vendored file says to walk them in that order, case-insensitive.
  compiledHooks = classify_order.flatMap((id) => {
    const h = byId.get(id);
    return h ? [{ ruleId: ruleId("hook", h.name), name: h.name, re: new RegExp(h.match, "i") }] : [];
  });
  return compiledHooks;
}

export function classifyHook(text: string): { ruleId: string; name: string } | null {
  const head = text.trim().slice(0, HOOK_WINDOW);
  if (!head) return null;
  for (const h of hookMatchers()) if (h.re.test(head)) return { ruleId: h.ruleId, name: h.name };
  return null;
}

// ---------- voice lint ----------

export interface VoiceFinding { category: string; match: string; suggestion?: string }

// Third-party regexes over unbounded input is a ReDoS risk; captions and posts are far below this.
const MAX_LINT_CHARS = 20_000;

const compile = (r: RegexSpec): RegExp => new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`);
const tokens = (s: string): string[] => s.toLowerCase().match(/[\w'-]+/g) ?? [];

interface LintTables {
  tier1Words: Map<string, string>;
  tier1Phrases: Array<{ re: RegExp; category: string; suggestion: string }>;
  tier2Words: Map<string, string>;
  tier2Conditional: Array<{ word: string; re: RegExp; suggestion: string }>;
  categories: Array<{ category: string; res: RegExp[] }>;
}
let tables: LintTables | undefined;

function lintTables(): LintTables {
  if (tables) return tables;
  const { tiers, categories } = loadPatterns().data;
  tables = {
    tier1Words: new Map(Object.entries(tiers.tier1.words)),
    // A phrase with a `guard` needs the detector's context logic (the verb/noun test for "features"); without it the
    // pattern would flag ordinary nouns, so guarded phrases are left out (same reasoning as `gated` below).
    tier1Phrases: tiers.tier1.phrases.filter((p) => !p.guard)
      .map((p) => ({ re: compile(p.pattern), category: p.clarity ? "tier1-clarity" : "tier1", suggestion: p.replace })),
    tier2Words: new Map(Object.entries(tiers.tier2.words)),
    tier2Conditional: tiers.tier2.conditional.map((c) => ({ word: c.word, re: new RegExp(c.pattern.source, c.pattern.flags.replace("g", "")), suggestion: c.suggestion })),
    // `gated` patterns are ones the upstream engine reports only after extra logic (a contrast needs a nearby second
    // frame, a title-case header is filtered, confidence words must stack up) that is not vendored. On their own they
    // flag ordinary English ("It isn't raining, it's snowing."), so they are left out.
    categories: Object.entries(categories)
      .map(([category, c]) => ({ category, res: c.patterns.filter((p) => !p.gated).map(compile) }))
      .filter((c) => c.res.length > 0),
  };
  return tables;
}

// Concrete, phrase-level findings. The statistical signals of the original detector (tier-3 density, rhythm
// uniformity, punctuation distribution) are not reproduced: they say "this reads machine-made", not "rewrite this".
export function voiceLint(text: string): VoiceFinding[] {
  const t = text.slice(0, MAX_LINT_CHARS);
  if (!t.trim()) return [];
  const tb = lintTables();
  const out: VoiceFinding[] = [];
  const seen = new Set<string>();
  const add = (category: string, match: string, suggestion?: string) => {
    const key = `${category}|${match.toLowerCase()}`;
    if (!match || seen.has(key)) return;
    seen.add(key);
    out.push(suggestion === undefined ? { category, match } : { category, match, suggestion });
  };

  for (const tok of tokens(t)) {
    const s = tb.tier1Words.get(tok);
    if (s !== undefined) add("tier1", tok, s);
  }
  for (const p of tb.tier1Phrases) for (const m of t.matchAll(p.re)) add(p.category, m[0], p.suggestion);

  // Tier 2 words only count as a cluster: two or more distinct ones in the same paragraph.
  for (const para of t.split(/\n\s*\n/)) {
    const found = new Map<string, string>();
    for (const tok of tokens(para)) {
      const s = tb.tier2Words.get(tok);
      if (s !== undefined) found.set(tok, s);
    }
    for (const c of tb.tier2Conditional) if (!found.has(c.word) && c.re.test(para)) found.set(c.word, c.suggestion);
    if (found.size >= 2) for (const [w, s] of found) add("tier2", w, s);
  }

  for (const c of tb.categories) for (const re of c.res) for (const m of t.matchAll(re)) add(c.category, m[0]);
  return out;
}
