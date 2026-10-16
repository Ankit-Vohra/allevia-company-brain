// Sample-mode support for the chat: a direct chat with one person on the team (a short scripted run in that person's own
// voice and tools), and the plain-words skills and tools each person lists. The live server does the real thing; this is
// what ?mock=1 shows.
import type { AgentId } from "@shared/contracts";
import { agentById } from "@shared/roster";
import { PLAIN_TOOLS } from "@shared/plain-tools";
import type { AgentView } from "../types-ext";
import { MOCK_SKILLS } from "./skills-data";
import type { ScriptSpec } from "./script";

const D007 = "decision:007-pause-daily-posts-and-stories";
const OBS_HOOKS = "observation:hook-performance-90d-2026-10-14";
const OBS_REELS = "observation:ig-reels-reach-share-2026-09-28";
const OBS_SIGNUPS = "observation:signups-wk41";
const OBS_GSC = "observation:gsc-jobs-clicks-2026-10";
const OBS_OTP = "observation:funnel-otp-drop-2026-10";
const AVS_GSC = "observation:gsc-architect-raipur-2026-10";
const AVS_HOME = "page:avsatelier.in/";

interface Voice {
  tool: string;
  args: unknown;
  summary: string;
  ids: string[];
  skill?: { id: string; name: string };
  answer: string;
  path: string[];
  proposal?: { approvalId: string; recommendationId: string; title: string; kind: "content_draft" | "github_issue" | "pause_ad" | "discord_post" };
}

// What each person says in their own chat, in sample mode. Aamdani has the full set; a business set up from a website gets the
// SEO ones. Anyone not listed answers briefly from the records.
const AAMDANI: Partial<Record<AgentId, Voice>> = {
  "content-strategist": {
    tool: "content_performance", args: { window: "90d", by: "hook" },
    summary: "18 reels across 4 hook formulas. Salary reveal 3.4× median reach; day in the life 2.1×; question to camera 0.6×.",
    ids: [OBS_HOOKS, "rule:hook-salary-reveal", "rule:hook-day-in-the-life", "content:reel-2026-09-12-forklift-salary"],
    skill: { id: "reel-script", name: "Reel script craft" },
    answer: `**Open the next three reels on a real salary or a real shift.** Over 90 days our salary-reveal reels got 3.4× the median reach and day-in-the-life reels 2.1× [[${OBS_HOOKS}]] [[rule:hook-salary-reveal]].

1. **"₹18,000 + PF: a forklift operator's real month."** Same hook as our best reel [[content:reel-2026-09-12-forklift-salary]].
2. **"What a delivery partner takes home."** Hindi first, English captions.
3. **"A day with one employer and the screening call."** For the employers.

**Next:** say OK and I will send all three to the reel pipeline as drafts. Nothing is posted until you approve. Figures as of 14 Oct 2026.`,
    path: ["rule:hook-salary-reveal", OBS_HOOKS, "content:reel-2026-09-12-forklift-salary"],
    proposal: { approvalId: "appr:content-3-reels", recommendationId: "rec:salary-reveal-reels", title: "Draft 3 reels: two salary reveals and a day with the screening call", kind: "content_draft" },
  },
  "data-analyst": {
    tool: "metric_trend", args: { metric: "signups", weeks: 6 },
    summary: "Sign-ups rose to 312 in week 41; 41% of people who start signing up leave at the code step.",
    ids: [OBS_SIGNUPS, OBS_OTP, "metric:signups"],
    skill: { id: "funnel-drop-off-diagnosis", name: "Where people drop off" },
    answer: `**Sign-ups are up 18% to 312 last week, but 41% of people who start still leave at the sign-up code step** [[${OBS_SIGNUPS}]] [[${OBS_OTP}]].

The code step is where most people give up. A fallback for people who do not get the code would win back the most. Figures as of 12 Oct 2026.`,
    path: [OBS_SIGNUPS, OBS_OTP],
  },
  "growth-marketer": {
    tool: "ad_report", args: { window: "14d" },
    summary: "Meta · Seekers broad cost ₹96 per sign-up against ₹38 across the account (sample numbers).",
    ids: ["campaign:meta-seekers-broad", "observation:meta-cpa-seekers-broad", "channel:meta-ads"],
    answer: `**Pause "Meta · Seekers broad".** It cost ₹96 for each sign-up over 14 days, against ₹38 for the account as a whole. These are sample numbers [[observation:meta-cpa-seekers-broad]] [[campaign:meta-seekers-broad]].

**Next:** your OK pauses it. Nothing else changes.`,
    path: ["channel:meta-ads", "campaign:meta-seekers-broad", "observation:meta-cpa-seekers-broad"],
    proposal: { approvalId: "appr:pause-seekers-broad", recommendationId: "rec:pause-seekers-broad", title: "Pause 'Meta · Seekers broad' (simulated)", kind: "pause_ad" },
  },
  "tech-lead": {
    tool: "seo_report", args: { window: "28d", section: "jobs" },
    summary: "38 job pages share one title and have no meta description. Clicks fell 26% while impressions held.",
    ids: [OBS_GSC, "page:www.aamdani.ai/jobs"],
    skill: { id: "seo-search-console-check", name: "Search visibility check" },
    answer: `**38 of your job pages share one title and have no description, and clicks from Google fell 26%** while the number of people seeing them held [[${OBS_GSC}]] [[page:www.aamdani.ai/jobs]].

**Next:** one fix covers all of them. Say OK and I file it.`,
    path: ["page:www.aamdani.ai/jobs", OBS_GSC],
    proposal: { approvalId: "appr:gh-jobs-meta", recommendationId: "rec:jobs-meta", title: "Unique titles and meta descriptions for 38 job pages", kind: "github_issue" },
  },
  "coe-lead": {
    tool: "metric_trend", args: { metric: "reach", weeks: 6 },
    summary: "Weekly Instagram reach 18,420 in week 41; reels were 97% of reach on 28 Sep.",
    ids: ["observation:ig-reach-wk41", OBS_REELS, "metric:reach"],
    answer: `**Business this week: reach is 18,420, sign-ups 312.** Reels brought 97% of our Instagram reach [[${OBS_REELS}]] [[observation:ig-reach-wk41]]. Both figures match the exports from 13 and 14 Oct.`,
    path: ["metric:reach", "observation:ig-reach-wk41", OBS_REELS],
  },
  librarian: {
    tool: "trace_decision", args: { id: D007 },
    summary: "Decided 28 Sep 2026 by the founder; reels 97% of reach.",
    ids: [D007, "person:founder", OBS_REELS],
    answer: `**You paused daily posts and stories on 28 Sep 2026.** Stories and posts reached about 24 accounts each, while reels brought 97% of reach [[${D007}]] [[${OBS_REELS}]].`,
    path: ["person:founder", D007, OBS_REELS],
  },
};

const AVS: Partial<Record<AgentId, Voice>> = {
  "tech-lead": {
    tool: "get_entity", args: { id: AVS_HOME },
    summary: "Title is 'Home', no H1, no LocalBusiness schema; mobile LCP 3.8 s.",
    ids: [AVS_HOME, "rule:seo-generic-title", "rule:seo-missing-h1", "rule:seo-no-localbusiness-schema"],
    skill: { id: "seo-search-console-check", name: "Search visibility check" },
    answer: `**The home page fails 4 checks:** the title is just "Home", there is no main heading, no local business markup, and it loads slowly on a phone (3.8 s) [[rule:seo-generic-title]] [[rule:seo-missing-h1]] [[rule:seo-no-localbusiness-schema]].

**Next:** I can file one fix that covers all four.`,
    path: [AVS_HOME, "rule:seo-generic-title", "rule:seo-no-localbusiness-schema"],
    proposal: { approvalId: "appr:avs-gh-home-seo", recommendationId: "rec:avs-home-seo", title: "Home page: title, H1 and LocalBusiness schema", kind: "github_issue" },
  },
  "data-analyst": {
    tool: "seo_report", args: { query: "architect in raipur", window: "28d" },
    summary: "1,240 impressions, 5 clicks, average position 18.6.",
    ids: [AVS_GSC, "query:architect-in-raipur", AVS_HOME],
    answer: `**You are on page 2 of Google for "architect in raipur":** average position 18.6, 1,240 views and only 5 clicks in 28 days [[${AVS_GSC}]] [[query:architect-in-raipur]].`,
    path: ["query:architect-in-raipur", AVS_GSC, AVS_HOME],
  },
};

const fallback = (id: AgentId, tenant: string): Voice => {
  const a = agentById(id);
  const ids = tenant === "avs-atelier" ? [AVS_GSC, "query:architect-in-raipur"] : [OBS_SIGNUPS, "metric:signups"];
  return {
    tool: a?.tools[0] ?? "search", args: {}, summary: "Read what we have on this.", ids,
    answer: `**Here is what I can see from your records.** ${tenant === "avs-atelier" ? `On Google you are on page 2 for "architect in raipur" [[${AVS_GSC}]].` : `Sign-ups were 312 last week [[${OBS_SIGNUPS}]].`} Ask me something more specific and I will go deeper.`,
    path: ids,
  };
};

/** A short scripted run for a direct chat with one person: it reads, says what it is using, and answers in its own name. */
export function directRun(tenant: string, agent: AgentId, question: string): ScriptSpec {
  const v = (tenant === "avs-atelier" ? AVS : AAMDANI)[agent] ?? fallback(agent, tenant);
  const name = agentById(agent)?.name ?? agent;
  return {
    tenant, key: `direct-${agent}`, question, match: /.*/,
    build: (s) => {
      const t = s.track(agent, 300);
      t.start(question.length > 70 ? `${question.slice(0, 67)}…` : question, 200)
        .status(`${name} is reading your records`, 300);
      if (v.skill) t.emit({ type: "skill_used", agent, skillId: v.skill.id, name: v.skill.name, source: "code" }, 400);
      t.tool(v.tool, v.args, 1100, v.summary, v.ids, 500)
        .stream(v.answer, 55, 300)
        .path(v.path, 300);
      if (v.proposal) t.emit({ type: "proposal", agent, recommendationId: v.proposal.recommendationId, approvalId: v.proposal.approvalId, title: v.proposal.title, kind: v.proposal.kind }, 300);
      t.done(5200, 300);
    },
  };
}

/** What a person can look at and do, in the owner's words (the same lines the live server sends). */
export const toolsOf = (id: AgentId): NonNullable<AgentView["tools"]> => (agentById(id)?.tools ?? []).map((name) => ({ name, words: PLAIN_TOOLS[name] ?? name }));

/** A person's skills as the owner reads them, with the ones switched off marked. */
export const skillsOf = (id: AgentId, off: readonly string[] = []): NonNullable<AgentView["skills"]> =>
  (MOCK_SKILLS[id] ?? []).map((s) => ({ ...s, ...(off.includes(s.id) ? { on: false } : {}), source: "code" as const, rules: [], learned: [] }));
