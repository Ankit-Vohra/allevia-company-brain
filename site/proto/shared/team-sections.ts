// Build-time HTML for the "Meet your team" page (site/proto/team/). Merged into SECTIONS by sections.ts.
//
// The page is one calm vertical walk: you scroll down a thin trail, Fluffy the golden retriever walks it with you, and you meet each
// person on a card of their own: a small drawing of their desk with them at it (the app's own pixel sprite, large enough to read),
// their name and job, what they are best at in their own words, a few things you can ask them, and the tools they work with.
// Between cards Fluffy walks, then gets a treat or a pat, then trots on. JJ and Zoe are waiting at the end.
// The same cards serve every screen: wide screens with motion add the trail and the walking dog (team.ts, driven by the scrollcraft
// act's progress); phones show the cards stacked with the dog between them; reduced motion shows them still.
//
// Everything real comes from the product: the roster (names, titles, departments, toolkits), the pixel people (site/src/render/sprites.ts,
// the same templates and palettes as the app), the desks, chairs, boards, plants and rugs (drawn by the app's own code into
// team/assets/*.svg by team/gen-vignettes.mts), the dogs and their treat and heart (web/src/office/pets.ts), and the tool logos
// (shared/logos.ts, the ids of shared/connection-map.ts). What is composed: the words (each person's line and the questions), and which
// tools stand beside which person (from each person's toolkits and department in the roster and the connection list).
import { AGENTS, DEPARTMENTS, STAFF_COUNT, numberWord, type AgentDef } from "../../../shared/roster.ts";
import { spriteSvg } from "../../src/render/sprites.ts";
import { drawDog, drawHeart, drawTreat, DOG_W, DOG_H, type PetId, type PetPose } from "../../../web/src/office/pets.ts";
import { logo, logoMarkup, hasLogo } from "./logos.ts";
import { PEOPLE, VIGNETTE_W, VIGNETTE_H } from "./team-vignettes.generated.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- what each person says (their own voice, and the founder's own words for the questions) ----------

interface Say {
  /** The line under the name: the roster title in plain words. */ title: string;
  /** What they do best, one short sentence, first person. */ best: string;
  /** Things the founder asks them. */ asks: string[];
  /** Connection ids (shared/connection-map.ts): the tools beside them. Each comes from the person's toolkits and department. */ tools: string[];
}
const SAY: Record<string, Say> = {
  "chief-of-staff": { title: "Chief of Staff", best: "I take every request, send it to the right person and write you one clear answer.", asks: ["Why did sign-ups drop last week?", "What should I look at this morning?", "Plan the Diwali push for me."], tools: ["gmail", "google-calendar", "slack"] },
  "coe-lead": { title: "Numbers lead", best: "I keep your key numbers and check every one before it reaches you.", asks: ["How are we doing this week?", "Is this number right?", "How did we do against last month?"], tools: ["google-analytics", "stripe", "google-sheets"] },
  "data-analyst": { title: "Data analyst", best: "I find where your customers come from and where they drop off.", asks: ["Where do people leave the sign-up?", "Which page brings the most visits?", "Do AI assistants mention us?"], tools: ["google-analytics", "search-console", "google-ads"] },
  "growth-marketer": { title: "Growth marketer", best: "I turn what works into ad and channel plans, and ask you before I spend.", asks: ["Should we spend more on Instagram?", "Which ad should I pause?", "Where is my ad money going?"], tools: ["google-ads", "meta-ads", "instagram"] },
  "content-strategist": { title: "Content strategist", best: "I plan posts and reels around what your customers liked before.", asks: ["What should we post for Diwali?", "Give me five reel ideas.", "What worked best last month?"], tools: ["instagram", "facebook-pages", "mailchimp"] },
  "copy-editor": { title: "Brand and copy editor", best: "I make every draft sound like you, in English or Hindi.", asks: ["Make this caption sound like us.", "Write this in Hindi.", "Does this sound like our brand?"], tools: ["instagram", "mailchimp"] },
  "fact-checker": { title: "Fact checker", best: "I check every claim against what we know before it goes out.", asks: ["Is this offer line true?", "Can we say we deliver in two days?", "Check this post before it goes out."], tools: ["google-analytics", "instagram", "google-ads"] },
  "sales-lead": { title: "Sales lead", best: "I answer every enquiry and book the call.", asks: ["Book Sarah for Tuesday?", "Who has not replied to our quote?", "Reply to the six new enquiries."], tools: ["gmail", "google-calendar", "hubspot", "whatsapp"] },
  "tech-lead": { title: "Tech lead", best: "I find what is wrong on your site or app and file the fix.", asks: ["Why is the website slow on phones?", "What should we fix on the site first?", "What breaks if we change the sign-up?"], tools: ["search-console", "google-analytics", "github"] },
  "oncall-engineer": { title: "On-call engineer", best: "I watch for crashes day and night and tell the right person.", asks: ["Is the app down right now?", "What crashed last night?", "Who is fixing it?"], tools: ["github", "slack", "discord"] },
  "qa-release": { title: "Release manager", best: "I follow every release through the stores and flag anything it breaks.", asks: ["Did the last release break anything?", "Is the new version live in the store?", "How are the store ratings?"], tools: ["github", "slack"] },
  "ops-manager": { title: "Ops manager", best: "I keep track of what is pending and who owns it.", asks: ["What is waiting on me?", "Which follow-ups are late?", "Who owns the supplier invoice?"], tools: ["slack", "gmail", "google-sheets", "quickbooks"] },
  librarian: { title: "Librarian", best: "I keep the company’s memory: what we decided, why, and who knows.", asks: ["Why did we pause those ads?", "Who knows about our supplier?", "What did we decide about pricing?"], tools: ["gmail", "slack", "google-sheets"] },
};
const agent = (id: string): AgentDef => AGENTS.find((a) => a.id === id)!;
/** The order of the walk (the founder's): Chief of Staff, Numbers, Analytics, Marketing, Content Studio, Sales, Tech, Ops, Library. */
const ORDER = ["leadership", "coe", "analytics", "marketing", "content", "sales", "tech", "ops", "knowledge"];
const WALK = [...PEOPLE].sort((a, b) => ORDER.indexOf(a.dept) - ORDER.indexOf(b.dept));

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
/** A dog with the frames CSS switches between (data-pose on the wrapper: a, b, sit). */
const dogFrames = (id: PetId, cls: string) => `<svg class="${cls}" viewBox="0 0 ${DW} ${DH}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><use class="df df--a" href="#d-${id}-a"/><use class="df df--b" href="#d-${id}-b"/><use class="df df--sit" href="#d-${id}-sit"/><use class="df df--lie" href="#d-${id}-lie"/></svg>`;
const heartSvg = (cls: string) => `<svg class="${cls}" viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-heart"/></svg>`;
const treatSvg = (cls: string) => `<svg class="${cls}" viewBox="0 0 5 3" shape-rendering="crispEdges" aria-hidden="true"><use href="#d-treat"/></svg>`;

// ---------- one person: the figure and the hands ----------

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

function toolsHtml(id: string): string {
  const ids = SAY[id]!.tools.filter((t) => hasLogo(t));
  const items = ids.map((t, i) => `<li class="tool" style="--i:${i}">${logoMarkup(t, 22)}<span>${esc(logo(t)?.name ?? t)}</span></li>`).join("");
  return `<ul class="tools" aria-label="${esc(agent(id).name)} works with">${items}</ul>`;
}

// ---------- a card ----------

const img = (id: string, layer: "back" | "front") => `<img class="art__${layer}" src="./assets/v-${id}-${layer}.svg" alt="" width="${VIGNETTE_W}" height="${VIGNETTE_H}" decoding="async">`;

function card(p: (typeof PEOPLE)[number], i: number, row: number): string {
  const a = agent(p.id), s = SAY[p.id]!;
  const side = i % 2 === 0 ? "left" : "right";
  return `<li class="stop stop--${side}" data-stop="${i}" data-side="${side}" style="--row:${row + 1}">
  <article class="card" aria-labelledby="who-${p.id}" style="--hue:${p.hue};--skin:${a.sprite.skin};--shirt:${a.sprite.shirt}">
    <div class="card__art" aria-hidden="true">
      <div class="art">${img(p.id, "back")}<div class="who">${figSvg(p.id)}</div>${img(p.id, "front")}<div class="who who--hands">${handsSvg(p.id)}</div></div>
    </div>
    <div class="card__body">
      <h3 class="card__name" id="who-${p.id}">${esc(a.name)}</h3>
      <p class="card__role">${esc(s.title)}</p>
      <p class="card__best"><span class="card__label">Best at</span> ${esc(s.best)}</p>
      <ul class="card__asks" aria-label="Ask ${esc(a.name)}">${s.asks.map((q) => `<li>“${esc(q)}”</li>`).join("")}</ul>
      ${toolsHtml(p.id)}
    </div>
  </article>
</li>`;
}

/** The dog between two cards on a phone: she trots in with a page, sits, gets a treat and a heart. Hidden when the trail takes over. */
function hop(i: number): string {
  const dir = i % 2 === 0 ? "right" : "left";
  return `<li class="hop hop--${dir}" aria-hidden="true"><div class="hop__dog">${dogFrames("fluffy", "hop__svg")}${treatSvg("hop__treat")}${heartSvg("hop__heart")}</div></li>`;
}

/** The end of the walk: JJ and Zoe are resting. On wide screens Fluffy's own place is left empty for the walking dog to lie down in. */
function gang(row: number): string {
  const dog = (id: PetId, cls: string) => `<svg class="gang__dog ${cls}" viewBox="0 0 ${DW} ${DH}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><use href="#d-${id}-lie"/></svg>`;
  return `<li class="stop stop--gang" data-gang style="--row:${row + 1}">
  <figure class="gang">
    <div class="gang__row" aria-hidden="true"><span class="gang__slot" data-slot>${dog("fluffy", "gang__fluffy")}</span>${dog("jj", "gang__jj")}${dog("zoe", "gang__zoe")}</div>
  </figure>
</li>`;
}

// ---------- the page ----------

/** Each team is its own moment: a band of colour (the site's colour system, shared/base.css), a heading that carries the change, then its cards. */
const TEAMS: { dept: string; band: string; name: string; line: string }[] = [
  { dept: "leadership", band: "", name: "Chief of Staff", line: "Every request starts here." },
  { dept: "coe", band: "band--ink", name: "Numbers", line: "The figures you can trust." },
  { dept: "analytics", band: "", name: "Analytics", line: "Where customers come from." },
  { dept: "marketing", band: "", name: "Marketing", line: "Ads and channels, with your OK." },
  { dept: "content", band: "band--ink", name: "Content Studio", line: "Posts and reels in your voice." },
  { dept: "sales", band: "", name: "Sales", line: "Every enquiry answered." },
  { dept: "tech", band: "", name: "Tech", line: "Watching the site and the app, day and night." },
  { dept: "ops", band: "band--ink", name: "Operations", line: "What is pending, and who owns it." },
  { dept: "knowledge", band: "", name: "Library", line: "The company’s memory." },
];

function teams(): string {
  let i = 0;
  return TEAMS.map((t) => {
    const first = i;
    let r = 0;
    const items = WALK.filter((p) => p.dept === t.dept).map((p) => card(p, i++, r++) + hop(i - 1)).join("");
    const side = first % 2 === 0 ? "right" : "left";    // the heading takes the empty column opposite the team's first card
    const dark = t.band === "band--ink";
    const rest = t.dept === "knowledge" ? gang(r) : "";    // the dogs lie down at the end of the last team
    return `<section class="${t.band ? `band ${t.band} ` : ""}wrap team" data-team="${t.dept}" aria-labelledby="team-${t.dept}">
  <h2 class="h2 h2--split team__h team__h--${side}${dark ? " on-ink" : ""}" id="team-${t.dept}"><span class="t1">${esc(t.name)}.</span> <span class="t2">${esc(t.line)}</span></h2>
  <ol class="people">${items}${rest}</ol>
</section>`;
  }).join("\n");
}

function story(): string {
  const n = numberWord(STAFF_COUNT);
  return `${symbols()}
<main id="main" class="team-page">
  <header class="team__head wrap">
    <h1 class="h2 h2--wide h2--split"><span class="t1">Meet the people</span> <span class="t2">who run on your brain.</span></h1>
    <p class="lede">${esc(n.charAt(0).toUpperCase() + n.slice(1))} people with a name, a job and a way of working. They know your business and do the work.</p>
  </header>
  <div class="trail" id="walk">
    <div class="trail__act" data-sc-act="flow" aria-hidden="true"></div>
    <svg class="trail__line" data-line aria-hidden="true" focusable="false"><path d=""/></svg>
    <div class="trail__dog" data-dog data-pose="sit" data-facing="right" data-reward="treat" aria-hidden="true">
      <div class="dog__flip">${dogFrames("fluffy", "dog__svg")}${treatSvg("dog__treat")}<svg class="dog__pat" viewBox="0 0 4 8" shape-rendering="crispEdges" aria-hidden="true"><rect class="pat__sleeve" x="0" y="0" width="4" height="5"/><rect class="pat__hand" x="0" y="5" width="4" height="3"/></svg>${heartSvg("dog__heart")}</div>
    </div>
    ${teams()}
    <section class="wrap team team--end" id="after-walk" aria-labelledby="close-h">
      <h2 class="h2 h2--wide h2--split" id="close-h"><span class="t1">Meet them on your own business.</span> <span class="t2">We set it up.</span></h2>
      <p class="team__cta"><a class="btn btn-gold" href="/contact/#snapshot">Get a free Brain Snapshot</a></p>
    </section>
  </div>
</main>`;
}

export const TEAM_SECTIONS: Record<string, (page: string) => string> = {
  "team-story": () => story(),
};
