// Build-time HTML for the home page (site/index.html): the brain drawn as SVG from the real graph of the sample business,
// the tools that snap into it, the run of the hero question, the things the team made, the OK, the plan and the courier
// route. Plain, complete HTML: with JavaScript off, or with reduced motion, every picture is its finished state and every
// line is on the page. src/home.ts adds the motion by reading the data-f (formation, 0..1) and data-r (the run, seconds)
// marks written here; nothing in this file runs in the browser.
import brain from "../brain/brain-data.json" with { type: "json" };
import { COPY, PLAN_SAMPLE, ROUTE, TOOLS } from "../home-content.ts";
import { dogSvg, spriteSvg, treatSvg } from "./sprites.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => n.toLocaleString("en-US");

interface BNode { id: string; type: string; label: string; name: string; wave: string; x: number; y: number; r: number; order: number; labelled: boolean }
interface BEdge { a: string; b: string; t: string }
interface RunStep { t: number; kind: string; agent?: string; text?: string; ids?: string[]; tool?: string }
interface BrainData {
  box: { w: number; h: number };
  nodes: BNode[]; edges: BEdge[];
  spark: Record<string, { day: string; v: number }[]>;
  counts: { nodes: number; edges: number; readings: number };
  run: { turnId: string; doneAt: number; steps: RunStep[]; path: { nodes: string[]; edges: { from: string; to: string; type: string }[] }; answer: string };
}
const B = brain as unknown as BrainData;
const NODE = new Map(B.nodes.map((n) => [n.id, n]));

// ---------- when each thing arrives (formation, 0..1 over the pinned act) ----------
// Each tool docks, then the things it brings appear. What a website gives comes first. The times are the act's progress.
export const FORM = {
  site: { from: 0.06, to: 0.32 },
  dock: { gmail: 0.43, calendar: 0.5, analytics: 0.56, ads: 0.63, files: 0.69 } as Record<string, number>,
  span: { gmail: 0.05, calendar: 0.03, analytics: 0.07, ads: 0.02, files: 0.1 } as Record<string, number>,
  rest: [0.78, 0.81, 0.84, 0.87, 0.9, 0.93],
};
const arrival = (n: BNode): number => {
  if (n.wave === "site") return FORM.site.from + n.order * (FORM.site.to - FORM.site.from);
  return FORM.dock[n.wave]! + 0.025 + n.order * FORM.span[n.wave]!;
};

// the labels worth reading at a glance; the rest are dots (hover or the list below the picture names them)
const MAJOR = new Set(["business:shiftly", "audience:seekers", "person:farhan", "channel:app", "feature:seekers-signup-phone-number-entered",
  "feature:seekers-signup-sign-up-screen-viewed", "feature:seekers-signup-otp-verified", "feature:seekers-signup-first-application", "feature:seekers-signup-app-opened",
  "feature:seekers-signup-profile-completed", "page:screen/app/auth/sign-up", "event:sentry-issue-shiftly-41", "event:release-shiftly-2-8-0",
  "event:release-shiftly-2-8-1", "decision:014-hotfix-not-rollback", "campaign:meta-seekers-pune"]);

// the few worth reading on a phone
const FUNNEL_IDS = new Set(Object.keys(B.spark));
const KEY = new Set(["business:shiftly", "feature:seekers-signup-phone-number-entered", "page:screen/app/auth/sign-up", "event:sentry-issue-shiftly-41", "event:release-shiftly-2-8-0", "person:farhan"]);

const kindOf = (t: string): string => ({ Business: "biz", Person: "person", Team: "person", Audience: "person", Channel: "chan", Page: "chan", Feature: "feat", Campaign: "feat", Decision: "feat", Task: "feat", Event: "event", Lead: "sales", Deal: "sales", Meeting: "sales", Message: "sales", Document: "doc" } as Record<string, string>)[t] ?? "feat";

/** The agents who work in the run, in the order they sit along the bottom of the ask picture. */
const AGENT_ROW: { id: string; roster: string; name: string }[] = [
  { id: "chief-of-staff", roster: "chief-of-staff", name: "The Chief" },
  { id: "data-analyst", roster: "data-analyst", name: "Data Detective" },
  { id: "oncall-engineer", roster: "oncall-engineer", name: "Firefighter" },
  { id: "qa-release", roster: "qa-release", name: "Bug Hunter" },
  { id: "librarian", roster: "librarian", name: "Memory Keeper" },
  { id: "tech-lead", roster: "tech-lead", name: "Techie" },
  { id: "coe-lead", roster: "coe-lead", name: "Number Cruncher" },
];
const CHIP_Y = 512;
const chipX = (i: number) => 100 + i * 100;

type Variant = "hero" | "form" | "ask";

/** The brain, as one SVG. `form` carries the formation timing; `ask` the run; `hero` neither (a finished picture that breathes). */
export function brainSvg(variant: Variant): string {
  const w = B.box.w, h = B.box.h;
  // the picture is cropped to what it holds (the run's version keeps the strip of people along the bottom)
  const minX = Math.floor(Math.min(...B.nodes.map((n) => n.x - n.r)) - 26), maxX = Math.ceil(Math.max(...B.nodes.map((n) => n.x + n.r)) + 34);
  const minY = Math.floor(Math.min(...B.nodes.map((n) => n.y - n.r)) - 24), maxY = Math.ceil(Math.max(...B.nodes.map((n) => n.y + n.r)) + 26);
  const vb = variant === "ask" ? `${minX} ${minY} ${maxX - minX} ${h - minY}` : `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
  const form = variant === "form";
  const ask = variant === "ask";
  const t0 = new Map(B.nodes.map((n) => [n.id, arrival(n)]));

  const edges = B.edges.map((e) => {
    const a = NODE.get(e.a)!, b = NODE.get(e.b)!;
    const cross = a.wave !== b.wave;
    const at = r3(Math.max(t0.get(a.id)!, t0.get(b.id)!) + 0.012);
    const f = form ? ` data-f="draw ${at} 0.04"` : "";
    return `<line class="be${cross ? " be--x" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" pathLength="1"${f}/>`;
  }).join("");

  // the real daily readings of each funnel step, as small bars under it
  const spark = Object.entries(B.spark).map(([id, days]) => {
    const n = NODE.get(id);
    if (!n) return "";
    const max = Math.max(...days.map((d) => d.v), 1);
    const bw = 3.2, gap = 0.9, total = days.length * (bw + gap) - gap;
    const x0 = n.x - total / 2;
    const base = n.y + 40;
    const bars = days.map((d, i) => {
      const hh = Math.max(1.2, (d.v / max) * 24);
      return `<rect class="bs${d.day >= "2026-10-07" ? " bs--after" : ""}" x="${r1(x0 + i * (bw + gap))}" y="${r1(base - hh)}" width="${bw}" height="${r1(hh)}" rx="0.6"/>`;
    }).join("");
    const f = form ? ` data-f="fade ${r3(t0.get(id)! + 0.03)} 0.05"` : "";
    return `<g class="bsp" data-spark="${esc(id)}"${f}>${bars}</g>`;
  }).join("");

  const nodes = B.nodes.map((n) => {
    const k = kindOf(n.type);
    const at = t0.get(n.id)!;
    const f = form ? ` data-f="pop ${r3(at)} 0.03${n.wave === "site" ? "" : " ring"}"` : "";
    const read = ask ? ` data-id="${esc(n.id)}"` : "";
    const ring = form && n.wave !== "site" ? `<circle class="bn__ring" r="${n.r}"/>` : "";
    return `<g class="bn bn--${k}${n.type === "Event" && /sentry/.test(n.id) ? " bn--crash" : ""}" transform="translate(${n.x} ${n.y})"${f}${read}>${ring}<circle class="bn__dot" r="${n.r}"/></g>`;
  }).join("");

  const labels = B.nodes.filter((n) => n.labelled).map((n) => {
    const major = MAJOR.has(n.id);
    const right = n.x < w - 150;
    const f = form && major ? ` data-f="fade ${r3(t0.get(n.id)! + 0.02)} 0.03"` : "";
    const read = ask ? ` data-id="${esc(n.id)}"` : "";
    const above = FUNNEL_IDS.has(n.id); // the funnel steps are named above them, so the bars of their neighbours do not run under the words
    const x = above ? n.x : right ? n.x + n.r + 5 : n.x - n.r - 5;
    const y = above ? n.y - n.r - 7 : n.y + 4;
    return `<text class="bl${major ? " bl--major" : ""}${KEY.has(n.id) ? " bl--key" : ""}" x="${r1(x)}" y="${r1(y)}" text-anchor="${above ? "middle" : right ? "start" : "end"}"${f}${read}>${esc(n.label)}</text>`;
  }).join("");

  let overlay = "";
  if (ask) overlay = askOverlay();
  const names = B.nodes.filter((n) => n.labelled).map((n) => n.label).join(", ");
  const title = form ? "The company brain of a sample business growing: first from its website, then from each tool it connects." : ask ? "The brain, and the route the question took through it: who read what, and the path of the answer." : "The company brain of a sample business: the business, its people, channels, funnel, screens, releases and crashes, leads and calls, all linked.";
  return `<svg class="brain__svg brain__svg--${variant}" viewBox="${vb}" role="img" aria-label="${esc(title)}" data-brain="${variant}"${ask ? runAttr() : ""} preserveAspectRatio="xMidYMid meet">
<desc>${esc(`${B.counts.nodes} things and ${B.counts.edges} links. Includes: ${names}.`)}</desc>
<g class="b-edges" aria-hidden="true">${edges}</g>
<g class="b-spark" aria-hidden="true">${spark}</g>
${overlay}<g class="b-nodes" aria-hidden="true">${nodes}</g>
${variant === "hero" ? heroPulses() : ""}
<g class="b-labels" aria-hidden="true">${labels}</g>
${ask ? agentChips() : ""}</svg>`;
}

/** The hero's idle life: a few small gold dots travelling along real links between things that come from different tools. */
function heroPulses(): string {
  const hash = (s: string) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const cross = B.edges.filter((e) => NODE.get(e.a)!.wave !== NODE.get(e.b)!.wave).sort((x, y) => hash(x.a + x.b) - hash(y.a + y.b)).slice(0, 7);
  const dots = cross.map((e, i) => {
    const a = NODE.get(e.a)!, b = NODE.get(e.b)!;
    const dur = 3.6 + (hash(e.a) % 30) / 10;
    return `<circle class="pulse" r="3.2"><animateMotion dur="${dur.toFixed(1)}s" begin="-${(i * 0.9).toFixed(1)}s" repeatCount="indefinite" path="M${a.x} ${a.y} L${b.x} ${b.y}" keyPoints="0;1;1" keyTimes="0;0.7;1" calcMode="linear"/><animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.1;0.6;0.7;1" dur="${dur.toFixed(1)}s" begin="-${(i * 0.9).toFixed(1)}s" repeatCount="indefinite"/></circle>`;
  }).join("");
  return `<g class="b-pulses" aria-hidden="true">${dots}</g>`;
}

// ---------- the run: who read what, when (seconds into the recording) ----------

/** The run's turning points, read by src/home.ts: the plan is made, the path is drawn, the answer is final, and how long it is. */
function runAttr(): string {
  const plan = B.run.steps.find((s) => s.kind === "done" && s.agent === "chief-of-staff")?.t ?? 13;
  const path = B.run.steps.find((s) => s.tool === "show_path")?.t ?? B.run.doneAt - 20;
  return ` data-run="plan ${r1(plan)} path ${r1(path)} end ${r1(B.run.doneAt)} seconds ${Math.ceil(B.run.doneAt + 2)}"`;
}

function askOverlay(): string {
  const steps = B.run.steps;
  const agents = new Map(AGENT_ROW.map((a, i) => [a.id, i]));
  const seen = new Set<string>();
  const routes: string[] = [];
  for (const s of steps) {
    if (s.kind !== "read" || !s.agent || !s.ids?.length) continue;
    const ai = agents.get(s.agent);
    if (ai === undefined) continue;
    const ids = s.ids.filter((id) => !seen.has(`${s.agent}|${id}`)).slice(0, 3);
    for (const id of ids) {
      seen.add(`${s.agent}|${id}`);
      const n = NODE.get(id);
      if (!n) continue;
      const x0 = chipX(ai), y0 = CHIP_Y - 18;
      const cx = x0 + (n.x - x0) * 0.2, cy = n.y + (y0 - n.y) * 0.5;
      routes.push(`<path class="br" d="M${x0} ${y0} Q${r1(cx)} ${r1(cy)} ${n.x} ${n.y}" pathLength="1" data-r="route ${r1(s.t)} ${r1(s.t + 1.3)}" data-agent="${s.agent}" data-id="${esc(id)}"/>`);
    }
  }
  // the path of the answer: the real edges the run drew, one after another, in gold
  const p = B.run.path;
  const t = B.run.steps.find((s) => s.tool === "show_path")?.t ?? B.run.doneAt - 20;
  const segs = p.edges.map((e, i) => {
    const a = NODE.get(e.from), b = NODE.get(e.to);
    if (!a || !b) return "";
    return `<line class="bpath" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" pathLength="1" data-r="draw ${r1(t + 0.4 + i * 0.9)} ${r1(t + 1.3 + i * 0.9)}"/>`;
  }).join("");
  const pathNodes = p.nodes.map((id, i) => {
    const n = NODE.get(id);
    return n ? `<circle class="bpn" cx="${n.x}" cy="${n.y}" r="${n.r + 5}" data-r="fade ${r1(t + 0.3 + i * 0.7)} ${r1(t + 0.9 + i * 0.7)}"/>` : "";
  }).join("");
  const pn = NODE.get("feature:seekers-signup-phone-number-entered");
  const days = (B.spark["feature:seekers-signup-phone-number-entered"] ?? []).length;
  const marks = pn ? `<text class="bnote" x="${r1(pn.x + (days * 4.1) / 2 + 6)}" y="${r1(pn.y + 36)}" data-r="fade ${r1(t + 1)} ${r1(t + 2)}">fell on 7 Oct</text>` : "";
  return `<g class="b-routes" aria-hidden="true">${routes.join("")}</g><g class="b-path" aria-hidden="true">${segs}${pathNodes}${marks}</g>\n`;
}

/** The people in the run, along the bottom: each lights while they work (their start and done times). */
function agentChips(): string {
  const steps = B.run.steps;
  const chips = AGENT_ROW.map((a, i) => {
    const spans: number[] = [];
    let open: number | undefined;
    for (const s of steps) {
      if (s.agent !== a.id) continue;
      if (s.kind === "start") open = s.t;
      else if (s.kind === "done" && open !== undefined) { spans.push(r1(open), r1(s.t)); open = undefined; }
    }
    if (open !== undefined) spans.push(r1(open), r1(B.run.doneAt));
    const sprite = spriteSvg(a.roster, { size: 30, portrait: true }).replace('<svg class="sprite"', '<svg class="sprite" x="-15" y="-15"');
    return `<g class="ba" transform="translate(${chipX(i)} ${CHIP_Y})" data-r="work ${spans.join(" ")}" data-agent="${a.id}"><circle class="ba__ring" r="20"/>${sprite}<text class="ba__name" y="34" text-anchor="middle">${esc(a.name)}</text></g>`;
  }).join("");
  return `<g class="b-agents" role="presentation">${chips}</g>`;
}

// ---------- the tools ----------

export function toolTiles(): string {
  const dockIndex: Record<string, string> = { gmail: "gmail", calendar: "calendar", analytics: "analytics", "meta-ads": "ads" };
  const items = TOOLS.map((tl, i) => {
    const dock = dockIndex[tl.id];
    const at = dock ? FORM.dock[dock]! : FORM.rest[i - 4] ?? 0.9;
    return `<li class="tool${dock ? "" : " tool--more"}" data-f="dock ${r3(at)} 0.05" style="--i:${i}"><img src="/img/tool-${tl.id}.webp" alt="" width="48" height="48" loading="lazy" decoding="async"><span>${esc(tl.name)}</span></li>`;
  });
  // "your files" has no logo: a drawn sheet of paper
  items.splice(4, 0, `<li class="tool" data-f="dock ${FORM.dock.files} 0.05"><span class="tool__file" aria-hidden="true"></span><span>Your files</span></li>`);
  return `<ul class="tools" aria-label="Tools and files that can join the brain">${items.join("")}</ul>`;
}

// ---------- the answer, from the real run ----------

/** The three lines of the real answer, shortened, with the things each one rests on. */
export const ANSWER = [
  { text: "The new phone-number box crashes sign-up. It shipped in version 2.8.0 on 7 October.", src: ["Release 2.8.0", "Crash on sign-up"] },
  { text: "People still came, but phone numbers entered fell from about 294 a day to about 60.", src: ["Saw sign-up", "Phone number entered"] },
  { text: "Farhan owns the screen. The fix, 2.8.1, waits in store review.", src: ["Farhan", "Hotfix 2.8.1"] },
];

export function askAnswer(): string {
  const lines = ANSWER.map((a) => `<li><p>${esc(a.text)}</p><p class="cites">${a.src.map((s) => `<span>${esc(s)}</span>`).join("")}</p></li>`).join("");
  return `<ul class="answer__lines">${lines}</ul><p class="answer__ok"><span class="ok-dot" aria-hidden="true"></span>Two things wait for your OK.</p>`;
}

// ---------- the pieces the team made ----------

export function madeRail(): string {
  const card = (cls: string, img: string, w: number, h: number, alt: string, what: string, who: string) =>
    `<article class="made ${cls}"><img src="${img}" width="${w}" height="${h}" loading="lazy" decoding="async" alt="${esc(alt)}"><h3 class="made__what">${esc(what)}</h3><p class="made__meta">${esc(who)}</p></article>`;
  const m = COPY.made.items;
  return `<div class="rail" data-sc-pan="0.04" role="region" aria-label="Things the team made, scrolls sideways" tabindex="0">
  <div class="rail__lead"><h2 class="h2" id="made-h">${esc(COPY.made.h2a)} <span class="h2__soft">${esc(COPY.made.h2b)}</span></h2></div>
  ${card("made--tall", "/media/work-avs-ad.webp", 600, 750, "A portrait Instagram ad for an architecture studio: a bright bedroom, the headline 'Rooms planned around how your family lives'.", m[0].what, m[0].who + ", Content")}
  ${card("made--tall", "/media/work-aamdani-poster.webp", 600, 750, "A poster in Hindi for a jobs app: a young man at a roadside stall looks at his phone.", m[1].what, m[1].who + ", Content")}
  ${card("made--card", "/media/shot-email-times.webp", 720, 894, "A drafted email from Deal Closer to a new enquiry: yes, we can help, and three free times to talk, Monday 19 October 11:00, Tuesday 20 October 09:30, Wednesday 21 October 11:30.", m[2].what, m[2].who + ", Sales")}
  ${card("made--card made--short", "/media/shot-fix-card.webp", 720, 580, "An approval card: 'Fix sign-up crash in PhoneInput when no country is detected (2.8.1)', a fix for the website, by The Chief, with Approve, Change and No thanks.", m[3].what, "Firefighter, Tech")}
  <div class="rail__end" aria-hidden="true"></div>
</div>`;
}

// ---------- the OK, on the web and in Discord ----------

export function okPair(): string {
  return `<div class="ok__pair">
  <figure class="frame ok__web">
    <div class="ok__stack">
      <span class="tag ok__lab">Before</span><img class="ok__img ok__img--before" src="/media/shot-ok-before.webp" width="720" height="564" loading="lazy" decoding="async" alt="A card waiting for your OK: 'Instagram portrait poster: Dussehra in Pune, a few days away', by Miss Influencer, with Approve, Change and No thanks.">
      <span class="tag ok__lab">After one tap</span><img class="ok__img ok__img--after" data-sc-reveal="right" data-sc-reveal-at="0.28 0.58" src="/media/shot-ok-after.webp" width="720" height="564" loading="lazy" decoding="async" alt="After one tap: a green line says 'Approved: Instagram portrait poster. Draft saved. Nothing was posted.' and the next card moves up.">
    </div>
    <figcaption class="frame__cap">${esc(COPY.ok.web)}</figcaption>
  </figure>
  <figure class="frame ok__discord">
    <div class="dc" role="img" aria-label="The same kind of card in Discord: a message from the Allevia bot with the email draft to Meghna and three buttons, Approve, Change and No thanks.">
      <p class="dc__chan"># approvals</p>
      <div class="dc__msg">
        <span class="dc__av" aria-hidden="true">a</span>
        <div class="dc__body">
          <p class="dc__who">Allevia <span class="dc__bot">APP</span></p>
          <p><b>Draft email to Meghna</b></p>
          <p class="dc__q">Could we talk for 30 minutes? Free (IST): Mon 19 Oct 11:00, Tue 20 Oct 09:30, Wed 21 Oct 11:30.</p>
          <p class="dc__btns"><span class="dc__b dc__b--ok">Approve</span><span class="dc__b">Change</span><span class="dc__b dc__b--no">No thanks</span></p>
        </div>
      </div>
    </div>
    <figcaption class="frame__cap">${esc(COPY.ok.discord)} <span class="tag" title="Redrawn to match the message the Allevia bot sends">redrawn</span></figcaption>
  </figure>
</div>`;
}

// ---------- the plan ----------

export function planBars(): string {
  const who: Record<string, string> = { "Growth Hacker": "growth-marketer", "Miss Influencer": "content-strategist", "Data Detective": "data-analyst" };
  const rows = PLAN_SAMPLE.map((g) => {
    const from = (g.from / g.goal).toFixed(3);
    const to = (g.now / g.goal).toFixed(3);
    const push = g.status !== "Going well" ? " goal--push" : "";
    return `<li class="goal${push}" style="--from:${from};--to:${to}">
  <div class="goal__top"><h3 class="goal__name">${esc(g.name)}</h3><p class="goal__status">${esc(g.status)}</p></div>
  <div class="goal__bar" aria-hidden="true"><span class="goal__start"></span><span class="goal__fill"></span></div>
  <p class="goal__nums"><span class="goal__now"><span class="num">${fmt(g.now)}</span> ${esc(g.unit)}</span> <span class="goal__goal">Goal ${fmt(g.goal)}</span> <span class="goal__who">${spriteSvg(who[g.who] ?? "chief-of-staff", { size: 20, portrait: true })}${esc(g.who)}</span></p>
</li>`;
  }).join("");
  return `<ol class="goals">${rows}</ol>`;
}

// ---------- the courier route (the slim strip at the bottom) ----------

export function route(): string {
  const stops = ROUTE.map(
    (s, i) => `<li class="route__stop" data-stop="${i}"><a href="#${s.id}"><span class="route__dot">${treatSvg(12)}</span><span class="route__name">${esc(s.name)}</span></a></li>`,
  ).join("");
  return `<nav class="route" aria-label="Stops on this page" data-route>
  <div class="route__track">
    <ol class="route__stops">${stops}</ol>
    <div class="route__dog" data-route-dog aria-hidden="true">${dogSvg("fluffy", { size: 46 })}</div>
  </div>
</nav>`;
}

export const HOME_BLOCKS: Record<string, (current: string) => string> = {
  "brain-hero": () => brainSvg("hero"),
  "brain-form": () => brainSvg("form"),
  "brain-ask": () => brainSvg("ask"),
  "tool-tiles": toolTiles,
  "ask-answer": askAnswer,
  "made-rail": madeRail,
  "ok-pair": okPair,
  "plan-bars": planBars,
  route,
};

/** What the page shows as counts, from the data. */
export const BRAIN_COUNTS = B.counts;
export const RUN_SECONDS = Math.ceil(B.run.doneAt + 2);
export const RUN_QUESTION = COPY.ask.q;
