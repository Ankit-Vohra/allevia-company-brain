// Copy and reference data the site needs that is not billing data. Every line traces to the product design spec
// (docs/superpowers/specs/2026-10-15-allevia-product-design.md); the section is noted beside each block. Prices, credits,
// allowances and guarantee numbers are NOT here: they come from shared/plans.ts.

/** Where every "Get a Brain Snapshot" button goes. The founder sets the real destination before launch. */
export const CONTACT_URL = "https://allevia-ai.in/#contact";

// §0.3: who does the work, in practice
export const WHO_DOES_WHAT: { when: string; you: string; software: string; team: string }[] = [
  {
    when: "Setup, day 0",
    you: "A 15-minute setup: your website, Instagram handle, Google listing and country. You confirm about 15 brand cards and pick 1–3 goals. An optional 30-minute call, in your time zone, connects the rest.",
    software: "Reads your site and public profiles and builds your company brain. Drafts your brand kit, records today's numbers as the baseline, sets up the 10 staff for your industry and country, and runs a Health Check.",
    team: "Our Setup Desk spends about 45 minutes on it within 24 hours: checks the brand kit, answers compliance questions and finishes the account connections with you.",
  },
  {
    when: "Every day",
    you: "Read the morning brief, at most 90 seconds, and tap up to 3 approvals.",
    software: "Watches your numbers, writes the brief and the alerts, drafts review replies and follow-ups.",
    team: "Nothing you need to see.",
  },
  {
    when: "Every week",
    you: "Approve the Monday pack: about 10 minutes.",
    software: "Content on autopilot (Tara plans, Dev edits, Nisha checks the facts) and a weekly growth review.",
    team: "A person checks everything in weeks 1–4, then a 20% sample.",
  },
  {
    when: "Monthly and quarterly",
    you: "Read the report, about 15 minutes, and approve next quarter's goals.",
    software: "Scorecard, what it learned, and the next autonomy step it has earned.",
    team: "A 30-minute review with your Growth Partner on Growth; a live call on Pro.",
  },
  {
    when: "Upkeep",
    you: "Nothing.",
    software: "Keeps connections healthy, renews access, re-runs its own checks whenever a model changes.",
    team: "Reconnects broken accounts, re-tunes, and turns repeat problems into product fixes.",
  },
];

// §0.3 "Promises we can keep" (the photo-draft promise waits for the Studio)
export const FIRST_WEEK_PROMISES = [
  "A Health Check with 5 ranked fixes within 10 minutes of setup",
  "Your first Monday pack within 48 hours",
  "Every capability working, or its fallback explained, within 7 days",
];

// §3.2 the rhythm
export const RHYTHM: { when: string; what: string; who: string; detail: string; time: string }[] = [
  { when: "Daily, 07:30 your time", what: "Morning brief", who: "Meera writes, Isha checks the numbers", detail: "A goal-pulse line, at most 2 changes (each with the reason behind it), at most 3 one-tap approvals, and today's to-dos.", time: "≤ 90 s" },
  { when: "Monday, 08:00", what: "Monday pack", who: "Tara, then Dev, then Nisha", detail: "3 posts, 1 reel, 1 Google Business post and drafted review replies, each with a line on why.", time: "≤ 10 min" },
  { when: "Monday, same message", what: "Weekly growth review", who: "Kabir and Rohan, checked by Isha", detail: "What moved and why, how last week's experiment did, and 1–2 new ones.", time: "3 min" },
  { when: "First working day of the month", what: "Monthly report", who: "Isha (numbers), Meera (letter)", detail: "Goals against your day-0 baseline, the work done, hours saved (with the assumptions laid out for you to edit), and what Allevia learned.", time: "≤ 15 min" },
  { when: "Each quarter", what: "Goal reset", who: "Meera and Isha", detail: "Next quarter's targets, approved with one tap.", time: "5 min" },
];

// §3.3 the Allevia 90 timeline. `checkpoint` marks the Checkpoint{day} nodes in plans.ts (0, 30, 60, 90).
export const PROGRAM_TIMELINE: { day: string; at: number; title: string; body: string }[] = [
  { day: "Day 0", at: 0, title: "Setup", body: "The 15-minute setup, then the optional 30-minute connect call. Your company brain is built; your goals and today's numbers are locked in as the baseline." },
  { day: "Days 1–2", at: 1, title: "First brief", body: "Your first morning brief arrives. The Health Check fixes are shipped or filed." },
  { day: "Day 7", at: 7, title: "First content week", body: "Your first approved week of content. A person checks everything in weeks 1–4, and every edit you make becomes a rule." },
  { day: "Day 30", at: 30, title: "Report #1", body: "The first report and a 30-minute review with your Growth Partner." },
  { day: "Days 45–60", at: 60, title: "Earned autonomy", body: "The first autonomy step becomes possible. A campaign is planned for your next local season. Human checks drop to a 20% sample." },
  { day: "Day 75", at: 75, title: "Graduation report drafted", body: "An account-health check runs, and we step in if anything is off track. Your renewal notice follows at least 14 days ahead." },
  { day: "Day 90", at: 90, title: "Graduation", body: "Before and after on every goal, the 3 biggest wins with the evidence behind them, the first-pass curve, the rules learned and the hours saved." },
];

// §4.6 "1/20th of human cost": a loaded social-media-manager hire, per month, in local currency
export const HIRE_BASIS: { market: string; currency: "USD" | "GBP" | "AED" | "AUD"; monthly: number; basis: string; source?: { label: string; href: string }; estimate?: boolean }[] = [
  { market: "United States", currency: "USD", monthly: 6681, basis: "$64,139 a year × 1.25 for employer costs", source: { label: "Indeed", href: "https://www.indeed.com/salaries/Social-Media-Manager-Salaries" } },
  { market: "United Kingdom", currency: "GBP", monthly: 2931, basis: "£29,313 a year × 1.2 for employer costs", source: { label: "Payscale", href: "https://www.payscale.com/research/UK/Job=Social_Media_Manager/Salary" } },
  { market: "London", currency: "GBP", monthly: 5250, basis: "London salary level, loaded the same way", estimate: true },
  { market: "UAE", currency: "AED", monthly: 14400, basis: "Our estimate of a loaded monthly cost", estimate: true },
  { market: "Australia", currency: "AUD", monthly: 7312, basis: "Our estimate of a loaded monthly cost", estimate: true },
];

// Appendix A.1 and §1: the objections owners raise, answered with what the product does
export const FAQ: { q: string; a: string }[] = [
  {
    q: "Is this another subscription that needs me?",
    a: "No. Setup asks for your website, Instagram handle, Google listing and country, and nothing else is required. You don't connect accounts yourself: our Setup Desk does it with you on an optional 30-minute call in your time zone. After that, your part is a morning brief of at most 90 seconds and about 10 minutes on Mondays.",
  },
  {
    q: "You're a team in India I've never met, and you want money upfront.",
    a: "Fair, so the risk sits with us: a 14-day full refund with no questions, a day-30 delivery guarantee, a named Growth Partner, and a free Brain Snapshot of your business before you pay anything. Being built and supported from India is why this costs a fraction of a local agency.",
  },
  {
    q: "Will it post something that embarrasses me?",
    a: "Nothing leaves without your tap. The team earns autonomy one format at a time: at least 20 approvals in that format, at least 85% of them approved without edits, and no compliance or fidelity failures. Even then, you accept the step. Replies to reviews of 3 stars or lower, price and legal claims, and ad spend above a cap never go out on their own.",
  },
  {
    q: "What happens when Instagram logs it out?",
    a: "It slows down visibly, never silently. A nightly check notices, the work falls back to the next-best source and says so in its answers, Vikram puts \"reconnect\" in your morning brief, and your Growth Partner picks it up by your next morning.",
  },
  {
    q: "Credits again? The last tool stopped working when I ran out.",
    a: "One unit, spent only when you approve a finished image or reel. Questions, briefs, drafts, revisions, captions, review replies and reports never use credits. A rejected draft costs nothing, and a task can borrow from next month so nothing stops halfway.",
  },
  {
    q: "Will it replace my marketing hire, or guarantee growth?",
    a: "We don't claim either. We guarantee what we control: the setup, the work delivered and the checks on it. If we miss the day-30 delivery bar, you get money back. We are not SOC 2 audited yet, and we won't say we are until we are.",
  },
  {
    q: "Is my business's data mixed with anyone else's?",
    a: "No. Each business has its own graph, and nothing learned from one business is used for another.",
  },
  {
    q: "Who built it?",
    a: "A small team in India. Allevia was built with Aamdani and AVS Atelier as its first businesses.",
  },
];
