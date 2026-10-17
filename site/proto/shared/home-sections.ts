// The home page's story sections (shared by prototypes A and B), one story in this order: the founder's problems pulled into one brain
// (dark), the problems-to-outcomes flow (paper), the team at work (dark: the real office), a rough photo made into an ad (paper), the OK
// (dark), a short look at the plans and the one button (paper). Two colours only. Built at compile time; behaviour in home-client.ts.
import { AGENTS, BRAIN_GRAPH } from "./assets.generated.ts";
import { CALM, FLOW_PATHS, NOISE, OUTCOMES, PROBLEMS } from "./data.ts";
import { logoMarkup } from "./logos.ts";
import { okBlock, PLAN_CARDS } from "./page-sections.ts";
import { esc } from "./util.ts";
import { pricingVisible } from "./flags.ts";

const face = (id: string, cls = "face") => `<span class="${cls}" role="img" aria-label="${esc(AGENTS[id]?.name ?? id)}">${AGENTS[id]?.svg ?? ""}</span>`;
const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };

// ---------- the problem scene: the founder's noise, pulled into one calm brain ----------

const BEATS: [string, string][] = [
  ["Too many people to answer.", "Customers, staff, suppliers, agencies."],
  ["Too many tools.", "Each with its own logins and its own numbers."],
  ["Too much to remember.", "Who was promised what, and why you decided it."],
  ["Nobody has the whole picture.", "Every tool holds a piece. None of them talk."],
  ["And all of it lands on you.", ""],
];

const TOOL_TABS: [string, string][] = [["google-ads", "Ads Manager"], ["google-analytics", "Analytics"], ["instagram", "Instagram"], ["gmail", "Inbox"], ["google-calendar", "Calendar"], ["shopify", "Shop admin"], ["hubspot", "CRM"], ["slack", "Slack"], ["whatsapp", "WhatsApp"], ["stripe", "Payments"]];
const BADGES = [12, 3, 27, 47, 5, 9, 14, 8, 31, 2];

export function problem(): string {
  const r = rng(11);
  type Kind = "people" | "tools" | "memory" | "alerts";
  const pool: { kind: Kind; html: string }[] = [];
  NOISE.people.forEach((t, i) => pool.push({ kind: "people", html: `<span class="nz__dot" style="--c:${["#9a5232", "#7a5a3a", "#a1743a", "#6b4a2e", "#8a6a2a", "#8a4a2a"][i % 6]}">${esc(t[0]!)}</span><span>${esc(t)}</span>` }));
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
  return `<section class="problem sec band band--ink" id="problem" data-problem aria-labelledby="problem-h">
  <div class="problem__pin">
    <div class="problem__text on-ink">
      <ol class="beats" data-beats>${beats}</ol>
      <h2 id="problem-h" class="h2 h2--wide problem__head" data-head><span class="t1">One brain for everything your business knows.</span></h2>
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

// ---------- the flow: many problems in, finished work out ----------

/** The real graph (47 things, 60 links) and, for each problem, the nodes its answer runs through, for the living picture. */
function graphJson(): string {
  const nodes = BRAIN_GRAPH.nodes; const ix = new Map(nodes.map((n, i) => [n[0], i]));
  const stories = FLOW_PATHS.map((p) => p.map((id) => ix.get(id)).filter((i): i is number => i !== undefined));
  return JSON.stringify({ nodes: nodes.map((n) => [n[1], n[2], n[3], n[4]]), edges: BRAIN_GRAPH.edges, stories }).replace(/</g, "\\u003c");
}

export function flow(): string {
  const left = PROBLEMS.map((p, i) => `<li class="fcard fcard--in" data-fi="${i}"><span class="fcard__dot" aria-hidden="true"></span>${esc(p)}</li>`).join("");
  const right = OUTCOMES.map((o, i) => `<li class="fcard fcard--out" data-fo="${i}"><span class="fcard__logo">${logoMarkup(o.logo, 24)}</span><span class="fcard__t"><b>${esc(o.title)}</b><span>${esc(o.line)}</span></span><span class="fcard__ok" aria-label="You said OK"></span></li>`).join("");
  return `<section class="flow sec" id="flow" data-flow aria-labelledby="flow-h">
  <div class="wrap">
    <h2 id="flow-h" class="h2 h2--wide h2--split"><span class="t1">Many problems in.</span> <span class="t2">Finished work out.</span></h2>
    <div class="flow__stage" data-fstage>
      <canvas class="flow__canvas" data-fcanvas aria-hidden="true"></canvas>
      <ul class="flow__col flow__col--in" aria-label="What you carry">${left}</ul>
      <div class="flow__app" data-fapp>
        <div class="gpanel" role="img" aria-label="The company brain as a graph of everything the business knows. Each problem lights up the part of it that holds the answer.">
          <img class="gpanel__brain" src="/shared/img/brain-still-900.webp" width="900" height="900" alt="" loading="lazy" decoding="async">
          <canvas class="gpanel__canvas" data-gcanvas aria-hidden="true"></canvas>
          <div class="gpanel__labels" data-glabels aria-hidden="true"></div>
          <p class="gpanel__cap" data-gcap aria-hidden="true">Company brain</p>
        </div>
        <span class="flow__ring" aria-hidden="true"></span>
      </div>
      <script type="application/json" id="graph-data">${graphJson()}</script>
      <ul class="flow__col flow__col--out" aria-label="What comes back">${right}</ul>
    </div>
  </div>
</section>`;
}

// ---------- one button ----------

export function closeCta(): string {
  return `<section class="cta sec" aria-labelledby="close-h">
  <div class="wrap cta__in">
    <h2 id="close-h" class="h2">Start with a free Brain Snapshot.</h2>
    <p class="cta__sub">Send us your website. We send back what we learned and five fixes.</p>
    <p><a class="btn btn-gold btn-lg" href="/contact/#snapshot">Get a free Brain Snapshot</a></p>
  </div>
</section>`;
}

// ---------- the plans, in three lines ----------

export function pricingTeaser(): string {
  if (!pricingVisible()) return ""; // the plans are hidden with the pricing page (flags.ts)
  const cards = PLAN_CARDS.map((c) => `<li class="pmini ${c.lead ? "pmini--lead" : ""}"><h3 class="pmini__name">${esc(c.name)}</h3><p class="pmini__note">${esc(c.note)}</p><p class="pmini__price"><span class="money">$${c.price.toLocaleString("en-US")}</span><span class="per"> a month</span></p></li>`).join("");
  return `<section class="ptease sec" id="plans" aria-labelledby="pt-h">
  <div class="wrap">
    <h2 id="pt-h" class="h2 h2--split"><span class="t1">Simple monthly plans.</span> <span class="t2">Start at $${PLAN_CARDS[0]!.price}.</span></h2>
    <ul class="pmini-row">${cards}</ul>
    <p class="ptease__more"><a class="link" href="/pricing/">See what is in each plan</a></p>
  </div>
</section>`;
}

// ---------- the brain that keeps growing, and still finds things in a few hops ----------

/** The real 47-node graph, then, for the picture only, more nodes around the same five groups as the weeks go by (week 1, month 3, year 1). */
function growJson(): string {
  const r = rng(29);
  const real = BRAIN_GRAPH.nodes;
  const nodes: [number, number, number, number][] = real.map((n) => [n[1], n[2], n[3], 0]); // x, y, cluster, stage
  const edges: [number, number, number][] = BRAIN_GRAPH.edges.map(([a, b]) => [a, b, 0]); // a, b, stage
  const centre = (c: number) => { const m = real.filter((n) => n[3] === c); return [m.reduce((s, n) => s + n[1], 0) / m.length, m.reduce((s, n) => s + n[2], 0) / m.length] as const; };
  const gauss = () => (r() + r() + r() + r() - 2) / 2;
  const add = (count: number, stage: number) => {
    for (let k = 0; k < count; k++) {
      const c = Math.floor(r() * 5); const [cx, cy] = centre(c);
      const x = Math.min(0.97, Math.max(0.03, cx + gauss() * 0.2)), y = Math.min(0.97, Math.max(0.03, cy + gauss() * 0.2));
      const idx = nodes.length; nodes.push([+x.toFixed(3), +y.toFixed(3), c, stage]);
      const near = nodes.slice(0, idx).map((n, i) => [i, (n[0] - x) ** 2 + (n[1] - y) ** 2] as const).sort((a, b) => a[1] - b[1]).slice(0, 2 + (r() < 0.35 ? 1 : 0));
      near.forEach(([i]) => edges.push([i, idx, stage]));
    }
  };
  add(120, 1); add(320, 2);
  const ix = new Map(real.map((n, i) => [n[0], i]));
  const path = FLOW_PATHS[4]!.length ? ["feature:seekers-signup-phone-number-entered", "page:screen/app/auth/sign-up", "event:sentry-issue-shiftly-41", "event:release-shiftly-2-8-0", "person:farhan"].map((id) => ix.get(id)!).filter((i) => i !== undefined) : [];
  return JSON.stringify({ nodes, edges, path, labels: path.map((i) => real[i]![4]) }).replace(/</g, "\\u003c");
}

export function grow(): string {
  return `<section class="grow sec band band--ink" id="grow" data-grow aria-labelledby="grow-h">
  <div class="wrap grow__in">
  <div class="grow__copy on-ink">
    <h2 id="grow-h" class="h2 h2--split"><span class="t1">It keeps growing.</span> <span class="t2">The longer you use it, the more it knows.</span></h2>
    <ul class="grow__points">
      <li>It keeps every decision, conversation and number, with where it came from.</li>
      <li>It links them, so your team reaches an answer in a few hops and stays quick as the brain grows.</li>
      <li>The links live in <a href="https://www.falkordb.com" rel="noopener">FalkorDB</a>, a graph database.</li>
    </ul>
  </div>
  <div class="grow__viz">
    <div class="gpanel gpanel--grow" role="img" aria-label="The company brain as a graph that gets bigger over a week, three months and a year. The same question lights the same short path through it each time.">
      <img class="gpanel__brain" src="/shared/img/brain-still-900.webp" width="900" height="900" alt="" loading="lazy" decoding="async">
      <canvas class="gpanel__canvas" data-grow-canvas aria-hidden="true"></canvas>
      <div class="gpanel__labels" data-grow-labels aria-hidden="true"></div>
      <p class="gpanel__cap" data-grow-cap aria-hidden="true">Week 1</p>
    </div>
    <div class="grow__ctl" role="group" aria-label="How long you have used it">
      <button type="button" class="grow__b" data-grow-stage="0" aria-pressed="true">Week 1</button>
      <button type="button" class="grow__b" data-grow-stage="1" aria-pressed="false">Month 3</button>
      <button type="button" class="grow__b" data-grow-stage="2" aria-pressed="false">Year 1</button>
    </div>
    <p class="grow__ask"><span>Why did sign-ups drop?</span> <b>The answer is 4 hops away</b></p>
  </div>
  </div>
  <script type="application/json" id="grow-data">${growJson()}</script>
</section>`;
}

// ---------- the team at work: the real office, running ----------

/** The zones of the office floor as the app lays them out (web/src/office/layout.ts, landscape: 570 by 244 logical px). `x` and `y` are where each zone's hanging sign
 *  sits, as fractions of the floor, so the label lands in the same place on the clip at any size. The name is the one the owner knows (the roster's "Center of
 *  Excellence" is the numbers team). */
const ZONES: [string, number, number][] = [
  ["Library", 42, 22], ["Analytics", 118, 22], ["Chief of Staff", 209, 22], ["Numbers", 300, 22], ["Sales", 376, 22], ["Cafeteria", 490, 22],
  ["Marketing", 41, 154], ["Content Studio", 144, 154], ["Tech", 276, 154], ["Operations", 379, 154], ["Game room", 545, 154],
];

export function office(): string {
  const labels = ZONES.map(([name, x, y]) => `<li class="office__zone" style="--x:${(x / 570).toFixed(4)};--y:${(y / 244).toFixed(4)}">${esc(name)}</li>`).join("");
  return `<section class="office sec band band--ink" id="team-works" aria-labelledby="office-h">
  <div class="wrap office__in">
    <h2 id="office-h" class="h2 h2--wide h2--split on-ink"><span class="t1">See what your team is working on,</span> <span class="t2">right now.</span></h2>
    <figure class="office__frame">
      <div class="office__scroll">
        <div class="office__stage">
          <video class="office__video" muted loop playsinline preload="none" poster="/shared/img/office-live-poster.webp" src="/shared/img/office-live.mp4" width="2236" height="932" aria-label="The Allevia office: your team at their desks, working, with three office dogs."></video>
          <ul class="office__zones" aria-label="The teams on the floor">${labels}</ul>
        </div>
      </div>
    </figure>
  </div>
</section>`;
}

// ---------- a rough photo, made into an ad ----------

export function makes(): string {
  return `<section class="makes sec" id="makes" aria-labelledby="makes-h">
  <div class="wrap makes__in">
    <h2 id="makes-h" class="h2 h2--split makes__h"><span class="t1">Snap it on your phone.</span> <span class="t2">Get an ad worth posting.</span></h2>
    <div class="makes__media">
      <figure class="pframe ba" data-ba style="--pos:50%">
        <div class="ba__view">
          <img class="ba__img" src="/shared/img/photo-rough.webp" width="752" height="1344" alt="A rough phone photo of a candle on a kitchen counter." loading="lazy" decoding="async">
          <img class="ba__img ba__img--after" src="/shared/img/photo-ad.webp" width="960" height="1698" alt="The same candle as a warm product ad, ready to post." loading="lazy" decoding="async">
          <span class="ba__tag ba__tag--l">Your photo</span><span class="ba__tag ba__tag--r">The ad</span>
          <span class="ba__bar" aria-hidden="true"><i class="ba__knob"></i></span>
          <input class="ba__range" type="range" min="0" max="100" step="1" value="50" aria-label="Slide to compare your photo with the ad">
        </div>
      </figure>
      <figure class="pframe clip">
        <div class="ba__view">
          <video class="clip__video" muted loop playsinline preload="none" poster="/shared/img/photo-ad.webp" src="/shared/img/photo-ad-clip.mp4" width="720" height="1276" aria-label="A five second reel made from the ad: the candle flame flickers in warm window light."></video>
          <span class="ba__tag ba__tag--r">The reel</span>
        </div>
      </figure>
    </div>
  </div>
</section>`;
}

// ---------- you tap OK ----------

export function okHome(): string {
  return okBlock("ok", `\n    <p class="okd__more on-ink"><a class="link" href="/product/#grow">See how it keeps growing</a></p>`);
}

export const HOME_SECTIONS: Record<string, () => string> = { problem, grow, flow, close: closeCta, office, makes, ok: okHome, plans: pricingTeaser };
