// Who picks up a meeting's action item (a Task has one current owner in the graph, so exactly one):
//   - the other side's own promise ("Ritika confirms the billing address") stays with that person; Taskmaster keeps it on the list;
//   - work that is plainly one desk's job goes to that AI teammate, by the hand-off rules every agent is told (src/agent/jobs.ts):
//     quotes, agreements and follow-ups to Deal Closer, a broken checkout or page to Techie, a post or a reel to Miss Influencer,
//     ads and offers to Growth Hacker, figures to Number Cruncher, and so on; it lands on their to-do list and they draft it for the
//     owner's OK (the colleague who said they would do it is named on the task);
//   - anything else the business itself will do (deliveries, bookings, invoices, reminders) goes to Taskmaster, unless a named
//     colleague said they would do it: then it is that person's.
// Plain rules, no model: the same words always go to the same desk, and a test can say so.
import { agentById } from "../../shared/roster.js";

export interface Routed { agent: string; why: string; matched: boolean }

// First match wins, so the narrow desks come before the broad ones ("fix the checkout release" is Bug Hunter's release, "send the
// quote for the app" is still a quote, "fix the coupon at checkout" is Techie's fix, not an offer).
const RULES: Array<{ agent: string; words: RegExp; why: string }> = [
  { agent: "oncall-engineer", words: /\b(?:outages?|crash(?:es|ed|ing)?|(?:site|app|server) (?:is |was |goes )?down|error rate|incidents?|uptime)\b/i, why: "errors, crashes and uptime are Firefighter's" },
  { agent: "qa-release", words: /\b(?:releases?|app store|play store|testflight|store review|app rating|new build)\b/i, why: "app releases and store reviews are Bug Hunter's" },
  { agent: "sales-lead", words: /\b(?:quotes?|quotation|proposals?|price list|pricing|agreements?|contracts?|follow[- ]?ups?|follow up|sample packs?|send (?:the |a |our )?samples?|deals?|leads?|pitch|enquir(?:y|ies)|brochure|deck)\b/i, why: "quotes, agreements and follow-ups with customers are Deal Closer's" },
  { agent: "tech-lead", words: /\b(?:fix(?:ed|es|ing)?|bugs?|broken|checkout|errors?|payment gateway|integrations?|api)\b/i, why: "the website and app, and fixing them, are Techie's" },
  { agent: "content-strategist", words: /\b(?:posts?|reels?|captions?|instagram|linkedin|tiktok|content|blog|newsletter|stor(?:y|ies)|videos?|photo ?shoot|shoot)\b/i, why: "posts, reels and the content plan are Miss Influencer's" },
  { agent: "growth-marketer", words: /\b(?:ads?|adverts?|campaigns?|ad budget|budget|promotions?|promo|offers?|discounts?|coupons?|seo strategy|marketing)\b/i, why: "ads, campaigns and offers are Growth Hacker's" },
  { agent: "tech-lead", words: /\b(?:website|web ?site|pages?|landing page|apps?|technical|tech|seo)\b/i, why: "the website and app, and fixing them, are Techie's" },
  { agent: "coe-lead", words: /\b(?:numbers|figures|reports?|revenue|forecasts?|metrics|dashboards?|p&l|margins?|kpis?)\b/i, why: "the key numbers and reports are Number Cruncher's" },
  { agent: "data-analyst", words: /\b(?:analy[sz]e|analysis|investigate|traffic|funnel|conversion|drop-?offs?|why .{0,40} (?:dropped|fell|rose))\b/i, why: "why a number moved is Data Detective's" },
  { agent: "librarian", words: /\b(?:write up|minutes|document (?:the|our|what)|record (?:the|what))\b/i, why: "the company memory is Memory Keeper's" },
];
const DEFAULT: Routed = { agent: "ops-manager", why: "deliveries, bookings, invoices and reminders are Taskmaster's", matched: false };

/** The AI teammate for something the business will do. Always one: Taskmaster when no other desk's words are in it. */
export function routeTask(text: string): Routed {
  for (const r of RULES) if (r.words.test(text)) return { agent: r.agent, why: r.why, matched: true };
  return DEFAULT;
}

/**
 * The AI teammate who owns the item, or null when a person keeps it: the other side's promise (side "them"), or a named colleague's
 * item that is no desk's plain job. `person` is false when nobody was named ("us", the business).
 */
export function routeAction(o: { text: string; side: "us" | "them" | "unknown"; person: boolean }): Routed | null {
  if (o.side === "them") return null;
  const r = routeTask(o.text);
  return r.matched || !o.person ? r : null;
}

export const agentName = (id: string): string => agentById(id)?.name ?? id;
