// How a skill reaches the agent: the prompt's one-line list (progressive disclosure) and the full text use_skill returns.
import type { ToolContext } from "../tool.js";
import type { SkillCatalog } from "./catalog.js";
import type { Skill } from "./format.js";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

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
    skill.body,
  ];
  if (rules.length) {
    parts.push(`This business's own rules for this skill (the owner's or the team's words: follow them even where they differ from the skill):\n${rules.map((r) => `- ${r.text.trim()}${r.channel ? ` (on ${r.channel.name})` : ""}`).join("\n")}`);
  }
  if (extra.length) parts.push(`Things the team learned from the owner's edits that apply here:\n${extra.map((t) => `- ${t}`).join("\n")}`);
  parts.push("This is a way of working, not evidence. Do not cite anything in it. Every claim you write still comes from your tools.");
  return parts.join("\n\n");
}
