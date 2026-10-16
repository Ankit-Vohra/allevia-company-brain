// Build-time HTML for the "Meet your team" page (site/proto/team/). Merged into SECTIONS by sections.ts.
//
// The page is one story: Fluffy, the office golden retriever, walks the pixel office desk by desk while you scroll, and each person
// turns, waves and says who they are, what they do best and one thing you can ask. Their tools pop up beside them and the dog gets a
// treat before trotting on. Two complete versions are written into the page and CSS shows one:
//   .walk   (wide screens, motion welcome): a pinned stage, the office as one long strip the camera slides along, driven by
//           team.ts from the scrollcraft act's progress (--sc-p).
//   .cards  (phones, tablets, reduced motion, data saver, no JavaScript): one card per person with the dog between the cards.
// Everything real comes from the product: the roster (names, titles, departments, toolkits), the pixel people (site/src/render/sprites.ts,
// the same templates and palettes as the app), the office floor, rugs, desks and boards (drawn by the app's own code into
// team/assets/*.svg by team/gen-office.mts), the dogs and their treat and heart (web/src/office/pets.ts), and the tool logos
// (shared/logos.ts, the ids of shared/connection-map.ts). What is composed: the order of the walk, the words in the speech bubbles and
// which tools sit by which person (the tools come from each person's toolkits and department in the roster and the connection list).
import { AGENTS, DEPARTMENTS, STAFF_COUNT, DEPARTMENT_COUNT, numberWord, type AgentDef } from "../../../shared/roster.ts";
import { spriteSvg } from "../../src/render/sprites.ts";
import { drawDog, drawHeart, drawTreat, DOG_W, DOG_H, type PetId, type PetPose } from "../../../web/src/office/pets.ts";
import { logo, logoMarkup, hasLogo } from "./logos.ts";
import { PIECES, type OfficePiece } from "./team-office.generated.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- what each person says (their own voice, the founder's own words for the question) ----------

interface Say {
  /** "I'm Neel, Sales." */ intro: string;
  /** What they do best, one short sentence. */ does: string;
  /** One thing the founder asks them, in the founder's words. */ ask: string;
  /** The line under the name on their desk card (their roster title, in plain words). */ title: string;
  /** Connection ids (shared/connection-map.ts): the tools beside them. Each comes from the person's toolkits and department. */ tools: string[];
}
const SAY: Record<string, Say> = {
  "chief-of-staff": { intro: "I’m Meera, Chief of Staff.", does: "I take every request, send it to the right person and write you one clear answer.", ask: "Why did sign-ups drop last week?", title: "Chief of Staff", tools: ["gmail", "google-calendar", "slack"] },
  "coe-lead": { intro: "I’m Isha, Numbers.", does: "I keep your key numbers and check every one before it reaches you.", ask: "How are we doing this week?", title: "Numbers lead", tools: ["google-analytics", "stripe", "google-sheets"] },
  "data-analyst": { intro: "I’m Kabir, Analytics.", does: "I find where your customers come from and where they drop off.", ask: "Where do people leave the sign-up?", title: "Data analyst", tools: ["google-analytics", "search-console", "google-ads"] },
  "growth-marketer": { intro: "I’m Rohan, Marketing.", does: "I turn what works into ad and channel plans, and ask you before I spend.", ask: "Should we spend more on Instagram?", title: "Growth marketer", tools: ["google-ads", "meta-ads", "instagram"] },
  "content-strategist": { intro: "I’m Tara, Content.", does: "I plan posts and reels around what your customers liked before.", ask: "What should we post for Diwali?", title: "Content strategist", tools: ["instagram", "facebook-pages", "mailchimp"] },
  "copy-editor": { intro: "I’m Dev, Brand voice.", does: "I make every draft sound like you, in English or Hindi.", ask: "Make this caption sound like us.", title: "Brand and copy editor", tools: ["instagram", "mailchimp"] },
  "fact-checker": { intro: "I’m Nisha, Fact checker.", does: "I check every claim against what we know before it goes out.", ask: "Is this offer line true?", title: "Fact checker", tools: ["google-analytics", "instagram", "google-ads"] },
  "sales-lead": { intro: "I’m Neel, Sales.", does: "I answer every enquiry and book the call.", ask: "Book Sarah for Tuesday?", title: "Sales lead", tools: ["gmail", "google-calendar", "hubspot", "whatsapp"] },
  "tech-lead": { intro: "I’m Arjun, Tech.", does: "I find what is wrong on your site or app and file the fix.", ask: "Why is the website slow on phones?", title: "Tech lead", tools: ["search-console", "google-analytics", "github"] },
  "oncall-engineer": { intro: "I’m Zoya, Tech on call.", does: "I watch for crashes day and night and tell the right person.", ask: "Is the app down right now?", title: "On-call engineer", tools: ["github", "slack", "discord"] },
  "qa-release": { intro: "I’m Imran, App releases.", does: "I follow every release through the stores and flag anything it breaks.", ask: "Did the last release break anything?", title: "Release manager", tools: ["github", "slack"] },
  "ops-manager": { intro: "I’m Vikram, Operations.", does: "I keep track of what is pending and who owns it.", ask: "What is waiting on me?", title: "Ops manager", tools: ["slack", "gmail", "google-sheets", "quickbooks"] },
  librarian: { intro: "I’m Sara, Library.", does: "I keep the company’s memory: what we decided, why, and who knows.", ask: "Why did we pause those ads?", title: "Librarian", tools: ["gmail", "slack", "google-sheets"] },
};
/** The sign over each team (the app says "Center of Excellence"; the owner reads "Numbers"). */
const SIGN: Record<string, string> = { coe: "Numbers" };
const signOf = (dept: string) => SIGN[dept] ?? DEPARTMENTS.find((d) => d.id === dept)?.name ?? dept;
const agent = (id: string): AgentDef => AGENTS.find((a) => a.id === id)!;
const hueOf = (dept: string) => DEPARTMENTS.find((d) => d.id === dept)?.hue ?? 265;

// ---------- the dogs, as one set of symbols the page re-uses ----------

interface Rect { x: number; y: number; w: number; h: number; fill: string }
function paint(draw: (c: CanvasRenderingContext2D) => void): Rect[] {
  const rects: Rect[] = [];
  const ctx = { fillStyle: "#000" as string, fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, fill: String(this.fillStyle) }); } };
  draw(ctx as unknown as CanvasRenderingContext2D);
  return rects;
}
const rectsSvg = (rects: Rect[]) => rects.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`).join("");
const DW = DOG_W + 1, DH = DOG_H + 3;   // the app's 22x14 dog box, one more column and three rows of headroom for the page in her mouth
const PAGE = `<rect x="18" y="0" width="5" height="6" fill="#FFFFFF"/><rect x="18" y="0" width="5" height="1" fill="#D9D2C3"/><rect x="19" y="2" width="3" height="1" fill="#B9AE9B"/><rect x="19" y="4" width="3" height="1" fill="#B9AE9B"/>`;
function dogSymbol(id: PetId, key: string, pose: PetPose, frame: number, page: boolean): string {
  const body = rectsSvg(paint((c) => drawDog(c, id, pose, frame, 0, 3, "right")));
  return `<symbol id="d-${id}-${key}" viewBox="0 0 ${DW} ${DH}">${body}${page ? PAGE : ""}</symbol>`;
}
function symbols(): string {
  const dogs = (["fluffy", "jj", "zoe"] as PetId[]).flatMap((id) => [
    dogSymbol(id, "a", "carry", 0, true), dogSymbol(id, "b", "carry", 1, true), dogSymbol(id, "sit", "sit", 0, false), dogSymbol(id, "lie", "lie", 0, false),
  ]).join("");
  const heart = `<symbol id="d-heart" viewBox="0 0 5 5">${rectsSvg(paint((c) => drawHeart(c, 0, 0, 1)))}</symbol>`;
  const treat = `<symbol id="d-treat" viewBox="0 0 5 3">${rectsSvg(paint((c) => drawTreat(c, 0, 0)))}</symbol>`;
  return `<svg class="symbols" width="0" height="0" aria-hidden="true" focusable="false"><defs>${dogs}${heart}${treat}</defs></svg>`;
}
const use = (id: string, w: number, h: number, cls = "") => `<svg class="${cls}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
/** A dog with the frames CSS switches between (data-pose on the wrapper: a, b, sit). */
const dogFrames = (id: PetId, cls = "dog__svg") => `<svg class="${cls}" viewBox="0 0 ${DW} ${DH}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><use class="df df--a" href="#d-${id}-a"/><use class="df df--b" href="#d-${id}-b"/><use class="df df--sit" href="#d-${id}-sit"/></svg>`;

// ---------- one person: the figure, the hands, the tag ----------

function figSvg(id: string): string {
  const inner = spriteSvg(id, { size: 16 }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<svg class="fig" viewBox="0 0 16 20" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${inner}</svg>`;
}
/** Hands on the keyboard (they tap in turn), and the raised arm that waves. Drawn over the desk, like the app's drawHands. */
function handsSvg(id: string): string {
  const { skin, shirt } = agent(id).sprite;
  const r = (x: number, y: number, w: number, h: number, c: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
  return `<svg class="hands" viewBox="0 0 16 20" shape-rendering="crispEdges" aria-hidden="true" focusable="false">`
    + `<g class="hands__arm-l">${r(2, 14, 2, 2, shirt)}</g><g class="hands__arm-r">${r(12, 14, 2, 2, shirt)}</g>`
    + `<g class="hands__tap hands__tap--a">${r(2, 16, 3, 2, skin)}${r(11, 15, 3, 2, skin)}</g>`
    + `<g class="hands__tap hands__tap--b">${r(2, 15, 3, 2, skin)}${r(11, 16, 3, 2, skin)}</g>`
    + `<g class="hands__rest">${r(2, 16, 3, 2, skin)}</g>`
    + `<g class="hands__wave">${r(14, 8, 2, 6, shirt)}${r(14, 5, 3, 3, skin)}${r(15, 4, 1, 1, skin)}</g>`
    + `</svg>`;
}
const tagHtml = (id: string) => `<p class="tag" aria-hidden="true"><b>${esc(agent(id).name)}</b><span>${esc(SAY[id]!.title)}</span></p>`;

function toolsHtml(id: string): string {
  const ids = SAY[id]!.tools.filter((t) => hasLogo(t));
  const items = ids.map((t, i) => `<li class="tool" style="--i:${i}">${logoMarkup(t, 30)}<span>${esc(logo(t)?.name ?? t)}</span></li>`).join("");
  return `<ul class="tools" aria-label="${esc(agent(id).name)} works with">${items}</ul>`;
}
// ---------- the walk (wide screens) ----------

const img = (p: OfficePiece, layer: "back" | "front") => `<img class="piece__${layer}" src="./assets/${p.id}-${layer}.svg" alt="" width="${p.w}" height="${p.h}" decoding="async">`;

function walkPiece(p: OfficePiece): string {
  if (p.kind === "entrance") return `<div class="piece piece--entrance" data-piece="${p.id}" style="--w:${p.w}">${img(p, "back")}</div>`;
  const a = p.agents;
  const stage = [
    img(p, "back"),
    a.map((o) => `<div class="who" data-for="${o.id}" style="--sx:${o.sprite.x};--sy:${o.sprite.y}">${figSvg(o.id)}</div>`).join(""),
    a.length ? img(p, "front") : "",
    a.map((o) => `<div class="who who--hands" data-for="${o.id}" style="--sx:${o.sprite.x};--sy:${o.sprite.y}">${handsSvg(o.id)}</div>`).join(""),
    a.map((o) => `<div class="tagpos" data-for="${o.id}" style="--tx:${o.desk.x + o.desk.w / 2};--ty:${o.desk.y + o.desk.h + 3}">${tagHtml(o.id)}</div>`).join(""),
    p.kind === "zone" ? `<h3 class="sign" style="--x:${p.sign.x};--y:${p.sign.y};--hue:${hueOf(p.dept)}"><span>${esc(signOf(p.dept))}</span></h3>` : `<h3 class="sign" style="--x:${p.sign.x};--y:${p.sign.y};--hue:305"><span>${esc(p.name)}</span></h3>`,
    p.kind === "lounge" ? loungeDogs(p) : "",
  ].join("");
  const says = a.map((o) => {
    const ax = o.sprite.x + 8, ay = o.sprite.y;
    return `<article class="agent" data-agent="${o.id}" aria-labelledby="say-${o.id}" style="--ax:${ax};--ay:${ay};--tx:${o.desk.x + o.desk.w / 2};--ty:${o.desk.y + o.desk.h + 14};--dx:${o.desk.x + o.desk.w / 2};--dy:${o.desk.y + 6}">`
      + `<div class="bubble"><h4 class="bubble__name" id="say-${o.id}">${esc(SAY[o.id]!.intro)}</h4><p class="bubble__does">${esc(SAY[o.id]!.does)}</p><p class="bubble__ask"><span class="visually-hidden">You can ask me: </span>“${esc(SAY[o.id]!.ask)}”</p></div>`
      + toolsHtml(o.id)
      + `<svg class="treat" viewBox="0 0 5 3" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-treat"/></svg>`
      + `</article>`;
  }).join("");
  return `<section class="piece piece--${p.kind}" data-piece="${p.id}" data-dept="${p.dept}" style="--w:${p.w}"><div class="piece__stage">${stage}</div>${says ? `<div class="says">${says}</div>` : ""}</section>`;
}

/** JJ and Zoe nap by the dog bed in the game room, and sit up when Fluffy arrives. */
function loungeDogs(p: OfficePiece): string {
  const bed = p.dogbed!;
  const jj = { x: bed.x - 1, y: bed.y - 6 }, zoe = { x: bed.x - 30, y: bed.y - 3 };
  const pet = (id: PetId, at: { x: number; y: number }, name: string) =>
    `<div class="pet pet--${id}" data-pet="${id}" style="--sx:${at.x};--sy:${at.y}" role="img" aria-label="${name}, asleep">`
    + `<svg class="pet__svg" viewBox="0 0 ${DW} ${DH}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><use class="df df--lie" href="#d-${id}-lie"/><use class="df df--sit" href="#d-${id}-sit"/></svg>`
    + `<svg class="pet__heart" viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-heart"/></svg></div>`;
  return pet("zoe", zoe, "Zoe the poodle") + pet("jj", jj, "JJ the chow chow");
}

function walk(): string {
  const rail = PIECES.map(walkPiece).join("");
  return `<section class="walk" id="walk" data-sc-act="pin" data-sc-span="15" aria-labelledby="walk-h">
  <h2 class="visually-hidden" id="walk-h">The team, desk by desk</h2>
  <a class="skip btn btn-ghost btn-sm" href="#after-walk">Skip the walk</a>
  <div class="walk__stage" data-sc-stage>
    <div class="walk__cam" data-cam>
      <div class="walk__rail" data-rail>${rail}</div>
      <div class="dog" data-dog data-pose="sit" data-facing="right">
        <div class="dog__flip">${dogFrames("fluffy")}<svg class="dog__heart" viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-heart"/></svg><svg class="dog__treat" viewBox="0 0 5 3" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-treat"/></svg></div>
        <p class="dog__says" data-dog-says>Woof. That is the whole team.</p>
      </div>
    </div>
    <div class="walk__bar" aria-hidden="true"><i data-bar></i></div>
  </div>
</section>`;
}

// ---------- the cards (phones, reduced motion, no JavaScript) ----------

const WIN = 74;     // how many office pixels wide each card's picture is

function card(p: OfficePiece, o: OfficePiece["agents"][number], i: number): string {
  const x0 = Math.max(0, Math.min(p.w - WIN, Math.round(o.desk.x + o.desk.w / 2 - WIN / 2)));
  const inner = [
    img(p, "back"),
    `<div class="who" style="--sx:${o.sprite.x};--sy:${o.sprite.y}">${figSvg(o.id)}</div>`,
    img(p, "front"),
    `<div class="who who--hands" style="--sx:${o.sprite.x};--sy:${o.sprite.y}">${handsSvg(o.id)}</div>`,
    `<div class="tagpos" style="--tx:${o.desk.x + o.desk.w / 2};--ty:${o.desk.y + o.desk.h + 3}">${tagHtml(o.id)}</div>`,
  ].join("");
  // the sign hangs over the middle of the team's zone; in a card it is centred over the picture instead
  return `<article class="card" aria-labelledby="card-${o.id}">
  <div class="card__scene" style="--w:${p.w};--x0:${x0};--wd:${WIN};--hue:${hueOf(p.dept)}" aria-hidden="true"><div class="card__in" data-piece="${p.id}">${inner}</div><p class="sign sign--card"><span>${esc(signOf(p.dept))}</span></p></div>
  <div class="card__body">
    <h3 class="card__name" id="card-${o.id}">${esc(SAY[o.id]!.intro)}</h3>
    <p class="card__does">${esc(SAY[o.id]!.does)}</p>
    <p class="card__ask"><span class="visually-hidden">You can ask me: </span>“${esc(SAY[o.id]!.ask)}”</p>
    ${toolsHtml(o.id).replace('class="tools"', 'class="tools tools--card"')}
  </div>
</article>${i < 12 ? hop(i) : gang()}`;
}

/** The dog between two cards: she trots in from one side with a page and sits for her treat. */
function hop(i: number): string {
  const dir = i % 2 === 0 ? "right" : "left";
  return `<div class="hop hop--${dir}" aria-hidden="true"><div class="hop__dog">${dogFrames("fluffy", "hop__svg")}<svg class="hop__treat" viewBox="0 0 5 3" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-treat"/></svg><svg class="hop__heart" viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-heart"/></svg></div></div>`;
}
function gang(): string {
  const sit = (id: PetId) => `<svg class="gang__dog" viewBox="0 0 ${DW} ${DH}" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-${id}-sit"/></svg>`;
  return `<figure class="gang"><div class="gang__row">${sit("fluffy")}${sit("jj")}${sit("zoe")}</div><figcaption>Woof. That is the whole team. Fluffy, JJ and Zoe.</figcaption></figure>`;
}

function cards(): string {
  const items: string[] = [];
  let i = 0;
  for (const p of PIECES) for (const o of p.agents) items.push(card(p, o, i++));
  return `<section class="cards" aria-labelledby="cards-h"><h2 class="visually-hidden" id="cards-h">The team, one card each</h2>${items.join("")}</section>`;
}

// ---------- the page ----------

function story(): string {
  const n = numberWord(STAFF_COUNT), d = numberWord(DEPARTMENT_COUNT);
  return `${symbols()}
<main id="main" class="team">
  <header class="team__head wrap">
    <h1 class="h2 h2--wide"><span class="t1">Meet your team.</span> <span class="t2">Fluffy shows you around.</span></h1>
    <p class="lede">${esc(n.charAt(0).toUpperCase() + n.slice(1))} people in ${esc(d)} teams, and three office dogs. Each one says what they do best and what you can ask them.</p>
  </header>
  ${walk()}
  ${cards()}
  <section class="team__close wrap" id="after-walk" aria-labelledby="close-h">
    <h2 class="h2 h2--wide" id="close-h"><span class="t1">Meet them on your own business.</span> <span class="t2">We set it up.</span></h2>
    <p class="lede">We read your website and connect the tools you already use. After that, nothing goes out without your OK.</p>
    <p class="team__cta"><a class="btn btn-gold" href="/contact/">Get a free Brain Snapshot</a></p>
  </section>
</main>`;
}

export const TEAM_SECTIONS: Record<string, (page: string) => string> = {
  "team-story": () => story(),
};
