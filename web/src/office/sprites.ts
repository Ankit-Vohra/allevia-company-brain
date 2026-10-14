// Our own pixel characters (16×20, seated, facing the viewer), built from each agent's roster palette. No third-party
// sprite art: every pixel is in the templates below.
import { AGENTS, type AgentDef } from "@shared/roster";
import { darken, lighten, mix } from "../lib/color";

export const SPRITE_W = 16;
export const SPRITE_H = 20;

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

// o hair outline · h hair · H hair highlight · A accent · g glasses frame · '.' leave as is
const HAIR: Record<string, string[]> = {
  short: [
    "................",
    ".....oooooo.....",
    "...oohhhhhhoo...",
    "..ohhhHHhhhhho..",
    "..ohhhhhhhhhho..",
    "..ohh......hho..",
    "..oh........ho..",
  ],
  sidepart: [
    "................",
    ".....oooooo.....",
    "...oohhhhhhoo...",
    "..ohhhhhhHHhho..",
    "..ohhhhhhh..ho..",
    "..ohh.......ho..",
    "..oh........ho..",
  ],
  spiky: [
    "....o..o..o.....",
    "...ohoohoohoo...",
    "...oohhhhhhoo...",
    "..ohhhHHhhhhho..",
    "..ohhhhhhhhhho..",
    "..ohh......hho..",
    "..oh........ho..",
  ],
  curly: [
    "................",
    "....oooooooo....",
    "..oohhhhhhhhoo..",
    ".ohhhHhhhHhhhho.",
    ".ohhhhhhhhhhhho.",
    ".ohhh......hhho.",
    "..oh........ho..",
  ],
  long: [
    "................",
    ".....oooooo.....",
    "...oohhhhhhoo...",
    "..ohhhHHhhhhho..",
    "..ohhhhhhhhhho..",
    ".ohhh......hhho.",
    ".ohh........hho.",
    ".ohh........hho.",
    ".ohh........hho.",
    ".ohh........hho.",
    ".ohh........hho.",
    ".ohh........hho.",
    ".ohhh......hhho.",
    ".ohhh......hhho.",
    "..oo........oo..",
  ],
  bob: [
    "................",
    ".....oooooo.....",
    "...oohhhhhhoo...",
    "..ohhhHHhhhhho..",
    "..ohhhhhhhhhho..",
    ".ohhhhh..hhhhho.",
    ".ohh........hho.",
    ".ohh........hho.",
    ".ohh........hho.",
    ".ohhh......hhho.",
    ".oooo......oooo.",
  ],
  bun: [
    "......oooo......",
    ".....ohHhho.....",
    "...oohhhhhhoo...",
    "..ohhhHHhhhhho..",
    "..ohhhhhhhhhho..",
    "..ohh......hho..",
    "..oh........ho..",
  ],
};

const EXTRAS: Record<string, string[]> = {
  glasses: ["", "", "", "", "", "", "....g.gggg.g....", "....g.g..g.g....", "....ggg..ggg...."],
  beard: ["", "", "", "", "", "", "", "", "", "...hhhh..hhhh...", "....hhhhhhhh....", ".....oooooo....."],
  mustache: ["", "", "", "", "", "", "", "", "......hhhh......"],
  clip: ["", "", "", "..........AA....", "..........AA...."],
};

interface Look { hair: keyof typeof HAIR; extras: (keyof typeof EXTRAS)[] }

// Hair styles and accessories are a UI choice (not in the roster contract), keyed by agent id.
const LOOKS: Record<string, Look> = {
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

export type Eyes = "open" | "closed" | "left" | "right" | "happy";
export interface Variant { bob: 0 | 1; eyes: Eyes; arms?: "up" }

function paletteFor(a: AgentDef) {
  const { skin, hair, shirt, accent } = a.sprite;
  return {
    O: darken(skin, 0.62),
    s: skin,
    S: darken(skin, 0.16),
    b: mix(skin, "#E0707A", 0.28),
    e: "#1B1830",
    m: darken(skin, 0.38),
    t: shirt,
    T: darken(shirt, 0.22),
    a: accent,
    A: accent,
    o: darken(hair, 0.5),
    h: hair,
    H: lighten(hair, 0.28),
    g: "#22223A",
  } as Record<string, string>;
}

const cache = new Map<string, HTMLCanvasElement>();

/** A 16×20 canvas for this agent and variant (cached). */
export function spriteCanvas(agentId: string, v: Variant): HTMLCanvasElement {
  const key = `${agentId}|${v.bob}|${v.eyes}|${v.arms ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = AGENTS.find((a) => a.id === agentId) ?? AGENTS[0]!;
  const pal = paletteFor(def);
  const look = LOOKS[def.id] ?? { hair: "short", extras: [] };
  const c = document.createElement("canvas");
  c.width = SPRITE_W;
  c.height = SPRITE_H;
  const ctx = c.getContext("2d")!;
  const px = (x: number, y: number, col: string | undefined) => {
    if (!col) return;
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 1, 1);
  };
  // head rows (0..11) bob down by 1px on breath frames; torso stays
  const headShift = v.bob;
  BASE.forEach((row, y) => {
    const isHead = y <= 11;
    const yy = isHead ? y + headShift : y;
    for (let x = 0; x < SPRITE_W; x++) {
      const ch = row[x]!;
      if (ch === ".") continue;
      px(x, yy, pal[ch === "e" ? "s" : ch]);
    }
  });
  // eyes: two pixels tall; closed is a lash line, a glance moves the pupils one pixel
  const dx = v.eyes === "left" ? -1 : v.eyes === "right" ? 1 : 0;
  for (const ex of [5, 10]) {
    if (v.eyes === "closed") px(ex, 7 + headShift, pal.m);
    else if (v.eyes === "happy") { px(ex - 1, 7 + headShift, pal.m); px(ex, 6 + headShift, pal.m); px(ex + 1, 7 + headShift, pal.m); }
    else { px(ex + dx, 6 + headShift, pal.e); px(ex + dx, 7 + headShift, pal.e); }
  }
  const overlay = (rows: string[]) =>
    rows.forEach((row, y) => {
      for (let x = 0; x < Math.min(row.length, SPRITE_W); x++) {
        const ch = row[x]!;
        if (ch === "." || ch === " ") continue;
        px(x, y + headShift, pal[ch]);
      }
    });
  overlay(HAIR[look.hair]!);
  for (const ex of look.extras) overlay(EXTRAS[ex]!);
  if (v.arms === "up") {
    // hooray: hands raised beside the head
    for (const [x, y] of [[0, 8], [1, 8], [0, 9], [1, 9], [14, 8], [15, 8], [14, 9], [15, 9]] as const) px(x, y, pal.s);
    for (const [x, y] of [[1, 10], [1, 11], [2, 12], [14, 10], [14, 11], [13, 12]] as const) px(x, y, pal.t);
  }
  cache.set(key, c);
  return c;
}

export function skinOf(agentId: string) {
  return (AGENTS.find((a) => a.id === agentId) ?? AGENTS[0]!).sprite.skin;
}
export function shirtOf(agentId: string) {
  return (AGENTS.find((a) => a.id === agentId) ?? AGENTS[0]!).sprite.shirt;
}

const avatarCache = new Map<string, string>();

/** A head-and-shoulders portrait as a data URL, for avatars in lists (crisp at any integer scale). */
export function avatarUrl(agentId: string, scale = 4, eyes: Eyes = "open"): string {
  const key = `${agentId}|${scale}|${eyes}`;
  const hit = avatarCache.get(key);
  if (hit) return hit;
  if (typeof document === "undefined") return "";
  const src = spriteCanvas(agentId, { bob: 0, eyes });
  const c = document.createElement("canvas");
  const crop = { x: 0, y: 0, w: 16, h: 16 };
  c.width = crop.w * scale;
  c.height = crop.h * scale;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/png");
  avatarCache.set(key, url);
  return url;
}
