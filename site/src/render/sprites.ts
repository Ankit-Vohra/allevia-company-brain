// The office's pixel staff as static SVG, built from the same 16×20 templates and roster palettes as the web app's canvas
// sprites (web/src/office/sprites.ts). Those templates are private to the canvas code, so they are mirrored here; keep the
// two in step when a look changes. Output is crisp at any size and needs no script.
import { AGENTS, type AgentDef } from "../../../shared/roster.ts";
import { darken, lighten, mix } from "../../../web/src/lib/color.ts";

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
