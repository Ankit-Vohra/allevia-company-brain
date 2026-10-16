// The inner pages of the prototype site: Integrations, Product (how it works), Pricing, Security and the questions. Built at compile time.
// Visual first: real screens from the running app on the sample business, the real tool list (shared/connection-map.ts), the real plans
// (shared/plans.ts) with the new Starter plan marked "to finalise later".
import { TOOLKIT_CATALOG } from "../../../shared/connection-map.ts";
import { CREDIT_COSTS, PLANS } from "../../../shared/plans.ts";
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
  <figcaption class="frame__cap">In Discord <span class="tag" title="Redrawn to match the message the Allevia bot sends">redrawn</span></figcaption>
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
  return `<section class="int-hero" aria-labelledby="int-h">
  <div class="wrap int-hero__head">
    <h1 id="int-h" class="page-h1"><span class="t1">Your team, connected</span><br><span class="t2">to the tools you use.</span></h1>
    <p class="lede">Connect your accounts so your team works on real work, with access you control.</p>
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
      <dl><dt>It reads</dt><dd>${esc(t.reads.join(" "))}</dd>${t.acts.length ? `<dt>It may</dt><dd>${esc(t.acts.join(" "))}</dd>` : ""}</dl>
    </li>`).join("");
    return `<section class="tools-group" aria-labelledby="g-${gid}"><h2 id="g-${gid}" class="h3">${esc(label)}</h2><ul class="tools">${cards}</ul></section>`;
  }).join("");
  return `<div class="wrap tools-wrap">${groups}</div>`;
}

export function intAccess(): string {
  return `<section class="wrap access" aria-labelledby="access-h">
  <div class="access__copy">
    <h2 id="access-h" class="h2"><span class="t1">You stay in control.</span> <span class="t2">Reading is instant. Everything else waits for you.</span></h2>
    <ul class="access__list">
      <li><b>Connect once.</b> Sign in to your own account. Your team never sees your password.</li>
      <li><b>Nothing goes out without your OK.</b> Posts, emails, bookings and spend wait for you.</li>
      <li><b>Your data stays in your own space.</b> Apart from every other business.</li>
      <li><b>Disconnect any time.</b> One tap and your team stops reading.</li>
    </ul>
  </div>
  ${frame("/shared/img/app-connect-3-tools-crop.webp", 1060, 790, "The Your tools screen: Gmail, Google Calendar and Google Analytics, each with what your team reads and what it may do after your OK.", "access__shot")}
</section>`;
}

// ---------- Product ----------

export function productHero(): string {
  return `<section class="wrap phead" aria-labelledby="ph-h">
  <h1 id="ph-h" class="page-h1"><span class="t1">How it works.</span> <span class="t2">Paste your website, connect your tools, ask, and tap OK.</span></h1>
</section>`;
}

export function productOnboarding(): string {
  return `<section class="wrap chapter" id="onboarding" aria-labelledby="ch1-h">
  <h2 id="ch1-h" class="h2"><span class="t1">We set it up.</span> <span class="t2">You paste your website. The rest takes minutes.</span></h2>
  <div class="onb">
    <figure class="onb__f onb__f--1" data-reveal>${frame("/shared/img/app-onboard-1-paste-crop.webp", 1060, 640, "Add a business: paste your website and the business name, then Set up my team.", "device--shot", "lazy")}<figcaption><b>Paste your website.</b> Your team reads your pages and learns what you sell.</figcaption></figure>
    <figure class="onb__f onb__f--2" data-reveal>${frame("/shared/img/app-onboard-2-brain-crop.webp", 1060, 730, "Setting up Shiftly: step 3 of 8, with the brain graph forming as things are learned.", "device--shot")}<figcaption><b>Watch your brain form.</b> Every fact keeps its source.</figcaption></figure>
    <figure class="onb__f onb__f--3" data-reveal>${frame("/shared/img/app-connect-3-tools-crop.webp", 1060, 790, "Your tools: Gmail, Google Calendar and Google Analytics with what each reads and may do.", "device--shot")}<div class="phone"><img src="/shared/img/app-connect-4-tools-mobile.webp" width="780" height="1744" alt="The same Your tools screen on a phone." loading="lazy" decoding="async"></div><figcaption><b>Connect your tools.</b> Reading is instant. Sending and spending wait for your OK.</figcaption></figure>
  </div>
</section>`;
}

export function productBrain(): string {
  const chips = BRAIN.clusters.map((c) => `<li class="cluster"><b>${esc(c.label)}</b><span class="num">${c.count}</span><i>${esc(c.sample.slice(0, 3).join(", "))}</i></li>`).join("");
  return `<section class="wrap chapter chapter--split" id="brain" aria-labelledby="ch2-h">
  <div class="chapter__copy">
    <h2 id="ch2-h" class="h2"><span class="t1">One company brain.</span> <span class="t2">Everything your business knows, with where it came from.</span></h2>
    <p class="lede">The sample business has <span class="num">${BRAIN.counts.nodes}</span> things and <span class="num">${BRAIN.counts.edges}</span> links, in five groups.</p>
    <ul class="clusters">${chips}</ul>
  </div>
  ${frame("/media/shot-brain.webp", 1200, 900, "The company brain of a sample business: people, sign-up steps, the app and its releases, ads and customers, each connected to what depends on it.", "chapter__shot")}
</section>`;
}

export function productAsk(): string {
  return `<section class="wrap chapter" id="ask" aria-labelledby="ch3-h">
  <h2 id="ch3-h" class="h2"><span class="t1">Ask in your own words.</span> <span class="t2">In the app or in Discord. The answer shows how it knows.</span></h2>
  <div class="pair">
    <figure class="frame" data-reveal>${frame("/media/shot-answer.webp", 1200, 900, "An answer in the app: why sign-ups dropped, with the path of the sources it came from.")}<figcaption class="frame__cap">In the app</figcaption></figure>
    <div data-reveal>${discordCard(`<p><b>Why did sign-ups drop?</b></p><p class="dc__q">The new phone box in release 2.8.0 crashes the sign-up screen. New accounts fell from about 238 to 51 a day on 7 October. Farhan owns the fix.</p><p class="dc__dim">Answered by Kabir, Data Analyst</p>`, "The same answer in Discord: a message from the Allevia bot with the cause of the sign-up drop.")}</div>
  </div>
</section>`;
}

export function productNote(): string {
  return `<section class="wrap chapter chapter--split" id="note" aria-labelledby="ch4-h">
  ${frame("/shared/img/app-home-ok.webp", 608, 596, "The app's home on the sample business: what is waiting for your OK, with the draft, the reason and Approve, Change and No thanks.", "chapter__shot")}
  <div class="chapter__copy">
    <h2 id="ch4-h" class="h2"><span class="t1">Today’s note.</span> <span class="t2">One short note each morning, and what is waiting for you.</span></h2>
    <p class="lede">Three things on your home screen: how the business is doing, what waits for your OK, and one next step. Everything else is one tap away.</p>
  </div>
</section>`;
}

export function productOk(): string {
  return `<section class="wrap chapter" id="ok" aria-labelledby="ch5-h" data-ok>
  <h2 id="ch5-h" class="h2"><span class="t1">You tap OK.</span> <span class="t2">Approve, change or say no thanks. Nothing goes out before that.</span></h2>
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
  </div>
</section>`;
}

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
  return `<section class="wrap chapter chapter--split" id="plan" aria-labelledby="ch6-h" data-plan>
  <div class="chapter__copy">
    <h2 id="ch6-h" class="h2"><span class="t1">Your plan moves.</span> <span class="t2">Three goals, one bar each. Your team checks its own progress every month.</span></h2>
    <p class="lede">You say OK to the plan, or change a number. After that, your team keeps it on track and asks you only when something costs money or speaks in public.</p>
    <p class="fine">Sample numbers.</p>
  </div>
  <ul class="goals">${bars}</ul>
</section>`;
}

// ---------- Pricing ----------

export function pricing(): string {
  const growth = PLANS.find((p) => p.id === "growth")!, pro = PLANS.find((p) => p.id === "pro")!;
  const lines = (p: typeof growth) => {
    const a = p.allowances;
    const out = [`Up to ${Math.floor(a.studioCreditsPerMonth / CREDIT_COSTS.static_post)} posts or ${Math.floor(a.studioCreditsPerMonth / CREDIT_COSTS.reel)} reels a month`, `${a.answersPerMonth} questions a month`, a.locations && a.locations > 1 ? `Up to ${a.locations} locations, ${a.seats} seats` : `${a.locations} location, ${a.seats} seats`];
    out.push(p.id === "growth" ? "A named person reviews your plan each month" : "A strategist two hours a month");
    return out;
  };
  const card = (name: string, note: string, price: number, items: string[], cls = "") => `<article class="plan ${cls}" aria-labelledby="plan-${name}">
    <h3 id="plan-${name}" class="plan__name">${esc(name)}</h3><p class="plan__note">${esc(note)}</p>
    <p class="plan__price"><span class="money">${usd(price)}</span><span class="per"> a month</span></p>
    <ul class="plan__lines">${items.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    <a class="btn ${cls.includes("plan--lead") ? "btn-gold" : "btn-ghost"}" href="/contact/">Get started<span class="visually-hidden"> with ${esc(name)}</span></a>
  </article>`;
  return `<section class="wrap pricing" aria-labelledby="pr-h">
  <h1 id="pr-h" class="page-h1"><span class="t1">Simple monthly plans.</span> <span class="t2">Start with your tools connected. Add more when you are ready.</span></h1>
  <p class="draft"><span class="tag tag--draft">Draft pricing</span> To finalise later. Prices in US dollars, excluding tax.</p>
  <div class="plans">
    ${card("Starter", "All your tools, working together", 100, ["All your tools connected together", "Your team’s advice and a note every morning", "Questions answered from your brain", "Approvals in the app or in Discord", "No image or video generation"], "plan--lead")}
    ${card("Growth", "The whole team", growth.price.monthly.USD, lines(growth))}
    ${card("Pro", "More places, more help", pro.price.monthly.USD, lines(pro))}
  </div>
  <p class="fine">Essentials (${usd(PLANS.find((p) => p.id === "essentials")!.price.monthly.USD)} a month, for people finishing the three-month growth plan) and Pause (${usd(PLANS.find((p) => p.id === "pause")!.price.monthly.USD)} a month) stay as they are. 14-day refund on the three-month plan.</p>
</section>`;
}

// ---------- Security and the questions ----------

export function security(): string {
  const items: [string, string][] = [
    ["Your own database", "Your business sits in its own database, apart from every other business. Your connected tools are sealed to it."],
    ["Nothing goes out without your OK", "Your team drafts and you approve. Nothing is posted, sent or booked without it."],
    ["Private details are removed", "Passwords, card and phone numbers are removed before text reaches the AI. Photos lose their location."],
    ["You can leave", "Ask, and we send you a copy of your data or delete it."],
  ];
  return `<section class="wrap phead" aria-labelledby="sec-h"><h1 id="sec-h" class="page-h1"><span class="t1">Four promises.</span> <span class="t2">Kept in the product, not just on this page.</span></h1></section>
  <section class="wrap promises"><ul>${items.map(([h, p]) => `<li data-reveal><h2 class="h3">${esc(h)}</h2><p>${esc(p)}</p></li>`).join("")}</ul>
  <p class="fine">The full legal pages (privacy, terms, cookies, data deletion) are on the main site and stay complete.</p></section>`;
}

export function faq(): string {
  return `<section class="wrap phead" aria-labelledby="faq-h"><h1 id="faq-h" class="page-h1"><span class="t1">Questions.</span> <span class="t2">Short answers.</span></h1></section>
  <section class="wrap faq">${FAQ.map((f) => `<details><summary><h2 class="h3">${esc(f.q)}</h2></summary><p>${esc(f.a)}</p></details>`).join("")}</section>`;
}

export const PAGE_SECTIONS: Record<string, () => string> = {
  "int-hero": intHero, "int-grid": intGrid, "int-access": intAccess,
  "product-hero": productHero, "product-onboarding": productOnboarding, "product-brain": productBrain, "product-ask": productAsk, "product-note": productNote, "product-ok": productOk, "product-plan": productPlan,
  pricing, security, faq,
};
