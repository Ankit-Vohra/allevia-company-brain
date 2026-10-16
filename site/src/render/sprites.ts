/// <reference lib="dom" />
// (The dog painter in web/src/office/pets.ts is typed against the canvas, and the root tsconfig has no DOM types.)
// The office's pixel staff as static SVG, built from the same 16×20 templates and roster palettes as the web app's canvas
// sprites (web/src/office/sprites.ts). Those templates are private to the canvas code, so they are mirrored here; keep the
// two in step when a look changes. Output is crisp at any size and needs no script.
import { AGENTS, type AgentDef } from "../../../shared/roster.ts";
import { darken, lighten, mix } from "../../../web/src/lib/color.ts";
import { drawDog, drawTreat, DOG_W, DOG_H, type PetId, type PetPose } from "../../../web/src/office/pets.ts";

const W = 16;

// O outline · s skin · S skin shade · b blush · e eye · m mouth · t shirt · T shirt shade · a accent (collar / lanyard)
const BASE = [
  "................",
  "................",
  "....OOOOOOOO....",
  "...OssssssssO...",
  "..OssssssssssO..",
  "..OssssssssssO..",
  "..OssessssessO..",
  "..OssessssessO..",
  "..ObssssssssbO..",
  "..OSsssmmsssSO..",
  "...OSssssssSO...",
  "....OOOSSOOO....",
  "....OttaattO....",
  "...OtttaatttO...",
  "..OttttaattttO..",
  "..OTtttaatttTO..",
  "..OTtttaatttTO..",
  "..OTtttaatttTO..",
  "..OTtttaatttTO..",
  "..OTtttaatttTO..",
];

// o hair outline · h hair · H hair highlight · A accent · g glasses frame
const HAIR: Record<string, string[]> = {
  short: ["................", ".....oooooo.....", "...oohhhhhhoo...", "..ohhhHHhhhhho..", "..ohhhhhhhhhho..", "..ohh......hho..", "..oh........ho.."],
  sidepart: ["................", ".....oooooo.....", "...oohhhhhhoo...", "..ohhhhhhHHhho..", "..ohhhhhhh..ho..", "..ohh.......ho..", "..oh........ho.."],
  spiky: ["....o..o..o.....", "...ohoohoohoo...", "...oohhhhhhoo...", "..ohhhHHhhhhho..", "..ohhhhhhhhhho..", "..ohh......hho..", "..oh........ho.."],
  curly: ["................", "....oooooooo....", "..oohhhhhhhhoo..", ".ohhhHhhhHhhhho.", ".ohhhhhhhhhhhho.", ".ohhh......hhho.", "..oh........ho.."],
  long: [
    "................", ".....oooooo.....", "...oohhhhhhoo...", "..ohhhHHhhhhho..", "..ohhhhhhhhhho..", ".ohhh......hhho.",
    ".ohh........hho.", ".ohh........hho.", ".ohh........hho.", ".ohh........hho.", ".ohh........hho.", ".ohh........hho.",
    ".ohhh......hhho.", ".ohhh......hhho.", "..oo........oo..",
  ],
  bob: [
    "................", ".....oooooo.....", "...oohhhhhhoo...", "..ohhhHHhhhhho..", "..ohhhhhhhhhho..", ".ohhhhh..hhhhho.",
    ".ohh........hho.", ".ohh........hho.", ".ohh........hho.", ".ohhh......hhho.", ".oooo......oooo.",
  ],
  bun: ["......oooo......", ".....ohHhho.....", "...oohhhhhhoo...", "..ohhhHHhhhhho..", "..ohhhhhhhhhho..", "..ohh......hho..", "..oh........ho.."],
};

const EXTRAS: Record<string, string[]> = {
  glasses: ["", "", "", "", "", "", "....g.gggg.g....", "....g.g..g.g....", "....ggg..ggg...."],
  beard: ["", "", "", "", "", "", "", "", "", "...hhhh..hhhh...", "....hhhhhhhh....", ".....oooooo....."],
  mustache: ["", "", "", "", "", "", "", "", "......hhhh......"],
  clip: ["", "", "", "..........AA....", "..........AA...."],
};

const LOOKS: Record<string, { hair: string; extras: string[] }> = {
  "chief-of-staff": { hair: "long", extras: [] },
  "coe-lead": { hair: "bun", extras: [] },
  "data-analyst": { hair: "curly", extras: [] },
  "growth-marketer": { hair: "spiky", extras: [] },
  "content-strategist": { hair: "long", extras: ["clip"] },
  "copy-editor": { hair: "short", extras: ["beard"] },
  "fact-checker": { hair: "bob", extras: [] },
  "tech-lead": { hair: "sidepart", extras: ["glasses"] },
  "ops-manager": { hair: "short", extras: ["mustache"] },
  librarian: { hair: "bun", extras: ["glasses"] },
};

function paletteFor(a: AgentDef): Record<string, string> {
  const { skin, hair, shirt, accent } = a.sprite;
  return {
    O: darken(skin, 0.62), s: skin, S: darken(skin, 0.16), b: mix(skin, "#E0707A", 0.28), e: "#1B1830",
    m: darken(skin, 0.38), t: shirt, T: darken(shirt, 0.22), a: accent, A: accent,
    o: darken(hair, 0.5), h: hair, H: lighten(hair, 0.28), g: "#22223A",
  };
}

/** The agent's pixel grid (rows × 16 colours, undefined = transparent), seated, eyes open. */
function grid(agentId: string, rows: number): (string | undefined)[][] {
  const def = AGENTS.find((a) => a.id === agentId) ?? AGENTS[0]!;
  const pal = paletteFor(def);
  const look = LOOKS[def.id] ?? { hair: "short", extras: [] };
  const g: (string | undefined)[][] = Array.from({ length: rows }, () => Array<string | undefined>(W).fill(undefined));
  const put = (x: number, y: number, col: string | undefined) => { if (col && y < rows) g[y]![x] = col; };
  BASE.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== ".") put(x, y, pal[ch === "e" ? "s" : ch]); }));
  for (const ex of [5, 10]) { put(ex, 6, pal.e); put(ex, 7, pal.e); }
  const overlay = (lines: string[]) => lines.forEach((row, y) => [...row].slice(0, W).forEach((ch, x) => { if (ch !== "." && ch !== " ") put(x, y, pal[ch]); }));
  overlay(HAIR[look.hair]!);
  for (const ex of look.extras) overlay(EXTRAS[ex]!);
  return g;
}

/** An inline SVG of one agent: 16×20 seated figure, or 16×16 head-and-shoulders when `portrait`. */
export function spriteSvg(agentId: string, opts: { size: number; portrait?: boolean; label?: string }): string {
  const rows = opts.portrait ? 16 : 20;
  const g = grid(agentId, rows);
  const rects: string[] = [];
  g.forEach((row, y) => {
    let x = 0;
    while (x < W) {
      const col = row[x];
      if (!col) { x++; continue; }
      let run = 1;
      while (x + run < W && row[x + run] === col) run++;
      rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${col}"/>`);
      x += run;
    }
  });
  const h = Math.round((opts.size * rows) / W);
  const a11y = opts.label ? `role="img" aria-label="${opts.label}"` : `aria-hidden="true"`;
  return `<svg class="sprite" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${rows}" width="${opts.size}" height="${h}" shape-rendering="crispEdges" ${a11y}>${rects.join("")}</svg>`;
}

// ---------- the office dogs ----------
// Drawn by the web app's own painter (web/src/office/pets.ts) into a recording "canvas" that keeps the rectangles, so the
// dog on the website is the same dog as in the office, pixel for pixel.

interface Rect { x: number; y: number; w: number; h: number; fill: string }
function paint(draw: (c: CanvasRenderingContext2D) => void): Rect[] {
  const rects: Rect[] = [];
  const ctx = {
    fillStyle: "#000" as string,
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, fill: String(this.fillStyle) }); },
  };
  draw(ctx as unknown as CanvasRenderingContext2D);
  return rects;
}
const rectsSvg = (rects: Rect[]) => rects.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`).join("");

/**
 * One office dog as an inline SVG holding three frames (two walking strides carrying a page, and sitting), stacked so
 * CSS shows one at a time. The grid is the app's 22×14 dog box plus 3 rows of headroom for the page in her mouth.
 */
export function dogSvg(id: PetId, opts: { size: number; label?: string }): string {
  const frame = (pose: PetPose, f: number, cls: string, page: boolean) => {
    const dog = paint((c) => drawDog(c, id, pose, f, 0, 3, "right"));
    const sheet = page
      ? `<rect x="18" y="0" width="5" height="6" fill="#FFFFFF"/><rect x="18" y="0" width="5" height="1" fill="#D9D2C3"/><rect x="19" y="2" width="3" height="1" fill="#B9AE9B"/><rect x="19" y="4" width="3" height="1" fill="#B9AE9B"/>`
      : "";
    return `<g class="dog__f dog__f--${cls}">${rectsSvg(dog)}${sheet}</g>`;
  };
  const w = DOG_W + 1;
  const h = DOG_H + 3;
  const a11y = opts.label ? `role="img" aria-label="${opts.label}"` : `aria-hidden="true"`;
  return `<svg class="dog" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${opts.size}" height="${Math.round((opts.size * h) / w)}" shape-rendering="crispEdges" ${a11y}>${frame("carry", 0, "a", true)}${frame("carry", 1, "b", true)}${frame("sit", 0, "sit", false)}</svg>`;
}

/** The biscuit a dog gets for each delivery (the app's 5×3 treat). */
export function treatSvg(size = 15): string {
  const r = paint((c) => drawTreat(c, 0, 0));
  return `<svg class="treat" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 3" width="${size}" height="${Math.round((size * 3) / 5)}" shape-rendering="crispEdges" aria-hidden="true">${rectsSvg(r)}</svg>`;
}
