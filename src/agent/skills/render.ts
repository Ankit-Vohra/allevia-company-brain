// How a skill reaches the agent: the prompt's one-line list (progressive disclosure) and the full text use_skill returns.
import type { ToolContext } from "../tool.js";
import type { SkillCatalog } from "./catalog.js";
import type { Skill } from "./format.js";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// Every skill starts from the brain (the founder, 2026-10-17: "every agent should refer to the brain, that is the whole MVP of this
// product"). Said once here for all of them, so no method can skip it.
const CREATIVE_TOOLS = new Set(["content_performance", "what_worked", "make_poster", "generate_image", "make_reel_script_and_clip", "write_copy"]);
export const isCreativeSkill = (s: Pick<Skill, "tools" | "agents">): boolean => s.tools.some((t) => CREATIVE_TOOLS.has(t)) || s.agents.includes("content-strategist");
export const BRAIN_FIRST_CREATIVE = "Brain first, before step 1: call what_worked (if you hold it) with your first lookups. Copy the kind of hook and opening of the business's top posts (never their words), avoid what the weakest did, follow the things learned from the owner's edits, and close with the main goal's call to action. Open the draft with \"Made for: <main goal> · CTA: <call to action>\" and its \"Built from: …\" line (cite what it names). If it says there are no post numbers yet, say so in that line and build from the main goal, the brand's voice and rivals' posts.";
export const BRAIN_FIRST_READ = "Brain first, before step 1: start from what the records already hold (metric_trend, recall, decisions, rules, earlier findings, what we already know). Use connected tools, public data or the web only to fill a gap the records leave, say what they added, and keep their source with it. Say how your answer bears on the main goal.";

/** The prompt's list: each skill's id, name and when to use it. Nothing else loads until the agent opens one. */
export function skillsBlock(skills: readonly Skill[], opts: { max?: number; phase?: "plan" | "review" | "other" } = {}): string {
  if (!skills.length) return "";
  const open = opts.phase === "plan"
    ? "Open one only when the request really needs it: most questions do not."
    : opts.phase === "review"
      ? "Open the one that fits the draft you are checking, in your first (only) round of tool calls."
      : "Open the one that fits with use_skill in your first round of tool calls, together with your lookups. Open at most two. If none fits, just do the work.";
  // this business's own versions of a craft (its reels, its ads, its voice) come first, and are opened first
  const own = skills.filter((s) => s.source === "business" && s.base);
  const ordered = [...own, ...skills.filter((s) => !own.includes(s))];
  const lines = ordered.slice(0, opts.max ?? 14).map((s) => `- ${s.id}: ${s.name}. Use it for: ${oneLine(s.when)}${s.source === "business" ? " (set up for this business)" : ""}`);
  const first = own.length ? `\nThis business has its own versions of some skills (${own.map((s) => s.id).join(", ")}): when the request is about that work (a reel, an ad, its voice), open the business's own one first, then the general one (${own.map((s) => s.base).join(", ")}) only if you need its full method.` : "";
  return `Your skills (the way you do each kind of job here; each is a method with a house style, a checklist and common mistakes). ${open}${first}\n${lines.join("\n")}`;
}

/** The planner's view of a desk's skills: names only, so it can route "a reel script" to whoever has that skill. */
export const skillNames = (skills: readonly Skill[]): string => skills.map((s) => s.name).join("; ");

// The full text of a skill for the agent that opened it: what it is, whether it needs the owner's OK, the body, then the
// rules this business added to it. The business's rules are the owner's own words, so they come before the skill's habits.
export async function skillGuidance(skill: Skill, ctx: ToolContext, catalog: SkillCatalog, extra: string[] = []): Promise<string> {
  const rules = catalog.rulesFor(ctx.agentId, skill.id);
  const ok = skill.needsOk
    ? `What you make with this goes to the owner as a draft waiting for their OK (propose_action); nothing goes out on its own.`
    : skill.output === "creates" ? "What you make with this is a draft for the owner." : "This only reads and explains; it makes nothing.";
  const parts = [
    `SKILL: ${skill.name}${skill.source === "business" ? " (set up for this business)" : ""}`,
    `Use it for: ${oneLine(skill.when)}. ${ok}`,
    isCreativeSkill(skill) ? BRAIN_FIRST_CREATIVE : BRAIN_FIRST_READ,
    skill.body,
  ];
  if (rules.length) {
    parts.push(`This business's own rules for this skill (the owner's or the team's words: follow them even where they differ from the skill):\n${rules.map((r) => `- ${r.text.trim()}${r.channel ? ` (on ${r.channel.name})` : ""}`).join("\n")}`);
  }
  if (extra.length) parts.push(`Things the team learned from the owner's edits that apply here:\n${extra.map((t) => `- ${t}`).join("\n")}`);
  parts.push("This is a way of working, not evidence. Do not cite anything in it. Every claim you write still comes from your tools.");
  return parts.join("\n\n");
}
