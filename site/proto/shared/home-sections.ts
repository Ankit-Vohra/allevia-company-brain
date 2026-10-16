// The home page's story sections (shared by prototypes A and B): the founder's problems pulled into one brain, a three-card glimpse of
// what it does, a strip of tools, the problems-to-outcomes flow, and the one button. Built at compile time; behaviour in home-client.ts.
import { AGENTS } from "./assets.generated.ts";
import { CALM, NOISE, OUTCOMES, PROBLEMS } from "./data.ts";
import { logo, logoMarkup } from "./logos.ts";
import { esc } from "./util.ts";

const face = (id: string, cls = "face") => `<span class="${cls}" role="img" aria-label="${esc(AGENTS[id]?.name ?? id)}">${AGENTS[id]?.svg ?? ""}</span>`;
const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };

// ---------- the problem scene: the founder's noise, pulled into one calm brain ----------

const BEATS: [string, string][] = [
  ["Too many people to answer.", "Customers, staff, suppliers, agencies."],
  ["Too many tools.", "Each with its own login, its own numbers and its own problems."],
  ["Too much to remember.", "Who was promised what, why you decided it, what changed last week."],
  ["Nothing talks to anything else.", "Every tool and every chat keeps its own piece."],
  ["And all of it lands on you.", ""],
];

const TOOL_TABS: [string, string][] = [["google-ads", "Ads Manager"], ["google-analytics", "Analytics"], ["instagram", "Instagram"], ["gmail", "Inbox"], ["google-calendar", "Calendar"], ["shopify", "Shop admin"], ["hubspot", "CRM"], ["slack", "Slack"], ["whatsapp", "WhatsApp"], ["stripe", "Payments"]];
const BADGES = [12, 3, 27, 47, 5, 9, 14, 8, 31, 2];

export function problem(): string {
  const r = rng(11);
  type Kind = "people" | "tools" | "memory" | "alerts";
  const pool: { kind: Kind; html: string }[] = [];
  NOISE.people.forEach((t, i) => pool.push({ kind: "people", html: `<span class="nz__dot" style="--c:${["#9a5232", "#4f5433", "#44585c", "#6e7447", "#a1743a", "#7a4c63"][i % 6]}">${esc(t[0]!)}</span><span>${esc(t)}</span>` }));
  TOOL_TABS.forEach(([id, name], i) => pool.push({ kind: "tools", html: `${logoMarkup(id, 18)}<span>${esc(name)}</span><span class="nz__badge">${BADGES[i]}</span>` }));
  NOISE.memory.forEach((t) => pool.push({ kind: "memory", html: `<span>${esc(t)}</span>` }));
  NOISE.alerts.forEach((t) => pool.push({ kind: "alerts", html: `<span>${esc(t)}</span>` }));
  // a fixed shuffle, then a golden-angle spread around the founder: the pile looks accidental and is the same on every load
  const order = pool.map((_, i) => i).sort((a, b) => ((a * 7919) % 31) - ((b * 7919) % 31));
  const n = order.length;
  const items = order.map((pi, i) => {
    const it = pool[pi]!;
    const a = i * 2.399963 + 0.4, rad = 0.2 + 0.27 * Math.sqrt((i + 1) / n);
    const x = Math.cos(a) * rad * 1.02, y = Math.sin(a) * rad * 0.92;
    const rot = (r() - 0.5) * (it.kind === "memory" ? 9 : 4);
    return { ...it, x, y, rot, inS: (i / n) * 0.07, pullS: 0.64 + (i % 9) * 0.012 };
  });
  // relax overlaps (the pile may be messy, but every item should still be readable): push overlapping boxes apart, keep them in the stage
  // and out of the middle where the founder stands
  const SIZE: Record<string, [number, number]> = { people: [0.27, 0.075], tools: [0.19, 0.07], memory: [0.2, 0.12], alerts: [0.16, 0.065] };
  for (let it = 0; it < 160; it++) {
    for (let i = 0; i < n; i++) {
      const a = items[i]!, [aw, ah] = SIZE[a.kind]!;
      for (let j = i + 1; j < n; j++) {
        const b = items[j]!, [bw, bh] = SIZE[b.kind]!;
        const ox = (aw + bw) / 2 - Math.abs(a.x - b.x), oy = (ah + bh) / 2 - Math.abs(a.y - b.y);
        if (ox > 0 && oy > 0) {
          if (ox < oy) { const d = (ox / 2 + 0.002) * (a.x < b.x ? -1 : 1); a.x += d; b.x -= d; } else { const d = (oy / 2 + 0.002) * (a.y < b.y ? -1 : 1); a.y += d; b.y -= d; }
        }
      }
      const cx = Math.abs(a.x) < aw / 2 + 0.07 && Math.abs(a.y) < ah / 2 + 0.11;
      if (cx) { if (Math.abs(a.x) / (aw / 2 + 0.07) > Math.abs(a.y) / (ah / 2 + 0.11)) a.x += (a.x < 0 ? -1 : 1) * 0.006; else a.y += (a.y < 0 ? -1 : 1) * 0.006; }
      a.x = Math.max(-0.5 + aw / 2, Math.min(0.5 - aw / 2, a.x)); a.y = Math.max(-0.5 + ah / 2 + 0.02, Math.min(0.5 - ah / 2 - 0.02, a.y));
    }
  }
  const html = items.map((it) => `<div class="nz nz--${it.kind}" aria-hidden="true" style="--x:${it.x.toFixed(3)};--y:${it.y.toFixed(3)};--r:${it.rot.toFixed(1)}deg;--in-s:${it.inS.toFixed(3)};--pull-s:${it.pullS.toFixed(3)}">${it.html}</div>`).join("");
  // broken links between pairs that should talk to each other
  const links = Array.from({ length: 12 }, (_, k) => { const p = items[(k * 5) % n]!, q = items[(k * 5 + 7) % n]!; return `<line x1="${(p.x * 100).toFixed(1)}" y1="${(p.y * 100).toFixed(1)}" x2="${(q.x * 100).toFixed(1)}" y2="${(q.y * 100).toFixed(1)}"/>`; }).join("");
  const beats = BEATS.map(([h, s], i) => `<li class="beat" data-beat="${i}"><b>${esc(h)}</b>${s ? ` <span>${esc(s)}</span>` : ""}</li>`).join("");
  const calm = CALM.map((c, i) => `<li class="calm__card" style="--ci:${i + 1}">${face(c.who, "face face--sm")}<div><b>${esc(c.title)}</b><span>${esc(c.line)}</span></div></li>`).join("");
  return `<section class="problem" id="problem" data-problem aria-labelledby="problem-h">
  <div class="problem__pin">
    <div class="problem__text">
      <ol class="beats" data-beats>${beats}</ol>
      <h2 id="problem-h" class="h2 h2--wide problem__head" data-head><span class="t1">One brain for everything your business knows.</span> <span class="t2">Allevia pulls it into one place, sorts it, and hands you a short list: answers, and things waiting for your OK.</span></h2>
    </div>
    <div class="problem__stage" data-pstage>
      <svg class="problem__links" viewBox="-50 -50 100 100" preserveAspectRatio="none" aria-hidden="true">${links}</svg>
      <div class="problem__halo" aria-hidden="true"></div>
      <img class="problem__brain" src="/shared/img/brain-still-900.webp" srcset="/shared/img/brain-still-480.webp 480w, /shared/img/brain-still-900.webp 900w" sizes="(max-width: 52rem) 70vw, 420px" width="900" height="900" alt="The company brain" loading="lazy" decoding="async">
      <div class="founder" data-founder><span class="founder__badge">R</span><span class="founder__label">You</span></div>
      ${html}
      <ul class="calm" data-calm>${calm}</ul>
    </div>
  </div>
</section>`;
}

// ---------- a glimpse of what it does: three cards, each a page ----------

export function glimpse(): string {
  return `<section class="glimpse wrap" aria-labelledby="glimpse-h">
  <h2 id="glimpse-h" class="h2 h2--wide"><span class="t1">Ask anything. Your team does the work.</span> <span class="t2">You tap OK.</span></h2>
  <ul class="glimpse__row">
    <li class="glimpse__card">
      <div class="gl gl--ask" aria-hidden="true">
        <p class="gl__q">Who hasn’t replied to our quote?</p>
        <p class="gl__a">${face("sales-lead", "face face--sm")}<span>Sana at Sahyadri Hotels has an open quote and no call booked. I drafted a nudge.</span></p>
      </div>
      <h3>Ask anything</h3><p>Ask in your own words. The answer comes from your tools, with the sources.</p>
      <a class="link" href="/product/#ask">How asking works</a>
    </li>
    <li class="glimpse__card">
      <div class="gl gl--team" aria-hidden="true">
        <div class="gl__faces">${["data-analyst", "growth-marketer", "content-strategist", "sales-lead", "tech-lead"].map((a) => face(a, "face face--md")).join("")}</div>
        <div class="gl__logos">${["gmail", "google-ads", "instagram", "google-calendar", "hubspot"].map((t) => `<span class="gl__logo">${logoMarkup(t, 22)}</span>`).join("")}</div>
      </div>
      <h3>Your team makes and acts</h3><p>Ten people with names. Numbers, ads, posts, replies, fixes. Each works inside your tools.</p>
      <a class="link" href="/team/">Meet the team</a>
    </li>
    <li class="glimpse__card">
      <div class="gl gl--ok" aria-hidden="true">
        <p class="gl__what">${face("content-strategist", "face face--sm")}<span><b>Diwali reel</b><br>Draft in Hindi and English</span></p>
        <p class="gl__btns"><span class="gl__b gl__b--ok">Approve</span><span class="gl__b">Change</span><span class="gl__b">No thanks</span></p>
      </div>
      <h3>You tap OK</h3><p>Nothing is posted, sent, booked or spent until you say so. In the app or in Discord.</p>
      <a class="link" href="/product/#ok">How approvals work</a>
    </li>
  </ul>
</section>`;
}

// ---------- tools strip ----------

export function teaser(): string {
  const ids = ["gmail", "google-calendar", "google-analytics", "google-ads", "meta-ads", "instagram", "shopify", "stripe", "hubspot", "slack", "whatsapp", "mailchimp"];
  const chips = ids.map((id) => `<li class="tchip">${logoMarkup(id, 24)}<span>${esc(logo(id)?.name ?? id)}</span></li>`).join("");
  return `<section class="teaser wrap" aria-labelledby="teaser-h">
  <p id="teaser-h" class="teaser__lede"><span class="t1">Works with the tools you already use.</span> <a class="link" href="/integrations/">See every integration</a></p>
  <ul class="teaser__row">${chips}</ul>
</section>`;
}

// ---------- the flow: many problems in, finished work out ----------

export function flow(): string {
  const left = PROBLEMS.map((p, i) => `<li class="fcard fcard--in" data-fi="${i}"><span class="fcard__dot" aria-hidden="true"></span>${esc(p)}</li>`).join("");
  const right = OUTCOMES.map((o, i) => `<li class="fcard fcard--out" data-fo="${i}"><span class="fcard__logo">${logoMarkup(o.logo, 24)}</span><span class="fcard__t"><b>${esc(o.title)}</b><span>${esc(o.line)}</span></span><span class="fcard__ok" aria-label="You said OK"></span></li>`).join("");
  return `<section class="flow" id="flow" data-flow aria-labelledby="flow-h">
  <div class="wrap">
    <h2 id="flow-h" class="h2 h2--wide"><span class="t1">Many problems in. Finished work out.</span> <span class="t2">Everything you carry goes into one place, and comes back as something done.</span></h2>
    <div class="flow__stage" data-fstage>
      <canvas class="flow__canvas" data-fcanvas aria-hidden="true"></canvas>
      <ul class="flow__col flow__col--in" aria-label="What you carry">${left}</ul>
      <div class="flow__app" data-fapp>
        <figure class="device device--laptop"><img src="/media/shot-answer.webp" width="1200" height="900" alt="The Allevia app: a question and its answer with the sources" loading="lazy" decoding="async"></figure>
        <span class="flow__ring" aria-hidden="true"></span>
      </div>
      <ul class="flow__col flow__col--out" aria-label="What comes back">${right}</ul>
    </div>
    <p class="flow__note">Sample business: Shiftly. Made-up data. Every outcome waited for an OK first.</p>
  </div>
</section>`;
}

// ---------- one button ----------

export function closeCta(): string {
  return `<section class="close wrap" aria-labelledby="close-h">
  <h2 id="close-h" class="h2 h2--wide"><span class="t1">Start with a free Brain Snapshot.</span> <span class="t2">Send us your website. We send back what we learned and five fixes, before you pay.</span></h2>
  <p><a class="btn btn-gold btn-lg" href="/contact/">Get a free Brain Snapshot</a></p>
</section>`;
}

export const HOME_SECTIONS: Record<string, () => string> = { problem, glimpse, teaser, flow, close: closeCta };
