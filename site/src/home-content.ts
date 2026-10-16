// What the home page says, as data, so tests can hold it to the code and the records it describes. The home page is one
// story about one thing: the company brain. Every line is short, plain and in the owner's words (docs/owner-words.md,
// checked against the humanizer rules: no "not X but Y", no staged openers, no dashes as connectors, no tricolons for show).
// Numbers on the page are the app's own sample numbers (web/src/mock/program.ts) or come from the real run recorded for the
// scene (src/brain/run.json), and are labelled "sample numbers" where they show.

/** The stops on the courier route (the slim strip at the bottom of the home page). `id` is the section's id. */
export const ROUTE = [
  { id: "brain", name: "Brain" },
  { id: "ask", name: "Ask" },
  { id: "made", name: "Made" },
  { id: "ok", name: "OK" },
  { id: "plan", name: "Plan" },
  { id: "begin", name: "Start" },
] as const;

/** The tools that snap into the brain. `feeds` are the ones the sample business has connected; the rest show what else can join. */
export const TOOLS: { id: string; name: string; dock?: "gmail" | "calendar" | "analytics" | "ads" | "files" }[] = [
  { id: "gmail", name: "Gmail", dock: "gmail" },
  { id: "calendar", name: "Calendar", dock: "calendar" },
  { id: "analytics", name: "Analytics", dock: "analytics" },
  { id: "meta-ads", name: "Meta Ads", dock: "ads" },
  { id: "instagram", name: "Instagram" },
  { id: "shopify", name: "Shopify" },
  { id: "stripe", name: "Stripe" },
  { id: "hubspot", name: "HubSpot" },
  { id: "slack", name: "Slack" },
  { id: "whatsapp", name: "WhatsApp" },
];

export const COPY = {
  hero: {
    h1: "A brain for your business, and a team that works from it.",
    p: "Paste your website. {STAFF} AI staff learn your business, use your tools, and ask before anything goes out.",
    cta: "Get a free Brain Snapshot",
    more: "See how it works",
    cap: "The brain of a sample business. Made-up data.",
  },
  brain: {
    h2a: "Paste your website.",
    h2b: "Your brain starts.",
    p: "Your team reads your pages and learns what you sell, who for and how you sound. Every fact keeps its source.",
    h2c: "Connect your tools.",
    h2d: "It grows.",
    p2: "Gmail, Calendar, Analytics, Ads, Instagram, Shopify and more. Reading is instant. Anything that sends or spends waits for your OK.",
    things: "things your team knows",
    links: "links",
    cap: "A sample business: Shiftly, a shift-jobs app. Made-up data.",
  },
  ask: {
    h2a: "Ask why.",
    h2b: "The team goes looking.",
    q: "Why did sign-ups drop this week, and what should we do?",
    s1: "Meera splits the question and sends four colleagues into the brain.",
    s2: "Each reads what it holds: the numbers, the crashes, the releases, what you decided before.",
    s3: "The answer comes back with its path, and two things wait for your OK.",
    cap: "A real run on the sample business, recorded in the app. Made-up data.",
  },
  made: {
    h2a: "They make things.",
    h2b: "Each one waits for you.",
    items: [
      { id: "ad", what: "An ad from the studio's photos", who: "Tara" },
      { id: "poster", what: "A launch poster in Hindi", who: "Tara" },
      { id: "reply", what: "A reply with three times", who: "Neel" },
      { id: "fix", what: "A fix for the website", who: "Zoya" },
    ],
  },
  ok: {
    h2a: "You tap OK.",
    h2b: "In the app or in Discord.",
    p: "Approve, change or say no thanks. Nothing goes out before that.",
    web: "In the app",
    discord: "In Discord",
  },
  plan: {
    h2a: "Your plan moves.",
    h2b: "Three goals, one bar each.",
    label: "Your growth plan · Month 1, week 4",
  },
  close: {
    price: "Plans from {PRICE} a month, after a three-month start. 14-day refund.",
    priceLink: "See the plans",
    h2: "Start with a free Brain Snapshot.",
    p: "Send us your website. We send back what we learned and five fixes, before you pay.",
    cta: "Get a free Brain Snapshot",
  },
} as const;

/** The growth plan's sample numbers (web/src/mock/program.ts, Aamdani): where it started, where it is, the goal. */
export const PLAN_SAMPLE: { name: string; unit: string; from: number; now: number; goal: number; status: string; who: string }[] = [
  { name: "Weekly signups", unit: "a week", from: 264, now: 312, goal: 360, status: "Going well", who: "Rohan" },
  { name: "Instagram reach", unit: "accounts a month", from: 52_400, now: 61_900, goal: 78_600, status: "Going well", who: "Tara" },
  { name: "Search clicks", unit: "clicks a month", from: 9_800, now: 10_100, goal: 12_700, status: "Needs a push", who: "Kabir" },
];
