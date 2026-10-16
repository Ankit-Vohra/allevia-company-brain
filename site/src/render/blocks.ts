// Build-time HTML for the parts of the site that come from data: the plans and prices (shared/plans.ts), the FAQ and the
// security promises. vite.config.ts swaps each `<!-- @render name -->` comment in the pages for the matching block below,
// so the shipped HTML is complete without JavaScript and a price can never drift from shared/plans.ts. Prices are shown
// in US dollars only.
import { ALLEVIA_90, CREDIT_COSTS, PLANS, PLAN_BY_ID, type Plan } from "../../../shared/plans.ts";
import { AGENTS, numberWord } from "../../../shared/roster.ts";
import { COMMITMENTS } from "../company.ts";
import { CONTACT_URL } from "../config.ts";
import { FAQ, type FaqItem } from "../content.ts";
import { footer, masthead } from "./chrome.ts";
import { LEGAL_BLOCKS } from "./legal.ts";
import { PAGE_BLOCKS } from "./pages-copy.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const P90 = ALLEVIA_90;

/** Words the static pages say about the team's size, swapped in at build time (vite.config.ts) from the roster. */
export const PAGE_TOKENS: Record<string, string> = {
  __STAFF_COUNT__: String(AGENTS.length),
  __STAFF_WORD__: numberWord(AGENTS.length),
};
/** "Up to 50 posts or 12 reels" for a monthly allowance of Studio credits. */
export function postsAndReels(credits: number): string {
  return `Up to ${Math.floor(credits / CREDIT_COSTS.static_post)} posts or ${Math.floor(credits / CREDIT_COSTS.reel)} reels`;
}

// ---------- pricing ----------

/** The one line about the three-month start. */
export function startLine(): string {
  return `<p class="startline"><strong>Start with a three-month growth plan:</strong> <span class="money">${usd(P90.upfront.USD)}</span>, or ${P90.instalments.count} payments of <span class="money">${usd(P90.instalments.each.USD)}</span>. ${P90.guarantees.refundDays}-day full refund.</p>`;
}

/** One line for the home page: the price and the way in. */
export function priceLine(): string {
  const g = PLAN_BY_ID.growth;
  return `<p class="priceline">Plans from <span class="money">${usd(g.price.monthly.USD)}</span> a month after a three-month start. ${P90.guarantees.refundDays}-day full refund.</p>`;
}

/** What each plan includes, as short lines. */
function planLines(p: Plan): string[] {
  const a = p.allowances;
  if (p.id === "pause") return ["Weekly summary", "Review alerts", `${a.answersPerMonth} questions a month`];
  const lines = [postsAndReels(a.studioCreditsPerMonth), `${a.answersPerMonth} questions a month`];
  lines.push(a.locations && a.locations > 1 ? `Up to ${a.locations} locations, ${a.seats} seats` : `${a.locations} location, ${a.seats} seats`);
  if (p.id === "growth") lines.push("A named person reviews your plan each month");
  if (p.id === "pro") lines.push("A strategist two hours a month");
  return lines;
}

export function plans(): string {
  const cols = PLANS.map((p) => {
    const note = p.isDefault ? "Most people start here" : p.graduatesOnly ? "After the three-month plan" : "&nbsp;";
    return `<article class="plan${p.isDefault ? " plan--default" : ""}" aria-labelledby="plan-${p.id}">
  <h3 class="plan__name" id="plan-${p.id}">${esc(p.name)}</h3>
  <p class="plan__note">${note}</p>
  <p class="plan__price"><span class="money">${usd(p.price.monthly.USD)}</span><span class="per"> a month</span></p>
  <ul class="plan__lines">${planLines(p).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
  <a class="btn ${p.isDefault ? "btn-gold" : "btn-ghost"}" href="${CONTACT_URL}">Get started<span class="visually-hidden"> with ${esc(p.name)}</span></a>
</article>`;
  }).join("");
  return `<div class="plans">${cols}</div>`;
}

/** The small print, kept in one closed expander. */
export function smallPrint(): string {
  const g = P90.guarantees;
  return `<details class="smallprint"><summary>The small print</summary>
<ul>
<li>${g.refundDays}-day full refund on the three-month plan. If we miss the day-${g.deliveryDay} delivery promise, you get the remaining two-thirds back.</li>
<li>Posts and reels use a credit when you approve them. Unused credits roll over for one month.</li>
<li>Monthly plans end when the month does. Annual plans can be refunded pro rata within 30 days.</li>
<li>Prices are in US dollars and exclude tax. Full details are in the <a href="/terms/#fees">Terms of Service</a>.</li>
</ul></details>`;
}

// ---------- questions ----------

const faqItem = (f: FaqItem) => `<details><summary><h3>${esc(f.q)}</h3></summary><p>${esc(f.a)}</p></details>`;

export function faqAll(): string {
  return `<div class="faq">${FAQ.map(faqItem).join("")}</div>`;
}

/** The three short questions shown on the pricing page. */
export function faqPricing(): string {
  const pick = ["What if it does not work for me?", "Will it post something that embarrasses me?", "Will it replace my marketing person, or guarantee growth?"];
  return `<div class="faq">${FAQ.filter((f) => pick.includes(f.q)).map(faqItem).join("")}</div>`;
}

// ---------- security ----------

const ICONS: Record<string, string> = {
  vault: `<rect x="5" y="9" width="30" height="24" rx="3"/><circle cx="20" cy="21" r="5"/><path d="M20 16v10M15 21h10"/><path d="M11 33v3M29 33v3"/>`,
  tap: `<path d="M12 22l5 5 11-13"/><rect x="5" y="6" width="30" height="28" rx="4"/>`,
  shield: `<path d="M20 5l13 5v9c0 8-5 13-13 16C12 32 7 27 7 19v-9z"/><path d="M14 20l4 4 8-9"/>`,
  door: `<path d="M9 34V6h16v28"/><path d="M5 34h30"/><circle cx="21" cy="21" r="1.4"/><path d="M28 17l6 4-6 4M34 21H26"/>`,
};
const icon = (name: string) => `<svg class="promise__icon" viewBox="0 0 40 40" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

export function securityPromises(): string {
  const items: [string, string, string][] = [
    ["vault", "Your own database", "Your business is kept apart from every other business. Nothing is shared."],
    ["tap", "Nothing goes out without your OK", "Your team drafts. You approve. Allevia posts nothing itself."],
    ["shield", "Private details stay private", "Passwords, card and phone numbers are removed before text reaches the AI. Photos lose their location."],
    ["door", "You can leave", `Ask, and we send you a copy of your data or delete it within ${COMMITMENTS.deleteWithinDays} days.`],
  ];
  return `<ul class="promises">${items.map(([i, h, p]) => `<li class="promise">${icon(i)}<h2 class="promise__h">${esc(h)}</h2><p>${esc(p)}</p></li>`).join("")}</ul>`;
}

/** Every block takes the path of the page it is rendered into (the masthead and the footer mark the current page). */
export const BLOCKS: Record<string, (current: string) => string> = {
  masthead: (cur) => masthead(cur),
  footer: (cur) => footer(cur),
  "start-line": startLine,
  "price-line": priceLine,
  plans,
  "small-print": smallPrint,
  "faq-all": faqAll,
  "faq-pricing": faqPricing,
  "security-promises": securityPromises,
  ...PAGE_BLOCKS,
  ...LEGAL_BLOCKS,
};
