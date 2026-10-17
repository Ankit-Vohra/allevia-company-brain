// Build-time HTML for the "Meet your team" page (site/proto/team/). Merged into SECTIONS by sections.ts.
//
// One section per team, so the whole team reads in a glance. The founder, 2026-10-17, of the old walk that met each person on a card of
// their own: "endless scrolling". Each team shows its name, one line on what it does, and its people: a small drawing of their desk
// with them at it (the app's own pixel sprite) and their role name, which says the job ("Data Detective"). A compact grid on a wide
// screen (a team of three takes two columns), a short list on a phone. The office dogs lie by the button at the end.
//
// Everything real comes from the product: the roster (role names, departments), the pixel people (site/src/render/sprites.ts, the same
// templates and palettes as the app), the desks, chairs, boards, plants and rugs (drawn by the app's own code into team/assets/*.svg by
// team/gen-vignettes.mts) and the dogs (web/src/office/pets.ts). What is composed: the one line under each team.
import { AGENTS, DEPARTMENTS, DEPARTMENT_COUNT, STAFF_COUNT, numberWord, type AgentDef } from "../../../shared/roster.ts";
import { spriteSvg } from "../../src/render/sprites.ts";
import { drawDog, DOG_W, DOG_H, type PetId } from "../../../web/src/office/pets.ts";
import { PEOPLE, VIGNETTE_W, VIGNETTE_H } from "./team-vignettes.generated.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const agent = (id: string): AgentDef => AGENTS.find((a) => a.id === id)!;

// ---------- the teams, in the order a founder meets them ----------

/** One line on what each team does for you, in the order of the page (the trio teams sit where the grid has room for them). */
export const TEAM_LINES: { dept: string; line: string }[] = [
  { dept: "leadership", line: "Takes every request and writes you one clear answer." },
  { dept: "coe", line: "Your key numbers, each one checked before you see it." },
  { dept: "analytics", line: "Where customers come from, and where they drop off." },
  { dept: "marketing", line: "Ads and channels that work, with your OK before any spend." },
  { dept: "content", line: "Posts and reels in your voice, every claim checked." },
  { dept: "sales", line: "Every enquiry answered and the call booked." },
  { dept: "ops", line: "What is pending, who owns it, and what waits on you." },
  { dept: "tech", line: "Your site and app watched day and night, fixes filed." },
  { dept: "knowledge", line: "The company’s memory: what you decided, and why." },
];

// ---------- one person: their desk, them at it, their role name ----------

function figSvg(id: string): string {
  const inner = spriteSvg(id, { size: 16 }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<svg class="fig" viewBox="0 0 16 20" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${inner}</svg>`;
}
/** Hands resting on the keyboard, and the raised arm that waves when you point at them. Drawn over the desk, like the app's drawHands. */
function handsSvg(id: string): string {
  const { skin, shirt } = agent(id).sprite;
  const r = (x: number, y: number, w: number, h: number, c: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
  return `<svg class="hands" viewBox="0 0 16 20" shape-rendering="crispEdges" aria-hidden="true" focusable="false">`
    + `<g class="hands__arm-r">${r(12, 14, 2, 2, shirt)}</g>`
    + `<g class="hands__rest">${r(2, 16, 3, 2, skin)}${r(2, 14, 2, 2, shirt)}</g><g class="hands__tap">${r(11, 16, 3, 2, skin)}</g>`
    + `<g class="hands__wave">${r(14, 8, 2, 6, shirt)}${r(14, 5, 3, 3, skin)}${r(15, 4, 1, 1, skin)}</g>`
    + `</svg>`;
}
const img = (id: string, layer: "back" | "front") => `<img class="art__${layer}" src="./assets/v-${id}-${layer}.svg" alt="" width="${VIGNETTE_W}" height="${VIGNETTE_H}" decoding="async">`;

function person(id: string): string {
  const a = agent(id);
  return `<li class="member" style="--skin:${a.sprite.skin};--shirt:${a.sprite.shirt}">
      <div class="art" aria-hidden="true">${img(id, "back")}<div class="who">${figSvg(id)}</div>${img(id, "front")}<div class="who who--hands">${handsSvg(id)}</div></div>
      <span class="member__name">${esc(a.name)}</span>
    </li>`;
}

// ---------- a team ----------

function team(t: { dept: string; line: string }): string {
  const d = DEPARTMENTS.find((x) => x.id === t.dept)!;
  const ids = PEOPLE.filter((p) => p.dept === t.dept).map((p) => p.id);
  return `<section class="dept${ids.length > 2 ? " dept--wide" : ""}" data-team="${t.dept}" aria-labelledby="team-${t.dept}" style="--hue:${d.hue}">
    <h2 class="dept__name" id="team-${t.dept}">${esc(d.name)}</h2>
    <p class="dept__line">${esc(t.line)}</p>
    <ul class="dept__people" aria-label="${esc(d.name)}: ${esc(ids.map((id) => agent(id).name).join(", "))}">
    ${ids.map(person).join("")}
    </ul>
  </section>`;
}

// ---------- the office dogs, lying by the button ----------

interface Rect { x: number; y: number; w: number; h: number; fill: string }
function dogSvg(id: PetId): string {
  const rects: Rect[] = [];
  const ctx = { fillStyle: "#000" as string, fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, fill: String(this.fillStyle) }); } };
  drawDog(ctx as unknown as CanvasRenderingContext2D, id, "lie", 0, 0, 0, "right");
  const body = rects.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`).join("");
  return `<svg class="dog dog--${id}" viewBox="0 0 ${DOG_W} ${DOG_H}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${body}</svg>`;
}

// ---------- the page ----------

function story(): string {
  const people = cap(numberWord(STAFF_COUNT)), teams = numberWord(DEPARTMENT_COUNT);
  return `<div class="team-page">
  <header class="team__head wrap">
    <h1 class="h2 h2--wide h2--split"><span class="t1">Meet your team.</span> <span class="t2">Each name says the job.</span></h1>
    <p class="lede">${esc(people)} people in ${esc(teams)} teams. They know your business and do the work.</p>
  </header>
  <div class="wrap depts">
    ${TEAM_LINES.map(team).join("\n    ")}
  </div>
  <section class="band band--ink on-ink team--end" aria-labelledby="close-h">
    <div class="wrap team__close">
      <div class="dogs" aria-hidden="true">${dogSvg("jj")}${dogSvg("fluffy")}${dogSvg("zoe")}</div>
      <h2 class="h2 h2--split" id="close-h"><span class="t1">Meet them on your own business.</span> <span class="t2">We set it up.</span></h2>
      <p class="team__cta"><a class="btn btn-gold" href="/contact/#snapshot">Get a free Brain Snapshot</a></p>
    </div>
  </section>
</div>`;
}

export const TEAM_SECTIONS: Record<string, (page: string) => string> = {
  "team-story": () => story(),
};
