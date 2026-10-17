// "Tell your team" (product design §2.4, §8, §9 item 7). The owner types a plain-language instruction ("No emojis on
// LinkedIn; switch Techie off till the new site launches"); it becomes a typed patch list and a diff preview, and the
// owner confirms it before anything is written.
// - parseDirective: deterministic rules first, for the common shapes: switching a desk on or off by name or title (with
//   a "till …" note), light/full mode, autonomy 0-3, a channel-scoped instruction ("no emojis on LinkedIn"), an
//   always-instruction ("always mention free consultation"), a daily spend cap ("never spend above $50/day") and a
//   brand voice rule ("never say cheap"). A clause that names a desk first ("Miss Influencer, …") is for that desk only.
// - What the rules leave goes to haiku through the Agent SDK on the subscription (AgentSdkRunner, structured output);
//   every patch it returns is validated against the roster and the patch kinds. No runner (llm: null) or a failed call
//   leaves those parts in `unparsed`, so toggles keep working without the model.
// - previewDirective writes the preview as Document{kind:'directive', status:'preview'} AUTHORED by the owner (so the
//   API can apply it in a later request) and returns the diff; applyDirective writes the patches, each sourced to that
//   Document: Agent enabled/mode/autonomy (TRACKED: the old state becomes a Version), Memory{kind:'instruction'} ABOUT
//   the agents (and the channel when it exists) STATED by the owner, BrandRule APPLIES_TO the Business, and for a skill:
//   Memory{kind:'skill_rule'} (a rule for one skill: "our posts always end with a question") or Memory{kind:'skill'} (the
//   business's own skill) ABOUT the agents (src/agent/skills/business.ts). Applying twice writes nothing more.
import { randomBytes } from "node:crypto";
import { AGENTS, agentById, plainWho } from "../../shared/roster.js";
import { LEGACY_NAMES } from "../../shared/legacy-names.js";
import type { AgentMode, AgentSettings, DirectiveDiffLine, DirectivePatch, DirectivePreview } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode, writeBatch, type EdgeInput, type NodeInput, type Prim } from "../graph/upsert.js";
import type { LlmRunner } from "../ingest/llm.js";
import { cleanText, Removed } from "../ingest/clean.js";
import { findBusiness } from "../capabilities/ladder.js";
import { agentNodeId, ensureRoster } from "../agent/memory.js";
import { codeCatalog } from "../agent/skills/catalog.js";
import { loadBusinessSkills, skillRuleWrite, skillWrite } from "../agent/skills/business.js";
import type { SkillRule } from "../agent/skills/catalog.js";
import { lintBusinessSkill, SKILL_ID } from "../agent/skills/format.js";
import { targetsIn } from "../agent/skills/targets.js";
import { entityId, sha256, slugify } from "../util/ids.js";
import { isoDate, istDate } from "../util/time.js";
import { AGENT_MODES, CHIEF, agentChangeRefusal, listAgentsWithSettings, setAgentSettings } from "./team.js";

export { listAgentsWithSettings, loadTeamSettings, setAgentSettings } from "./team.js";

export const DIRECTIVE_MODEL = "haiku";
const MAX_TEXT = 2_000;
const MAX_PATCH_TEXT = 300;
const MAX_SKILL_TEXT = 1_500;
const CONTENT_DESKS = ["content-strategist", "copy-editor"];               // who writes and checks posts
const PROMO_DESKS = ["content-strategist", "copy-editor", "growth-marketer"]; // who writes anything that promotes
const SPEND_DESKS = ["growth-marketer"];

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// "no emojis on linkedin" -> "No emojis on linkedin."
export function sentence(s: string): string {
  const t = s.trim().replace(/[\s.!;,]+$/u, "");
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}.` : "";
}

// ---------- who and where ----------

const ALIASES: Record<string, string[]> = {
  "chief-of-staff": ["chief of staff", "chief"],
  "coe-lead": ["coe lead", "coe", "numbers desk"],
  "data-analyst": ["data analyst", "analyst"],
  "growth-marketer": ["growth marketer", "marketer"],
  "content-strategist": ["content strategist", "content writer", "strategist"],
  "copy-editor": ["copy editor", "brand editor", "editor"],
  "fact-checker": ["fact checker"],
  "tech-lead": ["tech lead"],
  "oncall-engineer": ["on-call engineer", "on call engineer", "oncall engineer", "on-call", "on call"],
  "qa-release": ["release manager", "qa manager", "qa", "release desk"],
  "ops-manager": ["ops manager", "operations manager"],
  "sales-lead": ["sales lead", "sales"],
  "librarian": ["librarian"],
};
const words = (alts: string[], flags: string) => new RegExp(`(?<![\\p{L}\\p{N}-])(?:${alts.map(escapeRe).join("|")})(?![\\p{L}\\p{N}-])`, flags);
// Role names match in any case. A name the desk had before the rename (shared/legacy-names.ts) still counts, but only
// capitalised, since some are everyday words in lower case ("the dev server" is no one).
const oldNamesOf = (id: string): string[] => Object.entries(LEGACY_NAMES).filter(([, to]) => to === id).map(([old]) => old);
const AGENT_RES = AGENTS.map((a) => {
  const any = [a.id, a.id.replace(/-/g, " "), a.title, ...(ALIASES[a.id] ?? []), a.name];
  const cased = oldNamesOf(a.id);
  return { id: a.id, any: words(any, "iu"), cased: words(cased, "u"), strip: words(any, "giu"), stripCased: words(cased, "gu") };
});

// The desks a text names, in roster order.
export function agentsIn(text: string): string[] {
  return AGENT_RES.filter((r) => r.any.test(text) || r.cased.test(text)).map((r) => r.id);
}

// The text names desks and nothing else ("Techie", "the tech lead", "Miss Influencer and Wordsmith").
function onlyAgents(text: string): boolean {
  if (!agentsIn(text).length) return false;
  let rest = text;
  for (const r of AGENT_RES) rest = rest.replace(r.strip, " ").replace(r.stripCased, " ");
  return !rest.replace(/\b(?:and|&|the|our|my|back|both|desk|desks)\b|['’]s\b|[,\s]/giu, "").trim();
}

const CHANNELS: Array<[RegExp, string, string]> = [
  [/^linked\s?in$/i, "linkedin", "LinkedIn"],
  [/^(?:instagram|insta|ig)$/i, "instagram", "Instagram"],
  [/^(?:facebook|fb)$/i, "facebook", "Facebook"],
  [/^(?:youtube|yt)$/i, "youtube", "YouTube"],
  [/^(?:x|twitter)$/i, "x", "X (Twitter)"],
  [/^tiktok$/i, "tiktok", "TikTok"],
  [/^pinterest$/i, "pinterest", "Pinterest"],
  [/^threads$/i, "threads", "Threads"],
  [/^whatsapp$/i, "whatsapp", "WhatsApp"],
  [/^(?:google business(?: profile)?|gbp|google maps|google)$/i, "google-business", "Google Business Profile"],
  [/^(?:(?:the|our) )?(?:website|site|web)$/i, "website", "Website"],
];
const CHANNEL_WORDS = String.raw`linked\s?in|instagram|insta|facebook|fb|youtube|twitter|tiktok|pinterest|threads|whatsapp|google business(?: profile)?|gbp|google maps|(?:the |our )?(?:website|site)`;
const SCOPE = new RegExp(String.raw`\b(?:on|in|for|across)\s+(?:our\s+|the\s+|my\s+)?(?<ch>${CHANNEL_WORDS})(?:\s+(?:posts?|captions?|page|profile|ads?))?\b`, "i");

// A channel name -> its id (channel:<platform>, as onboarding writes it) and display name.
export function channelRef(name: string): { id: string; name: string } | undefined {
  const s = name.trim().replace(/^(?:the|our|my)\s+/i, "").replace(/^channel:/i, "");
  if (!s) return undefined;
  for (const [re, key, label] of CHANNELS) if (re.test(s)) return { id: `channel:${key}`, name: label };
  const id = entityId("Channel", s);
  return /^channel:[\p{L}\p{N}-]{2,40}$/u.test(id) ? { id, name: s } : undefined;
}

// ---------- money ----------

const CURRENCIES: Array<[RegExp, string]> = [
  [/^(?:₹|rs\.?|inr|rupees?)$/i, "INR"], [/^(?:a\$|aud)$/i, "AUD"], [/^(?:\$|us\$|usd|dollars?)$/i, "USD"],
  [/^(?:£|gbp|pounds?)$/i, "GBP"], [/^(?:€|eur|euros?)$/i, "EUR"], [/^(?:aed|dhs?\.?|dirhams?)$/i, "AED"],
];
const CUR_BEFORE = String.raw`₹|rs\.?|inr|a\$|us\$|\$|usd|aud|£|gbp|€|eur|aed|dhs?\.?`;
const CUR_AFTER = String.raw`inr|usd|aud|gbp|eur|aed|rupees?|dollars?|pounds?|euros?|dirhams?`;
const AMOUNT = String.raw`(?<c1>${CUR_BEFORE})?\s*(?<amt>\d[\d,]*(?:\.\d+)?)\s*(?<scale>k|lakh)?\s*(?<c2>${CUR_AFTER})?`;
const PER_DAY = String.raw`(?:\/\s*|an?\s+|per\s+|each\s+|every\s+)day\b`;
const SPEND_CAP = [
  new RegExp(String.raw`\b(?:never|don'?t|do not|not|must not|mustn'?t)\s+(?:ever\s+)?spend\s+(?:more\s+than|above|over|beyond|past)\s+${AMOUNT}\s*${PER_DAY}`, "i"),
  new RegExp(String.raw`\b(?:max(?:imum)?|cap|limit)\s+(?:of\s+)?(?:the\s+)?(?:daily\s+)?(?:ad\s+)?spend(?:ing)?(?:\s+(?:at|of|to|is))?\s+${AMOUNT}\s*(?:${PER_DAY})?`, "i"),
];

function spendCap(clause: string): { amount: number; currency: string } | undefined {
  for (const re of SPEND_CAP) {
    const g = re.exec(clause)?.groups;
    if (!g?.amt) continue;
    const amount = Number(g.amt.replace(/,/g, "")) * (g.scale?.toLowerCase() === "k" ? 1e3 : g.scale ? 1e5 : 1);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cur = g.c1 ?? g.c2 ?? "";
    return { amount, currency: CURRENCIES.find(([r]) => r.test(cur.trim()))?.[1] ?? "" };
  }
  return undefined;
}

// ---------- the deterministic rules ----------

// Clauses: split on ; and new lines, at sentence ends, and before an "and"/comma that starts a new order.
const ORDER_VERB = String.raw`(?:please\s+)?(?:switch|turn|put|set|disable|enable|pause|resume|activate|deactivate|bring\s+back)\b`;
const SPLIT = new RegExp(String.raw`[;\n]+|(?<=[.!?])\s+|,?\s+(?:and|also|plus)\s+(?=(?:${ORDER_VERB}|no\b|never\b|always\b|don'?t\b|do not\b))|,\s*(?=${ORDER_VERB})`, "i");

export function splitClauses(text: string): string[] {
  const parts = text.split(SPLIT).map((s) => (s ?? "").trim().replace(/^(?:and|also|plus|then|&)\s+/i, "").replace(/[.!]+$/, "").trim()).filter(Boolean);
  // "Miss Influencer, no emojis" split by a sentence end ("Miss Influencer. No emojis") is rare; "Miss Influencer" alone before a clause is an address.
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (onlyAgents(parts[i]!) && i + 1 < parts.length && !onlyAgents(parts[i + 1]!)) { parts[i + 1] = `${parts[i]}, ${parts[i + 1]}`; continue; }
    out.push(parts[i]!);
  }
  return out;
}

// After "off": nothing, or when/why ("till the new site launches", "for now"); "take Growth Hacker off ads" is not a switch-off.
const WHEN = String.raw`(?<rest>\s*[,;:]?\s*(?:till|until|for|while|during|through|now|please|today|this|next)\b.*)?`;
const OFF = [
  new RegExp(String.raw`^(?:please\s+)?(?:switch|turn|shut|put|take)\s+(?<who>.+?)\s+off\b${WHEN}$`, "i"),
  new RegExp(String.raw`^(?:please\s+)?(?:switch|turn|shut|take)\s+off\s+(?<who>.+?)${WHEN}$`, "i"),
  new RegExp(String.raw`^(?:please\s+)?(?:disable|deactivate|pause|mute|bench|sideline)\s+(?<who>.+?)${WHEN}$`, "i"),
  new RegExp(String.raw`^(?<who>.+?)\s+(?:is|should be|goes|stays?)\s+off\b${WHEN}$`, "i"),
];
const ON = [
  /^(?:please\s+)?(?:switch|turn|put)\s+(?<who>.+?)\s+(?:back\s+)?on(?:\s+(?:again|now|please|today))?$/i,
  /^(?:please\s+)?(?:switch|turn)\s+(?:back\s+)?on\s+(?<who>.+)$/i,
  /^(?:please\s+)?(?:enable|activate|reactivate|unpause|resume|bring\s+back|wake\s+up)\s+(?<who>.+)$/i,
  /^(?<who>.+?)\s+(?:is|should be|goes|comes)\s+back(?:\s+on)?(?:\s+(?:again|now|today))?$/i,
];
const MODE = [
  /^(?:please\s+)?(?:put|set|switch|move|make|run|keep)\s+(?<who>.+?)\s+(?:on|to|in|into|as)\s+(?<mode>light|full)(?:\s+mode)?$/i,
  /^(?<who>.+?)\s+(?:on|to|in)\s+(?<mode>light|full)\s+mode$/i,
];
const AUTONOMY = /\bautonomy\b(?:\s+(?:level|to|at|of))*\s+(?:level\s+|l)?(?<n>[0-3])\b|\b(?:level|l)\s?(?<m>[0-3])\s+autonomy\b/i;
const ALWAYS = /^(?:please\s+)?(?:always|make sure to|make sure you|every time)\b/i;
const NEVER_SAY = /^(?:please\s+)?(?:never|don'?t|do not)\s+(?:say|use the words?|use the phrase|call us|write)\b|^no\s+\S/i;
const RULE_START = /^(?:please\s+)?(?:no|never|don'?t|do not|avoid|always|only|stop|keep|make sure|every time|use|mention|include|quote|sign off|spell)\b/i;

const STYLE_RULE = /^(?:please\s+)?(?:never|don'?t|do not|avoid|quote|sign off|spell)\b/i;

interface ClauseResult { patches: DirectivePatch[]; notes: string[] }

function toggle(clause: string): ClauseResult | undefined {
  const refuse = (ids: string[]) => ids.filter((id) => id === CHIEF).map(() => agentChangeRefusal(CHIEF, { enabled: false })!);
  for (const [res, enabled] of [[OFF, false], [ON, true]] as const) {
    for (const re of res) {
      const g = re.exec(clause)?.groups;
      if (!g?.who || !onlyAgents(g.who)) continue;
      const ids = agentsIn(g.who);
      const note = g.rest?.trim().replace(/^[,;:\s]+/, "");
      const ok = enabled ? ids : ids.filter((id) => id !== CHIEF);
      return {
        patches: ok.map((agent): DirectivePatch => ({ kind: "agent.enabled", agent, enabled, ...(note && !enabled ? { note: clip(note, 120) } : {}) })),
        notes: enabled ? [] : refuse(ids),
      };
    }
  }
  return undefined;
}

function modeOrAutonomy(clause: string, to: string[]): ClauseResult | undefined {
  const a = AUTONOMY.exec(clause);
  if (a) {
    const ids = to.length ? to : agentsIn(clause);
    if (!ids.length) return undefined;
    const autonomy = Number(a.groups?.n ?? a.groups?.m);
    return { patches: ids.map((agent): DirectivePatch => ({ kind: "agent.autonomy", agent, autonomy })), notes: [] };
  }
  for (const re of MODE) {
    const g = re.exec(clause)?.groups;
    if (!g?.who || !onlyAgents(g.who)) continue;
    const mode = g.mode!.toLowerCase() as AgentMode;
    return { patches: agentsIn(g.who).map((agent): DirectivePatch => ({ kind: "agent.mode", agent, mode })), notes: [] };
  }
  return undefined;
}

// "our posts always end with a question" -> a rule for Miss Influencer's Instagram post craft (and Wordsmith's voice check holds it too).
// Only for a sentence that is a rule (it starts like one, or says always/never) and names what the skill is about
// (posts, reels, carousels, ads…); anything else stays a standing instruction.
function skillRuleClause(rest: string, to: string[], text: string): ClauseResult | undefined {
  // a standing rule, not a request to make something now ("write two posts" is a request)
  if (!/\b(?:always|never|every|each|from now on|don'?t|do not|no)\b/i.test(rest)) return undefined;
  const hits = targetsIn(rest, to);
  if (!hits.length) return undefined;
  const patches: DirectivePatch[] = hits.map((h) => ({ kind: "skill.rule", agents: h.agents, skill: h.skill, text }));
  if (hits.some((h) => h.agents.includes("content-strategist")) && (!to.length || to.includes("copy-editor") || to.includes("content-strategist"))) {
    patches.push({ kind: "skill.rule", agents: ["copy-editor"], skill: "brand-voice-check", text });
  }
  return { patches, notes: [] };
}

// "Miss Influencer, add a skill called Festival post: always open with the greeting, then the offer" -> the business's own skill.
const ADD_SKILL = /^(?:please\s+)?(?:add|create|teach|set up|make)\s+(?:a\s+|an\s+)?(?:new\s+)?skill\s+(?:called|named|for)?\s*["“']?(?<name>[^:"”']{3,60}?)["”']?\s*[:\-–]\s*(?<body>.{10,})$/i;

export function skillIdFor(name: string): string {
  const slug = slugify(name).replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (SKILL_ID.test(slug)) return slug;
  return slug ? `${slug}-skill` : `own-skill-${sha256(name).slice(0, 4)}`; // a name with no latin letters still gets an id
}

function addSkillClause(rest: string, to: string[]): ClauseResult | undefined {
  const g = ADD_SKILL.exec(rest)?.groups;
  if (!g?.name || !g.body) return undefined;
  if (!to.length) return { patches: [], notes: ['Say who the skill is for, e.g. "Miss Influencer, add a skill called Festival post: …".'] };
  const name = g.name.trim().replace(/^\w/, (c) => c.toUpperCase());
  return { patches: [{ kind: "skill.add", agents: to, id: skillIdFor(name), name, when: clip(`When the request is about ${name.toLowerCase()}`, 140), text: clip(sentence(g.body), MAX_SKILL_TEXT) }], notes: [] };
}

// One clause -> patches, or undefined when the rules don't understand it.
export function parseClause(clause: string): ClauseResult | undefined {
  const c = clause.trim();
  if (!c) return undefined;
  // An address first ("Miss Influencer, no emojis on LinkedIn"; "Growth Hacker: never spend above ₹2,000 a day").
  const addr = /^(?<to>[^,:]{1,60})[,:]\s+(?<rest>.+)$/.exec(c)?.groups;
  const to = addr && onlyAgents(addr.to!) ? agentsIn(addr.to!) : [];
  const rest = to.length ? addr!.rest! : c;
  // Mode and autonomy before the switches: "put Growth Hacker on light mode" is not "put Growth Hacker on".
  const m = modeOrAutonomy(c, to);
  if (m) return m;
  const t = toggle(c);
  if (t) return t;

  const add = addSkillClause(rest, to);
  if (add) return add;
  const cap = spendCap(rest);
  if (cap) {
    return { patches: [{ kind: "memory.instruction", agents: to.length ? to : SPEND_DESKS, text: sentence(rest), limit: { kind: "max_daily_spend", ...cap } }], notes: [] };
  }
  const scope = SCOPE.exec(rest)?.groups?.ch;
  const channel = scope ? channelRef(scope) : undefined;
  const text = clip(sentence(rest), MAX_PATCH_TEXT);
  // A rule for one kind of work ("our posts always end with a question"): a skill rule. Not when it is scoped to a channel.
  if (!channel) {
    const sr = skillRuleClause(rest, to, text);
    if (sr) return sr;
  }
  if (!RULE_START.test(rest)) return undefined;
  // A way of writing that names no particular kind of work ("never use emojis", "quote prices in AED"): it goes on all the
  // skills of the desks that write (or of the desk addressed), where the Team page shows it. "Always …" stays an instruction.
  if (!channel && STYLE_RULE.test(rest) && !NEVER_SAY.test(rest)) {
    return { patches: [{ kind: "skill.rule", agents: to.length ? to : PROMO_DESKS, skill: "*", text }], notes: [] };
  }
  const instruction = (agents: string[]): ClauseResult => ({
    patches: [{ kind: "memory.instruction", agents, text, ...(channel ? { channel: channel.id } : {}) }], notes: [],
  });
  if (to.length) return instruction(to);
  if (channel) return instruction(ALWAYS.test(rest) ? PROMO_DESKS : CONTENT_DESKS);
  if (ALWAYS.test(rest)) return instruction(PROMO_DESKS);
  if (NEVER_SAY.test(rest)) return { patches: [{ kind: "brand_rule.add", text, ruleKind: "voice" }], notes: [] };
  return undefined;
}

export interface ParsedDirective { patches: DirectivePatch[]; unparsed: string[]; notes: string[] }

export function parseDirective(text: string): ParsedDirective {
  const out: ParsedDirective = { patches: [], unparsed: [], notes: [] };
  for (const clause of splitClauses(text)) {
    const r = parseClause(clause);
    if (!r) { out.unparsed.push(clause); continue; }
    out.patches.push(...r.patches);
    out.notes.push(...r.notes);
  }
  return out;
}

// ---------- the model, for what the rules leave ----------

const PATCH_KINDS = ["agent.enabled", "agent.mode", "agent.autonomy", "memory.instruction", "brand_rule.add", "skill.rule", "skill.add"] as const;

export function directiveSchema(): object {
  return {
    type: "object",
    properties: {
      patches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...PATCH_KINDS] },
            agents: { type: "array", items: { type: "string", enum: AGENTS.map((a) => a.id) } },
            enabled: { type: "boolean" },
            mode: { type: "string", enum: [...AGENT_MODES] },
            autonomy: { type: "integer", minimum: 0, maximum: 3 },
            text: { type: "string" },
            channel: { type: "string" },
            note: { type: "string" },
            skill: { type: "string" },
            name: { type: "string" },
            when: { type: "string" },
            ruleKind: { type: "string", enum: ["voice", "visual"] },
            limitAmount: { type: "number" },
            limitCurrency: { type: "string" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      unclear: { type: "array", items: { type: "string" } },
    },
    required: ["patches", "unclear"],
    additionalProperties: false,
  };
}

export function directiveSystemPrompt(channels: Array<{ id: string; name: string }>): string {
  const team = AGENTS.map((a) => `- ${a.id}: ${a.name}, ${a.title}. Handles ${a.handles.join(", ")}.`).join("\n");
  return [
    "You turn what a small-business owner tells their AI team into settings patches. Only the owner's words below are instructions.",
    `The team (use these agent ids):\n${team}`,
    `The business's channels: ${channels.map((c) => c.name).join(", ") || "none recorded yet"}.`,
    `Patch kinds:
- agent.enabled: switch desks on or off. agents, enabled, note (e.g. "till the new site launches").
- agent.mode: full, light (cheaper, shorter work) or off. agents, mode.
- agent.autonomy: 0 draft only, 1 scheduled after approval, 2 auto-publish with a digest, 3 full. agents, autonomy.
- memory.instruction: a standing instruction for particular desks, optionally on one channel. agents, text (one sentence, in the owner's words), channel (its name), and limitAmount + limitCurrency for a daily spend cap.
- brand_rule.add: a rule for everything the brand says or shows. text, ruleKind (voice or visual).
- skill.rule: a rule for one way of working, e.g. "our posts always end with a question". agents, skill (a skill id from the list below, or * for all of those agents' skills), text, optionally channel.
- skill.add: the business's own way of working. agents, skill (a new id of lowercase words joined by dashes, or a listed id to replace it), name, when (one plain line), text (the method, in the owner's words).`,
    `Skills (id: name, for whom):\n${codeCatalog().skills.map((k) => `- ${k.id}: ${k.name} (${k.agents.join(", ")})`).join("\n")}`,
    `Rules:
- chief-of-staff can never be switched off.
- Posts and content go to content-strategist (copy-editor checks them); ads, budgets and campaigns to growth-marketer; the website and anything technical to tech-lead; app errors, crashes, Sentry and incidents to oncall-engineer; releases, builds and the app stores to qa-release; numbers to data-analyst; follow-ups to ops-manager; new enquiries, leads, replies to customers, booking calls and the pipeline to sales-lead.
- Make a patch only for what the owner clearly asked. Anything unclear goes in "unclear", quoted.
- Never invent desks; keep every text short and in the owner's words.`,
  ].join("\n\n");
}

const str = (v: unknown, n: number): string | undefined => (typeof v === "string" && v.trim() ? clip(v.trim(), n) : undefined);

// The model's output, validated: unknown desks and kinds dropped, the Chief never switched off, texts clipped.
export function patchesFromModel(raw: unknown): { patches: DirectivePatch[]; notes: string[]; unclear: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as { patches?: unknown; unclear?: unknown };
  const out = { patches: [] as DirectivePatch[], notes: [] as string[], unclear: [] as string[] };
  for (const u of Array.isArray(r.unclear) ? r.unclear : []) { const s = str(u, 200); if (s) out.unclear.push(s); }
  for (const p of Array.isArray(r.patches) ? r.patches : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const agents = unique((Array.isArray(o.agents) ? o.agents : []).filter((a): a is string => typeof a === "string" && !!agentById(a)));
    const text = str(o.text, MAX_PATCH_TEXT);
    switch (o.kind) {
      case "agent.enabled":
        if (typeof o.enabled !== "boolean") break;
        for (const agent of agents) {
          if (!o.enabled && agent === CHIEF) { out.notes.push(agentChangeRefusal(CHIEF, { enabled: false })!); continue; }
          const note = str(o.note, 120);
          out.patches.push({ kind: "agent.enabled", agent, enabled: o.enabled, ...(note && !o.enabled ? { note } : {}) });
        }
        break;
      case "agent.mode":
        if (!(AGENT_MODES as readonly unknown[]).includes(o.mode)) break;
        for (const agent of agents) {
          if (o.mode === "off" && agent === CHIEF) { out.notes.push(agentChangeRefusal(CHIEF, { mode: "off" })!); continue; }
          out.patches.push({ kind: "agent.mode", agent, mode: o.mode as AgentMode });
        }
        break;
      case "agent.autonomy":
        if (!(Number.isInteger(o.autonomy) && (o.autonomy as number) >= 0 && (o.autonomy as number) <= 3)) break;
        for (const agent of agents) out.patches.push({ kind: "agent.autonomy", agent, autonomy: o.autonomy as number });
        break;
      case "memory.instruction": {
        if (!text) break;
        const channel = typeof o.channel === "string" ? channelRef(o.channel) : undefined;
        const amount = typeof o.limitAmount === "number" && Number.isFinite(o.limitAmount) && o.limitAmount > 0 ? o.limitAmount : undefined;
        const currency = CURRENCIES.find(([re]) => re.test(String(o.limitCurrency ?? "").trim()))?.[1] ?? "";
        out.patches.push({
          kind: "memory.instruction", agents: agents.length ? agents : channel ? CONTENT_DESKS : PROMO_DESKS, text: sentence(text),
          ...(channel ? { channel: channel.id } : {}), ...(amount !== undefined ? { limit: { kind: "max_daily_spend", amount, currency } } : {}),
        });
        break;
      }
      case "brand_rule.add":
        if (text) out.patches.push({ kind: "brand_rule.add", text: sentence(text), ruleKind: o.ruleKind === "visual" ? "visual" : "voice" });
        break;
      case "skill.rule": {
        const skill = typeof o.skill === "string" ? o.skill.trim() : "";
        const known = skill === "*" || codeCatalog().skills.some((k) => k.id === skill);
        if (!text || !agents.length || !known) break;
        const channel = typeof o.channel === "string" ? channelRef(o.channel) : undefined;
        out.patches.push({ kind: "skill.rule", agents, skill, text: sentence(text), ...(channel ? { channel: channel.id } : {}) });
        break;
      }
      case "skill.add": {
        const name = str(o.name, 60);
        const id = typeof o.skill === "string" && SKILL_ID.test(o.skill.trim()) ? o.skill.trim() : name ? skillIdFor(name) : "";
        const body = str(o.text, MAX_SKILL_TEXT);
        if (!name || !id || !body || !agents.length) break;
        out.patches.push({ kind: "skill.add", agents, id, name, when: str(o.when, 140) ?? clip(`When the request is about ${name.toLowerCase()}`, 140), text: body });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

async function defaultLlm(): Promise<LlmRunner> {
  const { AgentSdkRunner } = await import("../ingest/llm.js"); // the Agent SDK loads only when a directive needs it
  return new AgentSdkRunner({ concurrency: 1, retries: 1, timeoutMs: 90_000 });
}

export async function parseWithModel(llm: LlmRunner, text: string, unparsed: string[], channels: Array<{ id: string; name: string }>): Promise<ParsedDirective> {
  const prompt = [
    `The owner wrote:\n"""\n${text.trim()}\n"""`,
    `Simple rules already handled the rest. Turn only these parts into patches:\n${unparsed.map((u) => `- ${u}`).join("\n")}`,
  ].join("\n\n");
  const raw = await llm.structured({ system: directiveSystemPrompt(channels), prompt, schema: directiveSchema(), model: DIRECTIVE_MODEL });
  const r = patchesFromModel(raw);
  return { patches: r.patches, unparsed: r.unclear, notes: r.notes };
}

// ---------- preview ----------

const patchKey = (p: DirectivePatch): string => JSON.stringify(p.kind === "memory.instruction" ? { ...p, agents: [...p.agents].sort() } : p);
const instructionId = (previewId: string, i: number): string => `memory:${previewId.replace(/^document:/, "")}-${i + 1}`;
export const brandRuleId = (text: string): string => entityId("BrandRule", `owner ${text}`);
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const state = (a: AgentSettings): string => (!a.enabled ? "off" : a.mode === "light" ? "on (light)" : "on");
const skillLabel = (skill: string, agents: string[]): string => {
  const who = agents.map((a) => agentById(a)?.name ?? a).join(", ");
  if (skill === "*") return `${who}, all their skills`;
  const k = codeCatalog().skills.find((x) => x.id === skill);
  return `${who}'s ${k ? k.name : skill}`;
};
const agentLabel = (id: string): string => plainWho(id);

function diffOf(patches: DirectivePatch[], agents: AgentSettings[], existingRules: Set<string>, previewId: string, skillRules: readonly SkillRule[] = []): DirectiveDiffLine[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return patches.map((p, i): DirectiveDiffLine => {
    switch (p.kind) {
      case "agent.enabled": {
        const cur = byId.get(p.agent)!;
        const after = p.enabled ? "on" : `off${p.note ? ` (${p.note})` : ""}`;
        return { patch: i, op: cur.enabled === p.enabled ? "same" : "change", target: agentNodeId(p.agent), label: agentLabel(p.agent), before: state(cur), after };
      }
      case "agent.mode": {
        const cur = byId.get(p.agent)!;
        const before = cur.enabled ? cur.mode : "off";
        return { patch: i, op: before === p.mode ? "same" : "change", target: agentNodeId(p.agent), label: `${agentLabel(p.agent)} mode`, before, after: p.mode };
      }
      case "agent.autonomy": {
        const cur = byId.get(p.agent)!;
        return { patch: i, op: cur.autonomy === p.autonomy ? "same" : "change", target: agentNodeId(p.agent), label: `${agentLabel(p.agent)} autonomy`, before: `L${cur.autonomy}`, after: `L${p.autonomy}` };
      }
      case "memory.instruction": {
        const has = p.agents.every((a) => byId.get(a)?.instructions.some((n) => norm(n.text) === norm(p.text)));
        const ch = p.channel ? channelRef(p.channel) : undefined;
        const who = p.agents.map((a) => agentById(a)?.name ?? a).join(", ");
        return { patch: i, op: has ? "same" : "add", target: instructionId(previewId, i), label: `Instruction for ${who}${ch ? ` on ${ch.name}` : ""}`, after: p.text };
      }
      case "brand_rule.add":
        return { patch: i, op: existingRules.has(brandRuleId(p.text)) ? "same" : "add", target: brandRuleId(p.text), label: `Brand rule (${p.ruleKind})`, after: p.text };
      case "skill.rule": {
        const has = p.agents.every((a) => skillRules.some((r) => r.agents.includes(a) && r.skillId === p.skill && norm(r.text) === norm(p.text)));
        const ch = p.channel ? channelRef(p.channel) : undefined;
        return { patch: i, op: has ? "same" : "add", target: instructionId(previewId, i), label: `Rule for ${skillLabel(p.skill, p.agents)}${ch ? ` on ${ch.name}` : ""}`, after: p.text };
      }
      case "skill.add": {
        const shipped = codeCatalog().skills.some((k) => k.id === p.id);
        const who = p.agents.map((a) => agentById(a)?.name ?? a).join(", ");
        return { patch: i, op: "add", target: instructionId(previewId, i), label: `${shipped ? "New way of working for" : "New skill for"} ${who}: ${p.name}`, after: p.text };
      }
    }
  });
}

async function ensurePerson(g: GraphHandle, id: string, now: number): Promise<boolean> {
  const [r] = await g.roQuery<{ c: number }>("MATCH (n:Entity {id:$id}) RETURN count(n) AS c", { id });
  if (r?.c) return true;
  if (!id.startsWith("person:")) return false;
  const name = id.slice(7).replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase()) || id;
  const s = await writeBatch(g, { nodes: [{ type: "Person", id, name }] }, now);
  return s.errors.length === 0;
}

export interface PreviewDeps {
  llm?: LlmRunner | null;  // undefined: haiku through the Agent SDK (subscription), only when the rules leave something; null: rules only
  now?: number;
}

export async function previewDirective(g: GraphHandle, input: { text: string; actor?: string }, deps: PreviewDeps = {}): Promise<DirectivePreview> {
  // The owner's words go through the privacy filter ingest uses (ingest/clean.ts) before anything reads or saves them, the model that
  // reads the instruction included: a key or a phone number in it never reaches the graph, and the preview says so.
  const removed = new Removed();
  const text = cleanText(input.text.trim(), removed);
  if (!text) throw new Error("Tell your team something first.");
  if (text.length > MAX_TEXT) throw new Error(`That is too long for one instruction (${text.length} characters; at most ${MAX_TEXT}).`);
  const actor = input.actor ?? "person:founder";
  const now = deps.now ?? Date.now();

  const parsed = parseDirective(text);
  if (removed.total) parsed.notes.push(`${removed.note()} Your team will not see them.`);
  let parser: DirectivePreview["parser"] = "rules";
  if (parsed.unparsed.length && deps.llm !== null) {
    try {
      const channels = await g.roQuery<{ id: string; name: string }>("MATCH (c:Channel) WHERE c.rival IS NULL RETURN c.id AS id, c.name AS name ORDER BY id LIMIT 40");
      const m = await parseWithModel(deps.llm ?? await defaultLlm(), text, parsed.unparsed, channels);
      parsed.patches.push(...m.patches);
      parsed.notes.push(...m.notes);
      parsed.unparsed = m.unparsed;
      parser = "rules+llm";
    } catch (e) {
      parsed.notes.push(`Only the parts above were understood: the language model could not read the rest (${clip(msg(e), 160)}).`);
    }
  }
  const seen = new Set<string>();
  const patches = parsed.patches.filter((p) => { const k = patchKey(p); return !seen.has(k) && !!seen.add(k); });

  const id = entityId("Document", `directive ${istDate(now)} ${randomBytes(4).toString("hex")}`);
  const [agents, rules] = await Promise.all([
    listAgentsWithSettings(g),
    g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (r:Entity:BrandRule {id:id}) RETURN r.id AS id",
      { ids: patches.filter((p) => p.kind === "brand_rule.add").map((p) => brandRuleId(p.text)) }),
  ]);
  const skillRules = patches.some((p) => p.kind === "skill.rule") ? (await loadBusinessSkills(g)).rules : [];
  const diff = diffOf(patches, agents, new Set(rules.map((r) => r.id)), id, skillRules);
  const preview: DirectivePreview = { id, text, actor, status: "preview", patches, diff, unparsed: parsed.unparsed, notes: unique(parsed.notes), parser };

  const props: Record<string, Prim> = {
    kind: "directive", text, status: "preview", actor, at: now, parser,
    patches: JSON.stringify(patches), diff: JSON.stringify(diff), unparsed: preview.unparsed, notes: preview.notes,
  };
  const s = await writeBatch(g, { nodes: [{ type: "Document", id, name: clip(`Tell your team: ${text.replace(/\s+/g, " ")}`, 120), summary: clip(text, 600), props }] }, now);
  if (s.errors.length) throw new Error(`Could not save the preview: ${s.errors[0]!.error}`);
  if (await ensurePerson(g, actor, now)) await writeBatch(g, { edges: [{ from: actor, type: "AUTHORED", to: id }] }, now);
  return preview;
}

// ---------- apply ----------

const parseJson = <T>(s: unknown, fallback: T): T => { try { return typeof s === "string" ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

export async function getDirective(g: GraphHandle, id: string): Promise<(DirectivePreview & { name: string }) | null> {
  const [r] = await g.roQuery<{ p: Record<string, unknown> }>("MATCH (d:Entity:Document {id:$id}) WHERE d.kind = 'directive' RETURN properties(d) AS p", { id });
  if (!r) return null;
  const p = r.p;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    id, name: String(p.name ?? id), text: String(p.text ?? ""), actor: String(p.actor ?? "person:founder"),
    status: p.status === "applied" ? "applied" : "preview",
    // Stored by previewDirective; re-validated so a hand-edited node can't write past the rules.
    patches: parseJson<DirectivePatch[]>(p.patches, []).filter(validPatch),
    diff: parseJson<DirectiveDiffLine[]>(p.diff, []), unparsed: strs(p.unparsed), notes: strs(p.notes),
    parser: p.parser === "rules+llm" ? "rules+llm" : "rules",
  };
}

function validPatch(p: DirectivePatch): boolean {
  if (!p || typeof p !== "object") return false;
  switch (p.kind) {
    case "agent.enabled": return !!agentById(p.agent) && typeof p.enabled === "boolean" && !agentChangeRefusal(p.agent, { enabled: p.enabled });
    case "agent.mode": return !!agentById(p.agent) && !agentChangeRefusal(p.agent, { mode: p.mode });
    case "agent.autonomy": return !!agentById(p.agent) && !agentChangeRefusal(p.agent, { autonomy: p.autonomy });
    case "memory.instruction": return Array.isArray(p.agents) && p.agents.length > 0 && p.agents.every((a) => !!agentById(a)) && typeof p.text === "string" && !!p.text.trim();
    case "brand_rule.add": return typeof p.text === "string" && !!p.text.trim();
    case "skill.rule": return Array.isArray(p.agents) && p.agents.length > 0 && p.agents.every((a) => !!agentById(a)) && typeof p.text === "string" && !!p.text.trim()
      && (p.skill === "*" || SKILL_ID.test(p.skill));
    case "skill.add": return Array.isArray(p.agents) && lintBusinessSkill({ id: p.id, name: p.name, when: p.when, body: p.text, agents: p.agents }, (a) => agentById(a)?.tools ?? undefined).length === 0;
    default: return false;
  }
}

export async function applyDirective(g: GraphHandle, previewId: string, opts: { now?: number } = {}): Promise<DirectivePreview & { errors: string[] }> {
  const now = opts.now ?? Date.now();
  const d = await getDirective(g, previewId);
  if (!d) throw new Error(`There is no directive preview ${previewId}.`);
  const { name, ...preview } = d;
  if (d.status === "applied") return { ...preview, errors: [] }; // applied already: nothing more to write

  const [roster] = await g.roQuery<{ c: number }>("MATCH (a:Entity:Agent) WHERE a.id IN $ids RETURN count(a) AS c", { ids: AGENTS.map((a) => agentNodeId(a.id)) });
  if ((roster?.c ?? 0) < AGENTS.length) await ensureRoster(g, {}, now);
  const businessId = await findBusiness(g);
  const stated = await ensurePerson(g, d.actor, now);
  const same = new Set(d.diff.filter((l) => l.op === "same").map((l) => l.patch));
  const errors: string[] = [];

  for (const [i, p] of d.patches.entries()) {
    try {
      if (p.kind === "agent.enabled") await setAgentSettings(g, p.agent, { enabled: p.enabled, ...(p.note ? { statusNote: p.note } : {}) }, { now, src: previewId });
      else if (p.kind === "agent.mode") await setAgentSettings(g, p.agent, { mode: p.mode }, { now, src: previewId });
      else if (p.kind === "agent.autonomy") await setAgentSettings(g, p.agent, { autonomy: p.autonomy }, { now, src: previewId });
      else if (!same.has(i)) {
        const actor = stated ? d.actor : undefined;
        const w = p.kind === "memory.instruction"
          ? await instructionWrite(g, p, instructionId(previewId, i), previewId, actor, now)
          : p.kind === "skill.rule"
            ? await skillRuleWriteFor(g, p, instructionId(previewId, i), previewId, actor, now)
            : p.kind === "skill.add"
              ? skillWrite(p, instructionId(previewId, i), previewId, actor, now, isoDate(now))
              : brandRuleWrite(p, previewId, businessId, now);
        const s = await writeBatch(g, w, now);
        if (s.errors.length) throw new Error(s.errors.map((e) => e.error).join("; "));
      }
    } catch (e) {
      errors.push(`${d.diff[i]?.label ?? p.kind}: ${msg(e)}`);
    }
  }
  await upsertNode(g, { type: "Document", id: previewId, name, props: { status: "applied", appliedAt: now, applyErrors: errors } }, now);
  return { ...preview, status: "applied", errors };
}

async function instructionWrite(
  g: GraphHandle, p: Extract<DirectivePatch, { kind: "memory.instruction" }>, id: string, src: string, actor: string | undefined, now: number,
): Promise<{ nodes: NodeInput[]; edges: EdgeInput[] }> {
  const ch = p.channel ? channelRef(p.channel) : undefined;
  const chExists = ch ? !!(await g.roQuery<{ c: number }>("MATCH (c:Entity:Channel {id:$id}) RETURN count(c) AS c", { id: ch.id }))[0]?.c : false;
  const props: Record<string, Prim> = {
    kind: "instruction", text: p.text, status: "active", at: now,
    ...(ch ? { channel: ch.id, channelName: ch.name } : {}),
    ...(p.limit ? { limitKind: p.limit.kind, limitAmount: p.limit.amount, limitCurrency: p.limit.currency } : {}),
  };
  return {
    nodes: [{ type: "Memory", id, name: clip(p.text, 80), summary: p.text, src, asOf: isoDate(now), props }],
    edges: [
      ...p.agents.map((a): EdgeInput => ({ from: id, type: "ABOUT", to: agentNodeId(a), src })),
      ...(ch && chExists ? [{ from: id, type: "ABOUT" as const, to: ch.id, src }] : []),
      ...(actor ? [{ from: actor, type: "STATED" as const, to: id, src }] : []),
      { from: id, type: "SOURCED_FROM", to: src, src },
    ],
  };
}

async function skillRuleWriteFor(
  g: GraphHandle, p: Extract<DirectivePatch, { kind: "skill.rule" }>, id: string, src: string, actor: string | undefined, now: number,
): Promise<{ nodes: NodeInput[]; edges: EdgeInput[] }> {
  const ch = p.channel ? channelRef(p.channel) : undefined;
  const chExists = ch ? !!(await g.roQuery<{ c: number }>("MATCH (c:Entity:Channel {id:$id}) RETURN count(c) AS c", { id: ch.id }))[0]?.c : false;
  return skillRuleWrite({ agents: p.agents, skill: p.skill, text: p.text, channel: ch, channelExists: chExists }, id, src, actor, now, isoDate(now));
}

function brandRuleWrite(p: Extract<DirectivePatch, { kind: "brand_rule.add" }>, src: string, businessId: string | null, now: number): { nodes: NodeInput[]; edges: EdgeInput[] } {
  const id = brandRuleId(p.text);
  return {
    nodes: [{ type: "BrandRule", id, name: clip(p.text, 80), summary: p.text, src, asOf: isoDate(now), props: { kind: p.ruleKind, text: p.text, origin: "owner" } }],
    edges: [
      ...(businessId ? [{ from: id, type: "APPLIES_TO" as const, to: businessId, src }] : []),
      { from: id, type: "SOURCED_FROM", to: src, src },
    ],
  };
}
