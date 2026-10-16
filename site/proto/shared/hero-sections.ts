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
    <h1 id="hero-h" class="hero__h1"><span class="t1">Founder OS.</span> <span class="t2">Your company brain plus an AI team that works with all your tools.</span></h1>
    <p class="hero__cta"><a class="btn btn-gold" href="/contact/">Get a free Brain Snapshot</a><a class="btn btn-ghost" href="#problem">See how it works</a></p>
    <p class="hero__fine">Sample business: Shiftly. Made-up data.</p>
  </div>
  <button class="hero__next" type="button" data-next hidden>Next question</button>
  <p class="visually-hidden">The brain answers questions founders ask every day. ${esc(sr)}</p>
  <script type="application/json" id="hero-data">${heroData()}</script>
</section>`;
}
