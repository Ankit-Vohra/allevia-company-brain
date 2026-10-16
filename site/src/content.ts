// What the site says that is not billing data. Prices, plans and guarantee numbers come from shared/plans.ts. The words
// follow docs/owner-words.md: plain, short, no "baseline", "Day 0" or "agent". Where something is not built yet, the
// line says so (the FAQ page and its structured data read this list).

export { CONTACT_URL } from "./config.ts";

export interface FaqItem { q: string; a: string }

export const FAQ: FaqItem[] = [
  {
    q: "Do I need to be technical?",
    a: "No. You paste your website and we do the setup with you, so you never face a settings screen.",
  },
  {
    q: "Will it post something that embarrasses me?",
    a: "Nothing goes out without your OK, and Allevia does not publish anything itself: when you approve a draft, it is saved for you to post. Replies to reviews of three stars or lower, price claims and anything that spends money never go out on their own.",
  },
  {
    q: "Is my data mixed with other businesses'?",
    a: "No. Each business has its own separate database, and nothing learned from one is used for another.",
  },
  {
    q: "What if it does not work for me?",
    a: "You get a 14-day full refund, and the remaining two-thirds of the three months back if we miss our day-30 delivery promise. You can also ask for a free Brain Snapshot first, before you pay anything.",
  },
  {
    q: "Will it replace my marketing person, or guarantee growth?",
    a: "No to both. We promise the setup and the work delivered, never revenue or growth.",
  },
  {
    q: "What can it not do yet?",
    a: "It cannot post to Instagram or Google for you, and for now it works from your website and any spreadsheet you drop in. Connections to Instagram and Google are being built.",
  },
];
