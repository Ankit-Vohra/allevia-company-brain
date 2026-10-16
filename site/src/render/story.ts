// Build-time HTML for the home page's scroll story (src/story-content.ts) and the courier route. Plain, complete HTML:
// the page reads top to bottom with JavaScript off, and src/story.ts only adds motion on top.
import { BUILT_IN, CHECKUP_TOP, CONTROL_NUMBERS, ONE_REQUEST, PLAN_SAMPLE, ROUTE, USE_CASES, WATERLINE, WE_DO_NOT, WORK, YOUR_ACCOUNTS } from "../story-content.ts";
import { dogSvg, spriteSvg, treatSvg } from "./sprites.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n: number) => n.toLocaleString("en-US");

/** The courier route: six stops, each a link to its section; Fluffy walks it as you scroll (src/story.ts). */
export function route(): string {
  const stops = ROUTE.map(
    (s, i) => `<li class="route__stop" data-stop="${i}"><a href="#${s.id}"><span class="route__dot">${treatSvg(12)}</span><span class="route__name">${esc(s.name)}</span></a></li>`,
  ).join("");
  return `<nav class="route" aria-label="Stops on this page" data-route>
  <div class="route__track">
    <ol class="route__stops">${stops}</ol>
    <div class="route__dog" data-route-dog aria-hidden="true">${dogSvg("fluffy", { size: 46 })}<span class="route__doc" data-your-site-short>your website</span></div>
  </div>
</nav>`;
}

/** The hero's paste field. Hidden without JavaScript (it only works on this page); what you type never leaves it. */
export function pasteField(): string {
  return `<form class="paste" data-paste hidden novalidate>
  <label class="paste__label" for="your-site">Your website</label>
  <div class="paste__row">
    <input class="paste__input" id="your-site" name="site" type="text" inputmode="url" autocomplete="url" spellcheck="false" placeholder="yourbusiness.com" aria-describedby="your-site-hint">
    <button class="btn btn-ink paste__go" type="submit">Follow it</button>
  </div>
  <p class="paste__hint" id="your-site-hint">Type it and Fluffy carries it down this page. It stays on this page and is not sent anywhere.</p>
</form>`;
}

export function oneRequest(): string {
  return `<ol class="request">${ONE_REQUEST.map(
    (s, i) => `<li class="request__step" data-sc-cue="${(0.04 + i * 0.13).toFixed(2)} 1 0.06 0.02"><p class="request__who">${esc(s.who)}</p><p class="request__says">${esc(s.says)}</p></li>`,
  ).join("")}</ol>`;
}

export function controlNumbers(): string {
  return `<ul class="controls">${CONTROL_NUMBERS.map((c) => `<li><p class="controls__fig">${esc(c.figure)}</p><p class="controls__label">${esc(c.label)}</p></li>`).join("")}</ul>`;
}

export function waterline(): string {
  const layers = WATERLINE.map(
    (l, i) => `<li class="layer" style="--i:${i}"><h3 class="layer__name">${esc(l.name)}</h3><p class="layer__does">${esc(l.does)}</p><p class="layer__without"><span>Without it:</span> ${esc(l.without)}</p></li>`,
  ).join("");
  return `<ol class="layers">${layers}</ol>`;
}

export function workRail(): string {
  const items = WORK.map((w) => {
    const media = w.video
      ? `<figure class="exhibit__media exhibit__media--video" data-loop><img class="loop__poster" src="${w.poster}" width="${w.w}" height="${w.h}" loading="lazy" decoding="async" alt="${esc(w.alt)}"><video class="loop__video" muted loop playsinline preload="none" aria-hidden="true" tabindex="-1" data-mp4="${w.video}"></video><button class="loop__pause" type="button" hidden data-loop-pause aria-pressed="false">Pause the reel</button></figure>`
      : `<figure class="exhibit__media"><img src="${w.img}" width="${w.w}" height="${w.h}" loading="lazy" decoding="async" alt="${esc(w.alt)}"></figure>`;
    const note = w.note ? `<p class="exhibit__note">${esc(w.note)}</p>` : "";
    return `<article class="exhibit">${media}<h3 class="exhibit__what">${esc(w.what)}</h3><dl class="exhibit__label"><div><dt>Made by</dt><dd>${esc(w.who)}</dd></div><div><dt>Time</dt><dd>${esc(w.time)}</dd></div><div><dt>Now</dt><dd>${esc(w.status)}</dd></div></dl>${note}</article>`;
  }).join("");
  const checkup = `<article class="exhibit exhibit--text"><div class="exhibit__report"><p class="exhibit__report-h">Your website is losing enquiries in a few places. Fix these first.</p><ol>${CHECKUP_TOP.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></div><h3 class="exhibit__what">A website check-up for the same studio</h3><dl class="exhibit__label"><div><dt>Made by</dt><dd>Arjun and Zoya, Tech</dd></div><div><dt>Time</dt><dd>1 minute 53 seconds, 24 pages read</dd></div><div><dt>Now</dt><dd>The top five, quoted from the real report</dd></div></dl></article>`;
  return `<div class="rail" data-sc-pan="0.04" role="region" aria-label="Work the team made, scrolls sideways" tabindex="0">
  <div class="rail__lead"><h2 class="story-h" id="made-h">Not just answers. Things you can use.</h2><p class="story-p">Real work from our first two businesses this week: an architecture studio and a jobs app, both in Raipur. Each piece waits for its owner's OK.</p></div>
  ${items}${checkup}
  <div class="rail__end"><p class="story-p">Every piece above was made by the team, checked by the team, and is still waiting for a person to say OK.</p></div>
</div>`;
}

export function useCases(): string {
  return `<ul class="cases">${USE_CASES.map(
    (u) => `<li class="case${u.real ? "" : " case--example"}"><h3 class="case__h">${esc(u.head)}</h3><p class="case__p">${esc(u.body)}</p><p class="case__tag">${u.real ? "This week, for real" : "An example of a first week"}</p></li>`,
  ).join("")}</ul>`;
}

export function connections(): string {
  const yours = YOUR_ACCOUNTS.map((a) => `<li class="conn${a.live ? " is-live" : ""}"><span class="conn__name">${esc(a.name)}</span><span class="conn__status">${esc(a.status)}</span></li>`).join("");
  const built = BUILT_IN.map((b) => `<li class="conn is-live"><span class="conn__name">${esc(b.name)}</span><span class="conn__status">${esc(b.does)}</span></li>`).join("");
  return `<div class="conns">
  <section class="conns__col" aria-labelledby="conn-yours"><h3 class="conns__h" id="conn-yours">Your accounts</h3><p class="conns__p">Things only you can connect. Today that is your website and your numbers in a spreadsheet; the rest is being built, and we will say so until it works.</p><ul>${yours}</ul></section>
  <section class="conns__col" aria-labelledby="conn-built"><h3 class="conns__h" id="conn-built">Built in, no account needed</h3><p class="conns__p">Useful on day one, before you connect anything.</p><ul>${built}</ul></section>
</div>`;
}

export function weDoNot(): string {
  return `<ul class="donot">${WE_DO_NOT.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
}

/** The three goals moving from where the sample business started to where it is now. CSS reads --sc-p (0..1). */
export function planBars(): string {
  const rows = PLAN_SAMPLE.map((g) => {
    const from = (g.from / g.goal).toFixed(3);
    const to = (g.now / g.goal).toFixed(3);
    const push = g.status !== "Going well" ? " goal--push" : "";
    return `<li class="goal${push}" style="--from:${from};--to:${to}">
  <div class="goal__top"><h3 class="goal__name">${esc(g.name)}</h3><p class="goal__status">${esc(g.status)}</p></div>
  <div class="goal__bar" aria-hidden="true"><span class="goal__start"></span><span class="goal__fill"></span></div>
  <p class="goal__nums"><span class="goal__now"><span class="num">${fmt(g.now)}</span> ${esc(g.unit)}</span> <span class="goal__from">started at ${fmt(g.from)}</span> <span class="goal__goal">Goal ${fmt(g.goal)}</span> <span class="goal__who">${spriteSvg(whoId(g.who), { size: 20, portrait: true })}${esc(g.who)}</span></p>
</li>`;
  }).join("");
  return `<ol class="goals">${rows}</ol>`;
}

const WHO: Record<string, string> = { Rohan: "growth-marketer", Tara: "content-strategist", Kabir: "data-analyst" };
const whoId = (name: string) => WHO[name] ?? "chief-of-staff";

export const STORY_BLOCKS: Record<string, (current: string) => string> = {
  route,
  "paste-field": pasteField,
  "one-request": oneRequest,
  "control-numbers": controlNumbers,
  waterline,
  "work-rail": workRail,
  "use-cases": useCases,
  connections,
  "we-do-not": weDoNot,
  "plan-bars": planBars,
};
