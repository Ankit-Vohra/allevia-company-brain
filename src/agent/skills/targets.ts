// Which skill an owner's words are about. "Our posts always end with a question" is about Tara's Instagram post craft;
// "no music in reels" is about her reel script skill. The words are what an owner says, not skill ids. A rule that names
// none of these stays a standing instruction for the team (src/settings/directives.ts).

export interface SkillTarget {
  skill: string;       // a shipped skill id
  agents: string[];    // roster ids that own it
  words: RegExp;       // what the owner says about it
}

export const SKILL_TARGETS: readonly SkillTarget[] = [
  { skill: "instagram-post", agents: ["content-strategist"], words: /\b(?:posts?|captions?|instagram|insta|ig)\b/i },
  { skill: "reel-script", agents: ["content-strategist"], words: /\b(?:reels?|videos?|scripts?|shorts?)\b/i },
  { skill: "carousel-post", agents: ["content-strategist"], words: /\b(?:carousels?|slides?|swipe posts?)\b/i },
  { skill: "campaign-brief", agents: ["content-strategist"], words: /\b(?:campaigns?|festival|festivals|diwali|eid|christmas|black friday)\b/i },
  { skill: "photo-to-ad-brief", agents: ["content-strategist"], words: /\b(?:ads?|posters?|creatives?|banners?)\b/i },
  { skill: "ad-budget-check", agents: ["growth-marketer"], words: /\b(?:ad spend|ad budget|budget|ad campaigns?)\b/i },
  { skill: "offer-test-plan", agents: ["growth-marketer"], words: /\b(?:offers?|discounts?|promotions?)\b/i },
  { skill: "channel-mix", agents: ["growth-marketer"], words: /\bchannels?\b/i },
  { skill: "follow-up-drafts", agents: ["ops-manager"], words: /\b(?:follow[- ]?ups?|reminders?|nudges?)\b/i },
  { skill: "weekly-numbers-review", agents: ["coe-lead"], words: /\b(?:weekly (?:numbers|report|review)|numbers report)\b/i },
  { skill: "fix-ticket", agents: ["tech-lead", "oncall-engineer", "qa-release"], words: /\b(?:tickets?|issues?|bug reports?)\b/i },
  { skill: "owner-answer-shapes", agents: ["chief-of-staff"], words: /\b(?:answers?|replies|reply|my questions)\b/i },
  { skill: "what-do-i-do-this-week", agents: ["chief-of-staff"], words: /\b(?:weekly plan|this week'?s plan|what to do this week)\b/i },
];

// The skills a text is about, limited to the named agents when the owner named any. Most specific first (a text that
// says "reel" is about reels even though a script is also a post).
export function targetsIn(text: string, agents: readonly string[] = []): Array<{ skill: string; agents: string[] }> {
  const out: Array<{ skill: string; agents: string[] }> = [];
  for (const t of SKILL_TARGETS) {
    if (!t.words.test(text)) continue;
    const who = agents.length ? t.agents.filter((a) => agents.includes(a)) : t.agents;
    if (who.length) out.push({ skill: t.skill, agents: who });
  }
  // "instagram" or "posts" in a sentence about reels or carousels: the narrower skill wins.
  const narrow = out.filter((o) => o.skill !== "instagram-post");
  return narrow.length ? narrow : out;
}
