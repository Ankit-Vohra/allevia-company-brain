// What the prototypes say and show, as data. Everything about the sample business (Shiftly, a shift-jobs app) is the real graph of
// demo_growth (site/src/brain/brain-data.json, made-up data). Where an answer needs a number the graph does not hold, it does not
// give one. Words follow docs/owner-words.md: plain, short, no dashes as connectors.
import { BRAIN } from "./assets.generated.ts";

/** The team that orbits the brain, in the order they sit. `id` is the roster id (shared/roster.ts). */
export const TEAM = ["chief-of-staff", "data-analyst", "growth-marketer", "content-strategist", "sales-lead", "tech-lead", "oncall-engineer", "coe-lead"] as const;

/** The tools that orbit the brain (ids from shared/connection-map.ts). */
export const ORBIT_TOOLS = ["gmail", "google-calendar", "google-ads", "meta-ads", "google-analytics", "instagram", "shopify", "stripe", "hubspot", "slack", "whatsapp"] as const;

/** Every tool the team can connect to through Composio (shared/connection-map.ts), in four rows for the drifting chips. LinkedIn waits for a logo. */
export const CHIP_ROWS: string[][] = [
  ["gmail", "google-calendar", "google-analytics", "search-console", "google-sheets"],
  ["google-ads", "meta-ads", "instagram", "facebook-pages", "whatsapp"],
  ["shopify", "stripe", "hubspot", "mailchimp", "calendly"],
  ["slack", "zoho", "tiktok", "quickbooks", "xero"],
];

export interface Question {
  id: string;
  agent: string;               // roster id
  q: string;                   // what the founder asks, in their words
  tools: string[];             // the tools the brain reads for it (lit while it works)
  path: string[];              // real nodes of the sample business' graph the answer follows (BRAIN.labels)
  answer: string;              // short, from the brain
}

export const QUESTIONS: Question[] = [
  {
    id: "signups", agent: "data-analyst", q: "Why did sign-ups drop?", tools: ["google-analytics"],
    path: ["feature:seekers-signup-phone-number-entered", "page:screen/app/auth/sign-up", "event:sentry-issue-shiftly-41", "event:release-shiftly-2-8-0", "person:farhan"],
    answer: "The new phone box in release 2.8.0 crashes the sign-up screen. New accounts fell from about 238 to 51 a day on 7 October. Farhan owns the fix.",
  },
  {
    id: "ads", agent: "growth-marketer", q: "How are my ads doing this week?", tools: ["meta-ads", "google-ads"],
    path: ["campaign:meta-seekers-pune", "channel:meta-ads", "page:screen/app/auth/sign-up", "event:sentry-issue-shiftly-41"],
    answer: "The Pune ads still send people to the sign-up screen that crashes. Pause the spend until the fix, 2.8.1, is live. It waits for your OK.",
  },
  {
    id: "quote", agent: "sales-lead", q: "Who hasn’t replied to our quote?", tools: ["gmail", "hubspot"],
    path: ["lead:sana-sahyadrihotels-example", "deal:sana-sahyadrihotels-example", "lead:rohit-desaicaterers-example"],
    answer: "Sana at Sahyadri Hotels has an open quote and no call booked. I drafted a nudge for her. It waits for your OK.",
  },
  {
    id: "call", agent: "chief-of-staff", q: "Book a call with Sarah next week", tools: ["google-calendar", "gmail"],
    path: ["meeting:arjun-mehtalogistics-example-202610170530", "deal:arjun-mehtalogistics-example", "lead:arjun-mehtalogistics-example"],
    answer: "You are free Tuesday 4 pm and Thursday 11 am. I drafted the invite to Sarah with both. It waits for your OK.",
  },
  {
    id: "diwali", agent: "content-strategist", q: "What should we post for Diwali?", tools: ["instagram"],
    path: ["audience:seekers", "channel:app", "feature:job-alert-sms"],
    answer: "A short reel of three real shift stories from your workers, in Hindi and English. I drafted it. It waits for your OK.",
  },
  {
    id: "speed", agent: "tech-lead", q: "Is the website slow on phones?", tools: ["google-analytics"],
    path: ["channel:website", "channel:google-search", "task:ship-hotfix-2-8-1"],
    answer: "A little. Two big photos on the home page are most of the weight. I filed a fix. It waits for your OK.",
  },
];

export const labelOf = (id: string): string => (BRAIN.labels as Record<string, string>)[id] ?? id;

/** The founder's problems, then what comes back, for the many-to-many diagram. `logo` is the tool the outcome happened in. */
export const PROBLEMS = [
  "Ads spend up, leads down",
  "Reply to 6 enquiries",
  "Post for Diwali",
  "Website slow on phones",
  "Who owns the app crash?",
  "Book a call with Sarah",
] as const;

export const OUTCOMES: { logo: string; title: string; line: string }[] = [
  { logo: "google-ads", title: "Paused 2 keywords wasting $120", line: "Google Ads, after your OK" },
  { logo: "gmail", title: "Reply sent to 6 leads", line: "Gmail, from your address" },
  { logo: "instagram", title: "Diwali post scheduled", line: "Instagram, Thursday 6 pm" },
  { logo: "github", title: "Fix filed for the slow photos", line: "Ready for your developer" },
  { logo: "github", title: "Fix filed for the sign-up crash", line: "Owner: Farhan" },
  { logo: "google-calendar", title: "Meeting booked with Sarah", line: "Tuesday, 4 pm" },
];

/** The noise a founder carries (the problem scene): what piles up, in four kinds. */
export const NOISE = {
  people: ["Sarah: any update on the quote?", "Agency: need your approval", "Supplier: invoice 2 weeks late", "Staff: who covers Saturday?", "Customer: still no reply", "Meghna: can we talk Monday?"],
  tools: ["google-ads", "google-analytics", "instagram", "gmail", "google-calendar", "shopify", "hubspot", "slack", "whatsapp", "stripe"],
  memory: ["Promised Sarah a quote by Friday", "Why did we pause the ads?", "What changed last week?", "Who agreed the discount?"],
  alerts: ["47 unread", "Ads: cost per lead up", "Crash: sign-up", "3 meetings today", "Review waiting", "Payment failed"],
};

/** The answers the noise becomes. */
export const CALM = [
  { who: "data-analyst", title: "Sign-ups fell on 7 October", line: "A crash in release 2.8.0. Fix is built, waiting for the stores." },
  { who: "sales-lead", title: "Reply to Sana", line: "Draft ready. Waiting for your OK." },
  { who: "content-strategist", title: "Diwali post", line: "Reel drafted in Hindi and English. Waiting for your OK." },
];

export const BRAIN_COUNTS = BRAIN.counts;
