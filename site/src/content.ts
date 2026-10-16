// Copy and reference data the site needs that is not billing data. Every line traces to the product design spec
// (docs/superpowers/specs/2026-10-15-allevia-product-design.md) or to how the product works today; the section is noted
// beside each block. Prices, credits, allowances and guarantee numbers are NOT here: they come from shared/plans.ts. The
// team's size comes from the roster. The words follow docs/owner-words.md: plain, no "baseline", "Day 0" or "agent".
import { AGENTS } from "../../shared/roster.ts";

export { CONTACT_URL } from "./config.ts";

/** What each of the three steps is called, once, so the home page, the how-it-works page and the nav agree. */
export const STEPS = [
  {
    n: 1,
    title: "Paste your website",
    short: "We read it and learn your business.",
  },
  {
    n: 2,
    title: "Meet your team and approve your plan",
    short: "Three goals, in plain words. You tap OK or change a number.",
  },
  {
    n: 3,
    title: "Your team works and asks only when it matters",
    short: "You say OK or No to what is waiting. Nothing goes out without you.",
  },
] as const;

// §0.3: who does the work, in practice (in plain words; the machinery is unchanged, the owner sees what it means)
export const WHO_DOES_WHAT: { when: string; you: string; software: string; team: string }[] = [
  {
    when: "Setup",
    you: "Paste your website and say which country you are in. Say OK to the plan we propose, or change a number. An optional call connects your accounts.",
    software: `Reads your website, learns how you look and sound, and sets up your ${AGENTS.length} AI staff for your kind of business and your country.`,
    team: "We check the setup and finish the account connections with you, so you never fight with a settings screen.",
  },
  {
    when: "Every day",
    you: "Read Today's note, about a minute, and say OK or No to what is waiting.",
    software: "Watches your numbers, writes Today's note, drafts the posts and replies, and checks its own facts before you see anything.",
    team: "Nothing you need to see.",
  },
  {
    when: "Every week",
    you: "Look at the drafts your team made, and change any word you would not use.",
    software: "Plans the content, edits it in your voice, checks every claim against what it knows about you, and keeps your changes as rules for next time.",
    team: "A person looks over the first weeks of work, then a sample.",
  },
  {
    when: "Every month",
    you: "Read the month's check-in, a few minutes, and say if a goal should move.",
    software: "Compares each goal with where you started, adjusts what it works on, and writes one short note.",
    team: "A short review with you on the plans that include one.",
  },
  {
    when: "Upkeep",
    you: "Nothing.",
    software: "Keeps your connections healthy and re-runs its own checks whenever the AI model it uses changes.",
    team: "We reconnect anything that breaks and turn repeat problems into fixes.",
  },
];

// §3.2 the rhythm (the pricing page)
export const RHYTHM: { when: string; what: string; who: string; detail: string; time: string }[] = [
  { when: "Daily, 07:30 your time", what: "Today's note", who: "Meera writes, Isha checks the numbers", detail: "A line on how the week is going, at most 2 changes (each with the reason behind it), at most 3 one-tap approvals, and today's to-dos.", time: "≤ 90 s" },
  { when: "Monday, 08:00", what: "Monday pack", who: "Tara, then Dev, then Nisha", detail: "3 posts, 1 reel, 1 Google Business post and drafted review replies, each with a line on why.", time: "≤ 10 min" },
  { when: "Monday, same message", what: "Weekly growth review", who: "Kabir and Rohan, checked by Isha", detail: "What moved and why, how last week's experiment did, and 1–2 new ones.", time: "3 min" },
  { when: "First working day of the month", what: "Monthly report", who: "Isha (numbers), Meera (letter)", detail: "Goals against where you started, the work done, hours saved (with the assumptions laid out for you to edit), and what your team learned.", time: "≤ 15 min" },
  { when: "Each quarter", what: "Goal reset", who: "Meera and Isha", detail: "Next quarter's goals, approved with one tap.", time: "5 min" },
];

// §3.3 the growth plan's three months (the pricing page). `at` marks the checkpoints in plans.ts (0, 30, 60, 90).
export const PROGRAM_TIMELINE: { day: string; at: number; title: string; body: string }[] = [
  { day: "Start", at: 0, title: "Setup", body: "The 15-minute setup, then the optional 30-minute connect call. Your team learns your business, and your goals and where you started are written down." },
  { day: "Days 1–2", at: 1, title: "First note", body: "Your first Today's note arrives. The fixes found on your website are done or filed." },
  { day: "Week 1", at: 7, title: "First week of content", body: "Your first approved week of content. A person looks over the first four weeks, and every change you make becomes a rule." },
  { day: "Month 1", at: 30, title: "First check-in", body: "The first report and a 30-minute review with your Growth Partner." },
  { day: "Months 2 to 3", at: 60, title: "More on its own", body: "Your team earns a little more freedom, format by format. A campaign is planned for your next local season. Human checks drop to a sample." },
  { day: "Week 11", at: 75, title: "Wrap-up drafted", body: "An account-health check runs, and we step in if anything is off track. Your renewal notice follows at least 14 days ahead." },
  { day: "Month 3", at: 90, title: "Wrap-up", body: "Before and after on every goal, the 3 biggest wins with the evidence behind them, how many drafts you approved untouched, the rules learned and the hours saved." },
];

// §4.6 "1/20th of human cost": a loaded social-media-manager hire, per month, in local currency
export const HIRE_BASIS: { market: string; currency: "USD" | "GBP" | "AED" | "AUD"; monthly: number; basis: string; source?: { label: string; href: string }; estimate?: boolean }[] = [
  { market: "United States", currency: "USD", monthly: 6681, basis: "$64,139 a year × 1.25 for employer costs", source: { label: "Indeed", href: "https://www.indeed.com/salaries/Social-Media-Manager-Salaries" } },
  { market: "United Kingdom", currency: "GBP", monthly: 2931, basis: "£29,313 a year × 1.2 for employer costs", source: { label: "Payscale", href: "https://www.payscale.com/research/UK/Job=Social_Media_Manager/Salary" } },
  { market: "London", currency: "GBP", monthly: 5250, basis: "London salary level, loaded the same way", estimate: true },
  { market: "UAE", currency: "AED", monthly: 14400, basis: "Our estimate of a loaded monthly cost", estimate: true },
  { market: "Australia", currency: "AUD", monthly: 7312, basis: "Our estimate of a loaded monthly cost", estimate: true },
];

export interface FaqItem { q: string; a: string; topic: "start" | "control" | "data" | "money" | "limits" }

// Appendix A.1 and §1: the objections owners raise, answered with what the product does today. Where something is not
// built yet, the answer says so. The FAQ page, the home page's short list and the FAQPage structured data all read this.
export const FAQ: FaqItem[] = [
  {
    topic: "start",
    q: "Do I need to be technical?",
    a: "No. Setup asks for your website and your country. Your team talks to you in plain words, and anything that needs explaining sits behind a \"Show how\" button. We do the setup with you, so you never face a settings screen.",
  },
  {
    topic: "start",
    q: "What do you need from me to start?",
    a: "Your website address and your country. That is enough to build your team's picture of your business. An Instagram handle and your Google listing help, and an optional call connects the rest. You can also ask for a free Brain Snapshot first, before you pay anything.",
  },
  {
    topic: "start",
    q: "Is this another subscription that needs me?",
    a: "No. After setup your part is a short note each day and a few taps to say OK or No. The team's job is to keep itself running, not to give you a dashboard to babysit.",
  },
  {
    topic: "control",
    q: "Will it post something that embarrasses me?",
    a: "Nothing goes out without your OK. Today the team writes the drafts and saves them for you when you approve; it does not publish anything by itself. Posting straight to Instagram and Google comes later, after those companies approve us, and each post will still wait for your tap. Replies to reviews of three stars or lower, price and legal claims, and anything that spends money never go out on their own.",
  },
  {
    topic: "control",
    q: "How do I tell it what I want?",
    a: "In your own words, in the app or in Discord: \"No posts on Sundays\", \"push the new menu\". You see what will change before it does, and every change your team keeps is a rule you can read and switch off. When you edit a draft, your team keeps the edit as a rule for next time.",
  },
  {
    topic: "control",
    q: "What does it ask me about, and what does it just do?",
    a: "It asks first when something costs money, speaks in public or moves a goal. Everything else (reading your numbers, drafting, checking, planning) it does on its own and tells you in Today's note.",
  },
  {
    topic: "control",
    q: "How do I know the answers are right?",
    a: "Every answer shows its sources, and you can open the path your team followed. The numbers and the claims in an answer are checked against what the team actually looked up for that answer. Anything that fails the check carries a yellow \"unverified\" badge instead of being hidden.",
  },
  {
    topic: "data",
    q: "Is my business's data mixed with anyone else's?",
    a: "No. Each business is its own separate database, and nothing learned from one business is used for another. The only things every business shares are generic rule books, like search-engine checks, that contain no business's information.",
  },
  {
    topic: "data",
    q: "Where does my data live, and who can see it?",
    a: "On our servers, in your business's own database, with your photos in their own folder. We use an AI model (Claude, from Anthropic) to read and write, so the text and photos your team needs are sent there to get an answer. Our small team can open your workspace to set it up and to help you. The privacy policy lists every company that handles data for us.",
  },
  {
    topic: "data",
    q: "Which of my accounts will you connect to, and can it change anything?",
    a: "Your public website first. Connections to Instagram, Google Search Console, Google Analytics and your Google Business Profile are being built, and we will turn each on only after the platform approves us. They are read-only for numbers. Nothing is posted, replied to or changed in your accounts without your OK on that exact item.",
  },
  {
    topic: "data",
    q: "What if I want my data back, or gone?",
    a: "Ask by email and we send you a copy, or delete everything we hold about your business, usually within 30 days. Disconnecting Instagram or Google is also yours to do at any time, in their settings. The page \"Delete your data\" has the steps.",
  },
  {
    topic: "money",
    q: "You're a team in India I've never met, and you want money upfront.",
    a: "Fair, so the risk sits with us: a 14-day full refund, a day-30 delivery guarantee, a named Growth Partner on the plans that include one, and a free Brain Snapshot of your business before you pay anything. Being built and supported from India is why this costs a fraction of a local agency.",
  },
  {
    topic: "money",
    q: "Credits again? The last tool stopped working when I ran out.",
    a: "One unit, spent only when you approve a finished image or reel. Questions, notes, drafts, revisions, captions, review replies and reports never use credits. A rejected draft costs nothing, and a task can borrow from next month so nothing stops halfway.",
  },
  {
    topic: "limits",
    q: "Will it replace my marketing hire, or guarantee growth?",
    a: "We don't claim either. We guarantee what we control: the setup, the work delivered and the checks on it. If we miss the day-30 delivery bar, you get money back. We are not SOC 2 audited yet, and we won't say we are until we are.",
  },
  {
    topic: "limits",
    q: "What can't it do yet?",
    a: "It cannot publish to Instagram or Google by itself. Live AI picture edits for customers are not switched on yet (the studio gives you a cleaned-up version of your photo, and the AI edit shown on this site was made ahead of time for our trial). Reels need a person in an editor. Connections beyond your website are being built, so your goals show \"we'll know after your first full week\" until your own numbers arrive. There are no personal sign-in accounts yet: a business opens with its own private owner link.",
  },
  {
    topic: "limits",
    q: "Will it give legal, tax or medical advice?",
    a: "No. For legal, tax, moving money or medical questions, your team gives a polite no and says who to ask instead.",
  },
  {
    topic: "limits",
    q: "Who built it?",
    a: "A small team in India. Allevia was built with Aamdani and AVS Atelier as its first two businesses, and the first version was made during the Graph Hacks hackathon in October 2026.",
  },
];
