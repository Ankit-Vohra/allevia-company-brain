// Build-time HTML for prototype A's hero: the copy, the stage (canvas, tool and team chips) and the questions the brain answers.
// The 3D scene itself lives in site/proto/a/hero3d.ts and reads the chips and the JSON written here.
import { AGENTS, BRAIN } from "./assets.generated.ts";
import { QUESTIONS, labelOf } from "./data.ts";
import { logoMarkup, logo } from "./logos.ts";
import { esc } from "./util.ts";

/** Which orbit each chip rides and in what order (the orbit shapes are in hero3d.ts). Team on the four inner orbits, tools on the four outer. */
export const ORBIT_SLOTS: { kind: "agent" | "tool"; id: string; orbit: number }[] = [
  { kind: "agent", id: "chief-of-staff", orbit: 0 }, { kind: "agent", id: "data-analyst", orbit: 0 },
  { kind: "agent", id: "growth-marketer", orbit: 1 }, { kind: "agent", id: "content-strategist", orbit: 1 },
  { kind: "agent", id: "sales-lead", orbit: 2 }, { kind: "agent", id: "tech-lead", orbit: 2 },
  { kind: "agent", id: "oncall-engineer", orbit: 3 }, { kind: "agent", id: "coe-lead", orbit: 3 },
  { kind: "tool", id: "gmail", orbit: 4 }, { kind: "tool", id: "google-ads", orbit: 4 }, { kind: "tool", id: "instagram", orbit: 4 },
  { kind: "tool", id: "google-analytics", orbit: 5 }, { kind: "tool", id: "meta-ads", orbit: 5 }, { kind: "tool", id: "shopify", orbit: 5 },
  { kind: "tool", id: "hubspot", orbit: 6 }, { kind: "tool", id: "google-calendar", orbit: 6 }, { kind: "tool", id: "stripe", orbit: 6 },
  { kind: "tool", id: "slack", orbit: 7 }, { kind: "tool", id: "whatsapp", orbit: 7 },
];

const chipHtml = (s: (typeof ORBIT_SLOTS)[number], i: number): string => {
  if (s.kind === "agent") {
    const a = AGENTS[s.id];
    if (!a) return "";
    return `<span class="orb-chip orb-chip--agent" data-chip data-kind="agent" data-id="${s.id}" data-orbit="${s.orbit}" data-i="${i}"><span class="orb-chip__face">${a.svg}</span><span class="orb-chip__name">${esc(a.name)}</span></span>`;
  }
  const l = logo(s.id);
  return `<span class="orb-chip orb-chip--tool" data-chip data-kind="tool" data-id="${s.id}" data-orbit="${s.orbit}" data-i="${i}"><span class="orb-chip__logo">${logoMarkup(s.id, 26)}</span><span class="orb-chip__name">${esc(l?.name ?? s.id)}</span></span>`;
};

export function heroData(): string {
  const questions = QUESTIONS.map((q) => {
    const regions: string[] = [];
    for (const n of q.path) {
      const c = (BRAIN.nodeCluster as Record<string, string>)[n];
      if (c && regions[regions.length - 1] !== c) regions.push(c);
    }
    return {
      id: q.id, agent: q.agent, agentName: AGENTS[q.agent]?.name ?? "", q: q.q, tools: q.tools,
      toolNames: q.tools.map((t) => logo(t)?.name ?? t), regions, path: q.path.map(labelOf), answer: q.answer,
      waits: /waits for your OK/.test(q.answer),
    };
  });
  return JSON.stringify({ questions, counts: BRAIN.counts }).replace(/</g, "\\u003c");
}

/** The one supporting line under the headline: not something that only answers, but a brain that remembers and a team that does the work. */
const HERO_SUB = "Allevia is your Founder OS. It remembers everything, works while you’re away, and gets real work done in the tools you already use.";

// ---------- prototype B: the calm diagram ----------

const B_TOOLS = ["gmail", "google-calendar", "google-ads", "meta-ads", "google-analytics", "instagram", "hubspot"];
const B_TEAM = ["chief-of-staff", "data-analyst", "growth-marketer", "content-strategist", "sales-lead", "tech-lead"];
const ROLE: Record<string, string> = { "chief-of-staff": "Chief of Staff", "data-analyst": "Analytics", "growth-marketer": "Marketing", "content-strategist": "Content", "sales-lead": "Sales", "tech-lead": "Tech" };
const CLUSTER_AREA: Record<string, string> = { people: "p", signups: "s", app: "a", reach: "r", customers: "c" };

export function heroB(): string {
  const tools = B_TOOLS.map((id) => `<li class="wtool" data-tool="${id}">${logoMarkup(id, 22)}<span>${esc(logo(id)?.name ?? id)}</span></li>`).join("");
  const team = B_TEAM.map((id) => `<li class="wagent" data-agent="${id}"><span class="face face--sm" aria-hidden="true">${AGENTS[id]?.svg ?? ""}</span><span><b>${esc(AGENTS[id]?.name ?? id)}</b><i>${ROLE[id]}</i></span></li>`).join("");
  const clusters = BRAIN.clusters.map((c) => `<li class="ccard" data-cluster="${c.id}" style="grid-area:${CLUSTER_AREA[c.id]}"><b>${esc(c.label)}</b><span class="num">${c.count}</span><i>${esc(c.sample.slice(0, 3).join(", "))}</i></li>`).join("");
  return `<section class="bhero" data-bhero aria-labelledby="bh-h">
  <div class="wrap bhero__copy">
    <h1 id="bh-h" class="bhero__h1"><span class="t1">Your company’s brain.</span> <span class="t2">And the team that runs on it.</span></h1>
    <p class="bhero__sub">${HERO_SUB}</p>
    <p class="bhero__cta"><a class="btn btn-gold" href="/contact/">Get a free Brain Snapshot</a><a class="btn btn-ghost" href="#problem">See how it works</a></p>
  </div>
  <div class="wrap">
    <div class="ws" data-ws role="group" aria-label="The company brain with its tools and its team, answering a founder's questions">
      <svg class="ws__lines" data-lines aria-hidden="true"></svg>
      <div class="ws__col ws__col--tools"><p class="ws__label">Your tools</p><ul>${tools}</ul></div>
      <div class="ws__brain">
        <ul class="hub">${clusters}</ul>
        <div class="nucleus" data-nuc><img src="/shared/img/brain-still-480.webp" width="480" height="480" alt="" decoding="async"><b>Company brain</b><span class="num">${BRAIN.counts.nodes} things, ${BRAIN.counts.edges} links</span><i class="nucleus__ring" aria-hidden="true"></i></div>
      </div>
      <div class="ws__col ws__col--team"><p class="ws__label">Your team</p><ul>${team}</ul></div>
      <div class="ws__ask">
        <div class="composer" data-composer><span class="composer__ph" data-ph>Ask your team anything</span><span class="composer__typed" data-typed></span><i class="caret" aria-hidden="true"></i></div>
        <article class="wanswer" data-wanswer>
          <header><span class="face face--sm" data-wface></span><b data-wwho></b><span class="wanswer__ok" data-wok>Waiting for your OK</span></header>
          <p data-wtext></p><p class="wanswer__how" data-whow></p>
        </article>
      </div>
      <figure class="ws__office" data-office><video muted loop playsinline preload="none" poster="/media/office-loop-poster.webp" data-src="/media/office-loop.mp4" aria-label="Your team at their desks, with the office dogs"></video><figcaption>Your team at their desks</figcaption></figure>
    </div>
  </div>
  <button class="hero__next" type="button" data-next hidden>Next question</button>
  <p class="visually-hidden">The brain answers questions founders ask every day. ${esc(QUESTIONS.map((q) => `${q.q} ${q.answer}`).join(" "))}</p>
  <script type="application/json" id="hero-data">${heroData()}</script>
</section>`;
}

export function heroA(): string {
  const chips = ORBIT_SLOTS.map(chipHtml).join("");
  const sr = QUESTIONS.map((q) => `${q.q} ${q.answer}`).join(" ");
  return `<section class="hero" data-hero aria-labelledby="hero-h">
  <div class="hero__stage" data-stage aria-hidden="true">
    <div class="hero__glow" data-glow></div>
    <div class="hero__floor" data-floor></div>
    <img class="hero__still" data-still src="/shared/img/brain-still-900.webp" srcset="/shared/img/brain-still-480.webp 480w, /shared/img/brain-still-900.webp 900w" sizes="380px" width="900" height="900" alt="" decoding="async" fetchpriority="high">
    <canvas class="hero__canvas" data-canvas></canvas>
    <div class="hero__chips" data-chips>${chips}</div>
    <div class="hero__bubble" data-bubble><span class="hero__bubble-name" data-bubble-name></span><span class="hero__bubble-text" data-bubble-text></span></div>
    <article class="hero__answer" data-answer>
      <header class="hero__answer-head"><span class="hero__answer-face" data-answer-face></span><span class="hero__answer-who" data-answer-who></span><span class="hero__answer-ok" data-answer-ok>Waiting for your OK</span></header>
      <p class="hero__answer-text" data-answer-text></p>
      <p class="hero__answer-how" data-answer-how></p>
    </article>
  </div>
  <div class="wrap hero__copy">
    <h1 id="hero-h" class="hero__h1"><span class="t1">Your company’s brain.</span> <span class="t2">And the team that runs on it.</span></h1>
    <p class="hero__sub">${HERO_SUB}</p>
    <p class="hero__cta"><a class="btn btn-gold" href="/contact/">Get a free Brain Snapshot</a><a class="btn btn-ghost" href="#problem">See how it works</a></p>
  </div>
  <button class="hero__next" type="button" data-next hidden>Next question</button>
  <p class="visually-hidden">The brain answers questions founders ask every day. ${esc(sr)}</p>
  <script type="application/json" id="hero-data">${heroData()}</script>
</section>`;
}
