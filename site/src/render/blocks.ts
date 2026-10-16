// Build-time HTML for the parts of the site that come from data: plans, prices, credits, the program, the roster.
// vite.config.ts swaps each `<!-- @render name -->` comment in the pages for the matching block below, so the shipped
// HTML is complete without JavaScript and a price can never drift from shared/plans.ts.
import { ALLEVIA_90, CREDIT_COSTS, CREDIT_RULES, CURRENCIES, PLANS, PLAN_BY_ID, type Plan } from "../../../shared/plans.ts";
import { AGENTS, DEPARTMENTS, numberWord } from "../../../shared/roster.ts";
import { FAQ, HIRE_BASIS, PROGRAM_TIMELINE, RHYTHM, WHO_DOES_WHAT, type FaqItem } from "../content.ts";
import { CURRENCY_LABEL, formatMoney, moneySpan } from "../money.ts";
import { spriteSvg } from "./sprites.ts";
import { footer, masthead } from "./chrome.ts";
import { LEGAL_BLOCKS } from "./legal.ts";
import { PAGE_BLOCKS } from "./pages-copy.ts";
import { STORY_BLOCKS } from "./story.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const P = PLAN_BY_ID;
const P90 = ALLEVIA_90;

// ---------- credits, said as posts and reels ----------

const REEL = CREDIT_COSTS.reel;
const POST = CREDIT_COSTS.static_post;

/** "50 posts, or 12 reels, or any mix" for a monthly allowance of Studio credits. */
export function postsAndReels(credits: number): string {
  if (credits === 0) return "None: the brain, the weekly brief and review alerts keep running";
  return `Up to ${Math.floor(credits / POST)} posts, or ${Math.floor(credits / REEL)} reels, or any mix`;
}

function sourcesText(p: Plan): string {
  const s = p.allowances.sources;
  const NAMES: Record<string, string> = { site: "website", instagram: "Instagram", gbp: "Google Business Profile" };
  if (s.kind === "all") return "Every source you use";
  if (s.kind === "read_only") return "Kept, read-only";
  return `${s.max}: ${s.names.map((n) => NAMES[n] ?? n).join(", ")}`;
}

/** Plan extras carry a "(Phase N)" note in the data; say it in owner words. */
function extraHtml(e: string): string {
  const m = e.match(/^(.*?)\s*\(Phase (\d)\)$/);
  if (!m) return esc(e);
  return `${esc(m[1]!)} <span class="tag">${m[2] === "2" ? "coming soon" : "planned"}</span>`;
}

const rhythmHtml = (p: Plan) =>
  esc(p.rhythm.replace(/\s*\(§[\d.]+\)/, "")).replace("The full operating rhythm", `The <a href="#rhythm">full rhythm</a>`);

// ---------- shared pieces ----------

const cap = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
/** Words the static pages say about the team's size, swapped in at build time (vite.config.ts) from the roster. */
export const PAGE_TOKENS: Record<string, string> = {
  __STAFF_COUNT__: String(AGENTS.length),
  __DEPARTMENT_COUNT__: String(DEPARTMENTS.length),
  __STAFF_WORD__: numberWord(AGENTS.length),
  __STAFF_WORD_CAP__: cap(numberWord(AGENTS.length)),
  __DEPARTMENT_WORD__: numberWord(DEPARTMENTS.length),
};

export function currencyToggle(id: string): string {
  const opts = CURRENCIES.map(
    (c, i) =>
      `<label class="seg"><input type="radio" name="currency-${id}" value="${c}"${i === 0 ? " checked" : ""} data-currency-input><span>${c}</span><span class="visually-hidden"> (${CURRENCY_LABEL[c]})</span></label>`,
  ).join("");
  return `<fieldset class="currency" data-currency-toggle><legend>Prices in</legend><div class="segs">${opts}</div></fieldset>`;
}

// ---------- home ----------

export function whoDoesWhat(): string {
  const rows = WHO_DOES_WHAT.map(
    (r) => `<tr><th scope="row">${esc(r.when)}</th><td data-label="You">${esc(r.you)}</td><td data-label="Your AI team">${esc(r.software)}</td><td data-label="Our people">${esc(r.team)}</td></tr>`,
  ).join("");
  return `<table class="ledger ledger--who"><caption class="visually-hidden">Who does the work, from setup to upkeep</caption><thead><tr><th scope="col"><span class="visually-hidden">When</span></th><th scope="col">You</th><th scope="col">Your AI team</th><th scope="col">Our people, in India</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function team(): string {
  const rooms = DEPARTMENTS.map((d) => {
    const staff = AGENTS.filter((a) => a.department === d.id)
      .map(
        (a) => `<li class="staff">${spriteSvg(a.id, { size: 40, portrait: true })}<div><p class="staff__name"><strong>${esc(a.name)}</strong> <span>${esc(a.title)}</span></p><p class="staff__persona">${esc(a.persona)}</p></div></li>`,
      )
      .join("");
    const wide = AGENTS.filter((a) => a.department === d.id).length > 1 ? " room--wide" : "";
    return `<section class="room${wide}" style="--hue:${d.hue}" aria-labelledby="dept-${d.id}"><h3 class="room__name" id="dept-${d.id}">${esc(d.name)}</h3><p class="room__blurb">${esc(d.blurb)}</p><ul class="room__staff">${staff}</ul></section>`;
  }).join("");
  return `<div class="floor">${rooms}</div>`;
}

export function teamStrip(): string {
  return `<div class="strip" aria-hidden="true">${AGENTS.map((a) => spriteSvg(a.id, { size: 32, portrait: true })).join("")}</div>`;
}

/** The Allevia 90 timeline. Compact: the four checkpoints (plans.ts checkpointDays) on one line. Full: every step. */
export function programTimeline(variant: "compact" | "full"): string {
  if (variant === "compact") {
    const items = P90.checkpointDays.map((d) => {
      const e = PROGRAM_TIMELINE.find((t) => t.at === d);
      if (!e) throw new Error(`site: no timeline entry for checkpoint day ${d}`);
      const end = d === P90.days ? " cp--end" : "";
      return `<li class="cp${end}"><p class="cp__day">${esc(e.day)}</p><h3 class="cp__title">${esc(e.title)}</h3><p class="cp__body">${esc(e.body)}</p></li>`;
    }).join("");
    return `<ol class="cps">${items}</ol>`;
  }
  const rows = PROGRAM_TIMELINE.map((e) => {
    const cp = P90.checkpointDays.includes(e.at) ? " is-checkpoint" : "";
    const review = P90.reviewDays.includes(e.at) ? `<span class="tag">strategist review</span>` : "";
    return `<li class="tl-row${cp}"><p class="tl-row__day">${esc(e.day)}</p><div class="tl-row__body"><h3 class="tl-row__title">${esc(e.title)} ${review}</h3><p>${esc(e.body)}</p></div></li>`;
  }).join("");
  return `<ol class="tl-rows">${rows}</ol>`;
}

export function pricingTeaser(): string {
  const g = P.growth;
  return `<div class="teaser">
  <div class="teaser__row teaser__row--lead"><p class="teaser__label">Your growth plan, the first three months</p><p class="teaser__price">${moneySpan(P90.upfront)}</p><p class="teaser__note">upfront, or ${P90.instalments.count} × ${moneySpan(P90.instalments.each)}. Setup, weekly tuning, a strategist review each month, and ${g.name}-level allowances.</p></div>
  <div class="teaser__row"><p class="teaser__label">Then ${esc(g.name)}, the default</p><p class="teaser__price">${moneySpan(g.price.monthly)}<span class="per">/month</span></p><p class="teaser__note">All ${AGENTS.length} staff, a named Growth Partner, and every month ${postsAndReels(g.allowances.studioCreditsPerMonth).replace(/^Up/, "up")}.</p></div>
  <div class="teaser__row"><p class="teaser__label">Founding ${P90.founding.seats}</p><p class="teaser__price">${moneySpan(P90.founding.upfront)}</p><p class="teaser__note">for the first three months, for our first ${P90.founding.seats} customers, in exchange for case-study rights. ${g.name} then stays at ${moneySpan(P90.founding.growthLocked)}/month for ${P90.founding.growthLockMonths} months.</p></div>
</div>`;
}

export function programLede(): string {
  return `<p class="lede">Everyone starts with a three-month growth plan. We set everything up, a person checks every piece for the first month, and a strategist reviews progress with you each month. The goals are yours, we write down where you started, and the plan page shows both.</p>`;
}

export function programFine(): string {
  const g = P90.guarantees;
  return `<p class="program__fine">A ${g.refundDays}-day full refund, a ${g.deliveryDay}-day delivery guarantee, and month 4 free if the effort goals miss. <a href="/pricing/#growth-plan">The terms, in full.</a></p>`;
}

const faqItem = (f: FaqItem) => `<details><summary><h3>${esc(f.q)}</h3></summary><p>${esc(f.a)}</p></details>`;

/** The three questions the home page shows; the whole list is on /faq/. */
export function faq(): string {
  const pick = ["Do I need to be technical?", "Will it post something that embarrasses me?", "Is my business's data mixed with anyone else's?"];
  return `<div class="faq">${FAQ.filter((f) => pick.includes(f.q)).map(faqItem).join("")}</div>`;
}

const FAQ_TOPICS: Record<FaqItem["topic"], string> = {
  start: "Getting started",
  control: "Staying in control",
  data: "Your data",
  money: "Money",
  limits: "What it does not do",
};

export function faqAll(): string {
  return (Object.keys(FAQ_TOPICS) as FaqItem["topic"][])
    .map((t) => `<section class="faq-group" aria-labelledby="faq-${t}"><h2 class="faq-group__h" id="faq-${t}">${FAQ_TOPICS[t]}</h2><div class="faq">${FAQ.filter((f) => f.topic === t).map(faqItem).join("")}</div></section>`)
    .join("");
}

// ---------- pricing ----------

export function programOffer(): string {
  const g = P[P90.includesPlan];
  return `<div class="offer">
  <div class="offer__price">
    <p class="offer__big">${moneySpan(P90.upfront)}</p>
    <p class="offer__alt">upfront, or ${P90.instalments.count} monthly payments of ${moneySpan(P90.instalments.each)}</p>
  </div>
  <ul class="offer__includes">
    <li>The done-for-you setup: the 15-minute start, the optional connect call, and our people finishing the connections with you</li>
    <li>${g.name}-level allowances for all three months: ${postsAndReels(g.allowances.studioCreditsPerMonth).toLowerCase()} each month (${g.allowances.studioCreditsPerMonth} Studio credits)</li>
    <li>Weekly tuning, and a strategist review each month</li>
    <li>All ${AGENTS.length} staff in all ${DEPARTMENTS.length} departments</li>
  </ul>
  <div class="offer__founding">
    <p class="offer__founding-title">Founding ${P90.founding.seats}</p>
    <p>Our first ${P90.founding.seats} customers pay ${moneySpan(P90.founding.upfront)} for the three months, in exchange for the right to write up their results as a case study. After month 3, ${g.name} stays at ${moneySpan(P90.founding.growthLocked)} a month for ${P90.founding.growthLockMonths} months.</p>
  </div>
</div>`;
}

export function guarantees(): string {
  const gu = P90.guarantees;
  return `<ol class="guarantees">
  <li><h3>${gu.refundDays}-day full refund</h3><p>No questions asked.</p></li>
  <li><h3>${gu.deliveryDay}-day delivery guarantee</h3><p>If, within ${gu.deliveryDay} days, your team's picture of your business is not live (at least 3 capabilities working, or the reason explained), or we have delivered fewer than 4 Monday packs and 12 pieces ready to approve, we refund the remaining two-thirds.</p></li>
  <li><h3>Month 4 free</h3><p>If fewer than 2 of your 3 effort goals are hit, provided you acted on at least half of what we proposed. Effort goals are things we control together: posting 3 times a week, replying to Google reviews within 24 hours, shipping the top 5 search fixes.</p></li>
</ol>
<p class="fine">We guarantee what we control, never revenue. Your renewal notice arrives at least ${gu.renewalNoticeDays} days before your growth plan turns into a plan.</p>`;
}

export function plans(): string {
  const cols = PLANS.map((p) => {
    const a = p.allowances;
    const badge = p.isDefault
      ? `<p class="plan__badge plan__badge--gold">The default after month 3</p>`
      : p.graduatesOnly
        ? `<p class="plan__badge">For growth-plan graduates</p>`
        : `<p class="plan__badge plan__badge--none" aria-hidden="true">&nbsp;</p>`;
    const yearly = p.price.yearly
      ? `<p class="plan__alt">or ${moneySpan(p.price.yearly)} a year, 2 months free</p>`
      : `<p class="plan__alt plan__alt--none" aria-hidden="true">&nbsp;</p>`;
    const row = (k: string, v: string) => `<div class="plan__row"><dt>${k}</dt><dd>${v}</dd></div>`;
    return `<article class="plan${p.isDefault ? " plan--default" : ""}" aria-labelledby="plan-${p.id}">
  <h3 class="plan__name" id="plan-${p.id}">${esc(p.name)}</h3>
  ${badge}
  <p class="plan__price">${moneySpan(p.price.monthly)}<span class="per">/month</span></p>
  ${yearly}
  <p class="plan__who">${esc(p.who)}</p>
  <dl>
    ${row("Posts and reels this month", `${postsAndReels(a.studioCreditsPerMonth)}${a.studioCreditsPerMonth ? `<span class="sub">${a.studioCreditsPerMonth} Studio credits</span>` : ""}`)}
    ${row("Questions answered", `${a.answersPerMonth} a month<span class="sub">fair use</span>`)}
    ${row("Rhythm", rhythmHtml(p))}
    ${row("Sources", esc(sourcesText(p)))}
    ${row("Locations and seats", a.locations === null ? "—" : `${a.locations} location${a.locations > 1 ? "s" : ""}, ${a.seats} seats`)}
    ${row("People", p.human ? esc(p.human) : "—")}
    ${row("Extras", p.extras.length ? p.extras.map(extraHtml).join("<br>") : "—")}
  </dl>
</article>`;
  }).join("");
  return `<div class="plans">${cols}</div>`;
}

export function credits(): string {
  const LABEL: Record<keyof typeof CREDIT_COSTS, string> = {
    static_post: "A post, a Google Business post or a story: 1 image, up to 3 versions to choose from, 2 free rounds of tweaks",
    carousel: "A carousel of up to 6 frames",
    shoot: "A project or product shoot: 4 angles from one phone photo",
    reel: "A reel up to 15 seconds, with script, cover and captions",
    text: "Answers, briefs, review replies, captions, emails, reports and analysis",
  };
  const rows = (Object.keys(CREDIT_COSTS) as (keyof typeof CREDIT_COSTS)[])
    .map((k) => `<tr><td>${LABEL[k]}</td><td class="num">${CREDIT_COSTS[k] === 0 ? "Free" : CREDIT_COSTS[k]}</td></tr>`)
    .join("");
  const t = CREDIT_RULES.topUp;
  return `<table class="ledger ledger--credits"><caption class="visually-hidden">Studio credits per finished, approved piece</caption><thead><tr><th scope="col">Finished and approved</th><th scope="col" class="num">Credits</th></tr></thead><tbody>${rows}</tbody></table>
<ul class="rules">
  <li><strong>Spent on approval, never before.</strong> A draft you reject costs nothing. Your approval card says, for example, "uses 1 of 50 credits this month".</li>
  <li><strong>Unused credits roll over</strong> for ${CREDIT_RULES.rolloverMonths} month, up to one month's allowance.</li>
  <li><strong>Nothing stops halfway.</strong> A task can borrow up to ${Math.round(CREDIT_RULES.borrowFraction * 100)}% of next month's credits.</li>
  <li><strong>Top-ups:</strong> ${t.credits} credits for ${moneySpan(t.price)}, added automatically only if you opt in.</li>
</ul>`;
}

export function rhythm(): string {
  const rows = RHYTHM.map(
    (r) => `<tr><th scope="row">${esc(r.when)}</th><td data-label="What arrives"><strong>${esc(r.what)}</strong><span class="who">${esc(r.who)}</span>${esc(r.detail)}</td><td data-label="Your time" class="num">${esc(r.time)}</td></tr>`,
  ).join("");
  return `<table class="ledger ledger--rhythm"><caption class="visually-hidden">What arrives, when, and how long it takes you</caption><thead><tr><th scope="col">When (your time)</th><th scope="col">What arrives</th><th scope="col" class="num">Your time</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function hireBasis(): string {
  const ess = P.essentials.price.monthly;
  const gro = P.growth.price.monthly;
  const ratio = (hire: number, price: number) => {
    const r = hire / price;
    return `<span title="${r.toFixed(1)} times">≈ 1/${Math.round(r)}</span>`;
  };
  const rows = HIRE_BASIS.map((h) => {
    const src = h.source ? `<a href="${h.source.href}" rel="noopener">${h.source.label}</a>` : `<span class="tag">estimate</span>`;
    return `<tr><th scope="row">${esc(h.market)}</th><td data-label="A loaded hire, per month" class="num">${formatMoney(h.monthly, h.currency)}<span class="sub">${esc(h.basis)}</span></td><td data-label="Essentials" class="num">${formatMoney(ess[h.currency], h.currency)}<span class="sub">${ratio(h.monthly, ess[h.currency])}</span></td><td data-label="Growth" class="num">${formatMoney(gro[h.currency], h.currency)}<span class="sub">${ratio(h.monthly, gro[h.currency])}</span></td><td data-label="Source">${src}</td></tr>`;
  }).join("");
  return `<table class="ledger ledger--basis"><caption class="visually-hidden">Allevia against the monthly cost of a social media manager</caption><thead><tr><th scope="col">Market</th><th scope="col" class="num">A loaded hire, per month</th><th scope="col" class="num">Essentials</th><th scope="col" class="num">Growth</th><th scope="col">Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Every block takes the path of the page it is rendered into (the masthead and the footer mark the current page). */
export const BLOCKS: Record<string, (current: string) => string> = {
  masthead: (cur) => masthead(cur),
  footer: (cur) => footer(cur),
  "currency-home": () => currencyToggle("home"),
  "currency-pricing": () => currencyToggle("pricing"),
  "who-does-what": whoDoesWhat,
  team,
  "team-strip": teamStrip,
  "timeline-compact": () => programTimeline("compact"),
  "timeline-full": () => programTimeline("full"),
  "pricing-teaser": pricingTeaser,
  "program-lede": programLede,
  "program-fine": programFine,
  faq,
  "faq-all": faqAll,
  "program-offer": programOffer,
  guarantees,
  plans,
  credits,
  rhythm,
  "hire-basis": hireBasis,
  ...PAGE_BLOCKS,
  ...STORY_BLOCKS,
  ...LEGAL_BLOCKS,
};
