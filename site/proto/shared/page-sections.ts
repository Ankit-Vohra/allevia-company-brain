// The inner pages of the prototype site: Integrations, Product (how it works), Pricing, Security, Questions and Contact. Built at compile time.
// Visual first: real screens from the running app on the sample business, the real tool list (shared/connection-map.ts), the real plans
// (shared/plans.ts) with the new Starter plan marked "to finalise later". Two colours only: paper sections and the one dark band.
import { TOOLKIT_CATALOG } from "../../../shared/connection-map.ts";
import { CREDIT_COSTS, PLANS } from "../../../shared/plans.ts";
import { COMPANY } from "../../src/company.ts";
import { FAQ } from "../../src/content.ts";
import { PLAN_SAMPLE } from "../../src/home-content.ts";
import { AGENTS, BRAIN } from "./assets.generated.ts";
import { CHIP_ROWS } from "./data.ts";
import { hasLogo, logoMarkup } from "./logos.ts";
import { esc } from "./util.ts";

const nameOf = (id: string) => TOOLKIT_CATALOG.find((e) => e.id === id)?.name ?? id;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const face = (id: string) => `<span class="face face--sm" role="img" aria-label="${esc(AGENTS[id]?.name ?? id)}">${AGENTS[id]?.svg ?? ""}</span>`;
const frame = (src: string, w: number, h: number, alt: string, cls = "", loading = "lazy") => `<figure class="device ${cls}"><img src="${src}" width="${w}" height="${h}" alt="${esc(alt)}" loading="${loading}" decoding="async"></figure>`;

/** The same card in Discord, drawn to match the bot's message (src/discord/approval-card.ts). */
const discordCard = (body: string, label: string) => `<figure class="frame">
  <div class="dc" role="img" aria-label="${esc(label)}"><p class="dc__chan"># approvals</p><div class="dc__msg"><span class="dc__av" aria-hidden="true">a</span><div class="dc__body"><p class="dc__who">Allevia <span class="dc__bot">APP</span></p>${body}</div></div></div>
  <figcaption class="frame__cap">In Discord</figcaption>
</figure>`;

// ---------- Integrations ----------

function chipRows(): string {
  const rows = CHIP_ROWS.map((ids, r) => {
    const items = ids.filter(hasLogo).map((id) => `<li class="chip">${logoMarkup(id, 26)}<span>${esc(nameOf(id))}</span></li>`).join("");
    const dur = [74, 62, 80, 68][r % 4];
    const dir = r % 2 === 0 ? "normal" : "reverse";
    const copy = (hidden: boolean) => `<ul class="row__set"${hidden ? ' aria-hidden="true"' : ""}>${items}${items}</ul>`;
    return `<div class="row" style="--dur:${dur}s;--dir:${dir}"><div class="row__track">${copy(false)}${copy(true)}${copy(true)}${copy(true)}</div></div>`;
  }).join("");
  return `<div class="rows" aria-label="Tools your team can connect to">${rows}</div>`;
}

export function intHero(): string {
  return `<section class="sec int-hero" aria-labelledby="int-h">
  <div class="wrap int-hero__head">
    <h1 id="int-h" class="page-h1"><span class="t1">Your team, connected</span> <span class="t2">to the tools you use.</span></h1>
    <p class="lede">Connect your accounts. You choose what your team can do.</p>
  </div>
  ${chipRows()}
</section>`;
}

const GROUPS: [string, string][] = [["google", "Google"], ["meta", "Social and ads"], ["commerce", "Shop and money"], ["customers", "Customers and email"], ["team", "Your team"]];

export function intGrid(): string {
  const groups = GROUPS.map(([gid, label]) => {
    const tools = TOOLKIT_CATALOG.filter((t) => t.group === gid && hasLogo(t.id));
    if (!tools.length) return "";
    const cards = tools.map((t) => `<li class="tool" data-reveal>
      <div class="tool__top"><span class="tool__logo">${logoMarkup(t.id, 28)}</span><div><h3>${esc(t.name)}</h3><span class="tag ${t.acts.length ? "tag--act" : ""}">${t.acts.length ? "Read and act" : "Read only"}</span></div></div>
      <p>${esc(t.blurb)}</p>
      <details class="tool__more"><summary>What it can do</summary><dl><dt>It reads</dt><dd>${esc(t.reads.join(" "))}</dd>${t.acts.length ? `<dt>It may</dt><dd>${esc(t.acts.join(" "))}</dd>` : ""}</dl></details>
    </li>`).join("");
    return `<section class="tools-group" aria-labelledby="g-${gid}"><h2 id="g-${gid}" class="h3">${esc(label)}</h2><ul class="tools">${cards}</ul></section>`;
  }).join("");
  return `<section class="sec tools-wrap"><div class="wrap tools-wrap__in">${groups}</div></section>`;
}

export function intAccess(): string {
  return `<section class="sec band band--ink" aria-labelledby="access-h">
  <div class="wrap access">
    <div class="access__copy on-ink">
      <h2 id="access-h" class="h2 h2--split"><span class="t1">You stay in control.</span></h2>
      <ul class="access__list">
        <li><b>Connect once.</b> Your team never sees your password.</li>
        <li><b>Nothing goes out without your OK.</b></li>
        <li><b>Your data stays in your own space.</b></li>
        <li><b>Disconnect any time.</b></li>
      </ul>
    </div>
    ${frame("/shared/img/app-connect-3-tools-crop.webp", 1060, 790, "The Your tools screen: Gmail, Google Calendar and Google Analytics, each with what your team reads and what it may do after your OK.", "access__shot")}
  </div>
</section>`;
}

// ---------- Product ----------

export function productHero(): string {
  return `<section class="sec phead" aria-labelledby="ph-h">
  <div class="wrap"><h1 id="ph-h" class="page-h1"><span class="t1">How it works.</span> <span class="t2">We set it up for you.</span></h1></div>
</section>`;
}

/** The three big steps. Wide screens with motion: pinned, the active step lit on the left and its real screen or clip on the right. */
export function productSteps(): string {
  const steps: { h: string; p: string; media: string }[] = [
    { h: "Paste your website.", p: "We read your pages and learn what you sell.", media: frame("/shared/img/step-paste.webp", 1500, 940, "Add a business: paste your website and the business name, then Set up my team.", "step__dev", "lazy") },
    { h: "Watch your brain form.", p: "Every fact keeps its source.", media: `<figure class="device step__dev"><video class="step__video" muted loop playsinline preload="none" poster="/shared/img/onboard-brain-poster.webp" src="/shared/img/onboard-brain.mp4" width="1000" height="770" aria-label="Setting up a business in the app: the steps tick through and the brain graph forms as things are learned."></video></figure>` },
    { h: "Connect your tools.", p: "Reading is instant. Sending and spending wait for your OK.", media: frame("/shared/img/step-connect.webp", 1500, 1095, "Your tools: Gmail, Google Calendar and Google Analytics, with what each one reads and may do.", "step__dev") },
  ];
  const rows = steps.map((s, i) => `<div class="step" data-step="${i}"><div class="step__txt"><span class="step__n" aria-hidden="true">${i + 1}</span><div><h3 class="step__h"><span class="visually-hidden">Step ${i + 1}: </span>${esc(s.h)}</h3><p>${esc(s.p)}</p></div></div><div class="step__m">${s.media}</div></div>`).join("");
  return `<section class="sec band band--ink steps" id="onboarding" data-steps aria-labelledby="st-h">
  <div class="steps__pin">
    <div class="wrap steps__grid">
      <h2 id="st-h" class="h2 h2--split steps__head on-ink"><span class="t1">We set it up.</span> <span class="t2">You paste your website.</span></h2>
      <div class="steps__rows on-ink">${rows}</div>
    </div>
  </div>
</section>`;
}

export function productBrain(): string {
  const chips = BRAIN.clusters.map((c) => `<li class="cluster"><b>${esc(c.label)}</b><span class="num">${c.count}</span><i>${esc(c.sample.slice(0, 3).join(", "))}</i></li>`).join("");
  return `<section class="sec" id="brain" aria-labelledby="ch2-h"><div class="wrap chapter chapter--split">
  <div class="chapter__copy">
    <h2 id="ch2-h" class="h2 h2--split"><span class="t1">One company brain.</span> <span class="t2">Everything your business knows.</span></h2>
    <ul class="clusters">${chips}</ul>
  </div>
  ${frame("/shared/img/brain-knows.webp", 1000, 582, "What your team knows: recent decisions, what comes up most, and what breaks if something stops.", "chapter__shot")}
</div></section>`;
}

export function productNote(): string {
  return `<section class="sec" id="note" aria-labelledby="ch4-h"><div class="wrap chapter chapter--split">
  ${frame("/shared/img/app-home.webp", 1800, 1391, "The app's home: a short note for the day, what is waiting for your OK with the draft and the reason, and the plan.", "chapter__shot")}
  <div class="chapter__copy">
    <h2 id="ch4-h" class="h2 h2--split"><span class="t1">Today’s note.</span> <span class="t2">One short note each morning.</span></h2>
    <p class="lede">How the business is doing, what waits for your OK, and one next step.</p>
  </div>
</div></section>`;
}

/** "You tap OK": the card in the app before and after one tap, and the same kind of card in Discord. Used on the home page and on Product. */
export function okBlock(id: string, more = ""): string {
  return `<section class="sec band band--ink okd" id="${id}" aria-labelledby="${id}-h" data-ok>
  <div class="wrap">
    <h2 id="${id}-h" class="h2 h2--split on-ink"><span class="t1">You tap OK.</span> <span class="t2">Nothing goes out before that.</span></h2>
    <div class="pair">
      <figure class="frame ok__web">
        <div class="ok__stack" data-ok-stack>
          <img class="ok__img ok__img--before" src="/media/shot-ok-before.webp" width="720" height="564" loading="lazy" decoding="async" alt="A card waiting for your OK: an Instagram poster draft by Tara, with Approve, Change and No thanks.">
          <img class="ok__img ok__img--after" src="/media/shot-ok-after.webp" width="720" height="564" loading="lazy" decoding="async" alt="After one tap: Approved. Draft saved. Nothing was posted.">
          <span class="ok__tap" aria-hidden="true"></span>
        </div>
        <figcaption class="frame__cap">In the app</figcaption>
      </figure>
      <div>${discordCard(`<p><b>Draft email to Meghna</b></p><p class="dc__q">Could we talk for 30 minutes? Free (IST): Mon 19 Oct 11:00, Tue 20 Oct 09:30, Wed 21 Oct 11:30.</p><p class="dc__btns"><span class="dc__b dc__b--ok" data-ok-dc>Approve</span><span class="dc__b">Change</span><span class="dc__b dc__b--no">No thanks</span></p>`, "The same kind of card in Discord with the buttons Approve, Change and No thanks.")}</div>
    </div>${more}
  </div>
</section>`;
}

export function productOk(): string { return okBlock("ok"); }

export function productPlan(): string {
  const bars = PLAN_SAMPLE.map((g) => {
    const f = (n: number) => n.toLocaleString("en-US");
    const frac = (v: number) => Math.max(0, Math.min(1, (v - g.from) / (g.goal - g.from)));
    return `<li class="goal ${g.status === "Needs a push" ? "goal--push" : ""}">
      <div class="goal__top"><span class="goal__name">${esc(g.name)}</span><span class="goal__status">${esc(g.status)}</span></div>
      <div class="goal__bar"><span class="goal__fill" style="--to:${frac(g.now).toFixed(3)}"></span></div>
      <p class="goal__nums"><span class="goal__now num">${f(g.now)} ${esc(g.unit)}</span><span>Started at ${f(g.from)}. Goal ${f(g.goal)}.</span><span class="goal__who">${face(({ Rohan: "growth-marketer", Tara: "content-strategist", Kabir: "data-analyst" } as Record<string, string>)[g.who] ?? "chief-of-staff")}${esc(g.who)}</span></p>
    </li>`;
  }).join("");
  return `<section class="sec" id="plan" aria-labelledby="ch6-h" data-plan><div class="wrap chapter chapter--split">
  <div class="chapter__copy">
    <h2 id="ch6-h" class="h2 h2--split"><span class="t1">Your plan moves.</span> <span class="t2">Three goals, one bar each.</span></h2>
    <p class="lede">You say OK to the plan. After that, your team keeps it on track and only asks when something costs money or speaks in public.</p>
  </div>
  <ul class="goals">${bars}</ul>
</div></section>`;
}

// ---------- Pricing ----------

const growth = PLANS.find((p) => p.id === "growth")!, pro = PLANS.find((p) => p.id === "pro")!;
const planLines = (p: typeof growth) => {
  const a = p.allowances;
  const out = [`Up to ${Math.floor(a.studioCreditsPerMonth / CREDIT_COSTS.static_post)} posts or ${Math.floor(a.studioCreditsPerMonth / CREDIT_COSTS.reel)} reels a month`, `${a.answersPerMonth} questions a month`, a.locations && a.locations > 1 ? `Up to ${a.locations} locations, ${a.seats} seats` : `${a.locations} location, ${a.seats} seats`];
  out.push(p.id === "growth" ? "A named person reviews your plan each month" : "A strategist two hours a month");
  return out;
};
/** The three plans the prototype shows. Starter ($100) is new and marked to finalise; Growth and Pro are the real plans in shared/plans.ts. */
export const PLAN_CARDS: { name: string; note: string; price: number; lines: string[]; lead: boolean }[] = [
  { name: "Starter", note: "All your tools, working together", price: 100, lines: ["All your tools connected together", "A note every morning and your team’s advice", "Questions answered from your brain", "Approvals in the app or in Discord", "No image or video generation"], lead: true },
  { name: "Growth", note: "The whole team", price: growth.price.monthly.USD, lines: planLines(growth), lead: false },
  { name: "Pro", note: "More places, more help", price: pro.price.monthly.USD, lines: planLines(pro), lead: false },
];

export function pricing(): string {
  const card = (c: (typeof PLAN_CARDS)[number]) => `<article class="plan ${c.lead ? "plan--lead" : ""}" aria-labelledby="plan-${c.name}">
    <h3 id="plan-${c.name}" class="plan__name">${esc(c.name)}</h3><p class="plan__note">${esc(c.note)}</p>
    <p class="plan__price"><span class="money">${usd(c.price)}</span><span class="per"> a month</span></p>
    <ul class="plan__lines">${c.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    <a class="btn ${c.lead ? "btn-gold" : "btn-ghost"}" href="/contact/#snapshot">Get started<span class="visually-hidden"> with ${esc(c.name)}</span></a>
  </article>`;
  return `<section class="sec pricing" aria-labelledby="pr-h"><div class="wrap">
  <h1 id="pr-h" class="page-h1"><span class="t1">Simple monthly plans.</span> <span class="t2">Start with your tools connected.</span></h1>
  <p class="draft"><span class="tag tag--draft">Draft pricing</span> To finalise later. Prices in US dollars, excluding tax.</p>
  <div class="plans">${PLAN_CARDS.map(card).join("")}</div>
  <p class="fine">Essentials (${usd(PLANS.find((p) => p.id === "essentials")!.price.monthly.USD)} a month, after the three-month growth plan) and Pause (${usd(PLANS.find((p) => p.id === "pause")!.price.monthly.USD)} a month) stay as they are. 14-day refund on the three-month plan.</p>
</div></section>`;
}

// ---------- Security and the questions ----------

export function security(): string {
  const items: [string, string][] = [
    ["Your own database", "Your business sits in its own database, apart from every other business."],
    ["Nothing goes out without your OK", "Your team drafts and you approve."],
    ["Private details are removed", "Passwords, card and phone numbers are removed before text reaches the AI."],
    ["You can leave", "Ask, and we send you a copy of your data or delete it."],
  ];
  return `<section class="sec phead" aria-labelledby="sec-h"><div class="wrap"><h1 id="sec-h" class="page-h1"><span class="t1">Four promises.</span> <span class="t2">Kept in the product.</span></h1></div></section>
  <section class="sec promises"><div class="wrap"><ul>${items.map(([h, p]) => `<li data-reveal><h2 class="h3">${esc(h)}</h2><p>${esc(p)}</p></li>`).join("")}</ul></div></section>`;
}

export function faq(): string {
  return `<section class="sec phead" aria-labelledby="faq-h"><div class="wrap"><h1 id="faq-h" class="page-h1"><span class="t1">Questions.</span> <span class="t2">Short answers.</span></h1></div></section>
  <section class="sec"><div class="wrap faq">${FAQ.map((f) => `<details><summary><h2 class="h3">${esc(f.q)}</h2></summary><p>${esc(f.a)}</p></details>`).join("")}</div></section>`;
}

// ---------- Contact ----------

/** The Snapshot form is first because every button on the site says "Get a free Brain Snapshot" and lands here. There is no form backend yet:
 *  the form opens the visitor's email with the message written (a plain mailto, built by page.ts; without the script the form posts to the
 *  same mailto). The Discord box appears only once COMPANY.discordSupportUrl is set. */
export function contact(): string {
  const mail = COMPANY.email.general;
  const href = (subject: string) => `mailto:${mail}?subject=${encodeURIComponent(subject)}`;
  const discord = COMPANY.discordSupportUrl
    ? `<li class="cbox"><h2 class="h3">Discord</h2><p><a class="link" href="${esc(COMPANY.discordSupportUrl)}" rel="noopener">Join our Discord</a></p></li>`
    : "";
  return `<section class="sec phead" aria-labelledby="ct-h"><div class="wrap">
  <h1 id="ct-h" class="page-h1"><span class="t1">Your free Brain Snapshot.</span> <span class="t2">Send us your website.</span></h1>
</div></section>
<section class="sec contact"><div class="wrap contact__grid">
  <form class="snap" id="snapshot" data-snap action="${href("Free Brain Snapshot")}" method="post" enctype="text/plain" aria-labelledby="snap-h">
    <h2 id="snap-h" class="h3">We read it and send back what we learned and five fixes.</h2>
    <div class="field"><label for="snap-site">Your website</label><input id="snap-site" name="website" type="text" inputmode="url" autocomplete="url" placeholder="yourbusiness.com" required></div>
    <div class="field"><label for="snap-email">Your email</label><input id="snap-email" name="email" type="email" autocomplete="email" placeholder="you@yourbusiness.com" required></div>
    <button class="btn btn-gold" type="submit">Send my website</button>
    <p class="snap__note">This opens your email with the message ready to send.</p>
  </form>
  <ul class="cbox-row">
    <li class="cbox" id="demo"><h2 class="h3">Prefer to talk first?</h2><p>See Allevia on a business like yours.</p><p><a class="btn btn-ghost" href="${href("Book a demo")}">Book a demo</a></p></li>
    <li class="cbox"><h2 class="h3">Email</h2><p><a class="link" href="mailto:${esc(mail)}">${esc(mail)}</a></p></li>
    ${discord}
  </ul>
</div></section>`;
}

export const PAGE_SECTIONS: Record<string, () => string> = {
  "int-hero": intHero, "int-grid": intGrid, "int-access": intAccess,
  "product-hero": productHero, "product-steps": productSteps, "product-brain": productBrain, "product-note": productNote, "product-ok": productOk, "product-plan": productPlan,
  pricing, security, faq, contact,
};
