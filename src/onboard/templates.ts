// Industry templates (product design §2.4 "Industry template", §2.1 "Goals and photos"): which goals a business of a
// kind starts Allevia 90 with, who on the team owns each, and where each goal's number comes from in the graph.
// v1 keeps them here as typed data; each is written to the graph as a Document{kind:'template'} the Goals are
// SOURCED_FROM, so a goal can always say which template set it.
//
// A goal's number is never typed in: `sources` say which Observations measure it, best first. A goal reads the first
// source that has a complete, recent reading; none means the baseline is unknown (product design §9 item 5: no made-up
// history). Targets are the template's: the Day-0 baseline plus `lift`, or `minTarget` when there is no baseline (or
// it is zero), and the goal records which (targetBasis).
import type { AgentId } from "../../shared/contracts.js";

export type TemplateKey = "jobs_platform" | "architecture_studio" | "local_business";

// week: the last 7 complete days; month: the last 28, the window Instagram and Search Console report.
export type GoalPeriod = "week" | "month";
export const PERIOD_DAYS: Record<GoalPeriod, number> = { week: 7, month: 28 };

// Where a goal's number comes from. `subject` "business" is the tenant's own Business node.
//   daily_sum  one reading per day (windowStart = windowEnd), summed over the period; every day must be there
//   window     one reading whose window spans about the period (account_reach over 28 days)
export interface MetricSource { metric: string; subject: string; agg: "daily_sum" | "window" }

export interface GoalTemplate {
  key: string;
  name: string;
  metricKey: string;        // the metric the goal TRACKS; its readings are Observations of this metric on the Goal
  unit: string;
  period: GoalPeriod;
  owner: AgentId;           // the roster agent that OWNS it
  priority: number;         // 1 primary, 2-3 secondary
  lift: number;             // target = baseline × (1 + lift), rounded up
  minTarget: number;        // the target when the baseline is unknown or zero
  why: string;
  sources: MetricSource[];
}

export interface IndustryTemplate { key: TemplateKey; name: string; matches: RegExp; goals: GoalTemplate[] }

const INSTAGRAM_REACH: GoalTemplate = {
  key: "instagram_reach", name: "Instagram reach", metricKey: "account_reach", unit: "accounts", period: "month",
  owner: "content-strategist", priority: 2, lift: 0.5, minTarget: 1000,
  why: "How many accounts saw the business on Instagram in the last 28 days: the top of every other number.",
  sources: [{ metric: "account_reach", subject: "channel:instagram", agg: "window" }],
};

const SEARCH_CLICKS: GoalTemplate = {
  key: "search_clicks", name: "Search clicks", metricKey: "gsc_clicks", unit: "clicks", period: "month",
  owner: "data-analyst", priority: 3, lift: 1, minTarget: 50,
  why: "Clicks from Google search to the website in the last 28 days: people who found the business by looking for it.",
  sources: [
    { metric: "gsc_clicks", subject: "channel:google-search", agg: "window" },
    { metric: "gsc_clicks", subject: "channel:website", agg: "window" },
  ],
};

export const TEMPLATES: readonly IndustryTemplate[] = [
  {
    key: "jobs_platform", name: "Jobs platform", matches: /\b(?:jobs?|hiring|recruit\w*|staffing|job board)\b/i,
    goals: [
      {
        key: "weekly_signups", name: "Weekly signups", metricKey: "new_accounts", unit: "signups", period: "week",
        owner: "growth-marketer", priority: 1, lift: 0.5, minTarget: 20,
        why: "New accounts in the last 7 complete days: the one number that says the marketplace is growing.",
        sources: [{ metric: "new_accounts", subject: "business", agg: "daily_sum" }, { metric: "signups", subject: "business", agg: "window" }],
      },
      INSTAGRAM_REACH,
      SEARCH_CLICKS,
    ],
  },
  {
    key: "architecture_studio", name: "Architecture and interiors studio", matches: /\b(?:architect\w*|interior\w*|design studio|atelier)\b/i,
    goals: [
      {
        key: "qualified_enquiries", name: "Qualified enquiries per month", metricKey: "enquiries", unit: "enquiries", period: "month",
        owner: "growth-marketer", priority: 1, lift: 0.5, minTarget: 8,
        why: "Project enquiries that fit the studio's work, in the last 28 days: the pipeline every project starts from.",
        sources: [
          { metric: "qualified_enquiries", subject: "business", agg: "window" },
          { metric: "enquiries", subject: "business", agg: "daily_sum" },
          { metric: "enquiries", subject: "business", agg: "window" },
          { metric: "leads", subject: "business", agg: "window" },
        ],
      },
      INSTAGRAM_REACH,
      SEARCH_CLICKS,
    ],
  },
  {
    key: "local_business", name: "Local business", matches: /.^/, // the fallback: matches nothing on its own
    goals: [
      {
        key: "enquiries", name: "Enquiries per month", metricKey: "enquiries", unit: "enquiries", period: "month",
        owner: "growth-marketer", priority: 1, lift: 0.5, minTarget: 10,
        why: "Calls, forms and messages from people who want to buy, in the last 28 days.",
        sources: [
          { metric: "enquiries", subject: "business", agg: "daily_sum" },
          { metric: "enquiries", subject: "business", agg: "window" },
          { metric: "leads", subject: "business", agg: "window" },
        ],
      },
      INSTAGRAM_REACH,
      SEARCH_CLICKS,
    ],
  },
];

export function templateByKey(key: string | undefined | null): IndustryTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

// The template for an industry ("jobs", "architecture and interior design studio"); local_business when none fits.
export function templateFor(industry: string | undefined | null): IndustryTemplate {
  const s = industry?.trim() ?? "";
  return (s && TEMPLATES.find((t) => t.matches.test(s))) || templateByKey("local_business")!;
}

// The template's target for a Day-0 baseline.
export function targetFor(t: Pick<GoalTemplate, "lift" | "minTarget">, baseline: number | null): { target: number; basis: "baseline" | "template" } {
  if (baseline === null || !(baseline > 0)) return { target: t.minTarget, basis: "template" };
  return { target: Math.ceil(baseline * (1 + t.lift)), basis: "baseline" };
}
