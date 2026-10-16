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
  "sales-lead": { hair: "sidepart", extras: [] },
  librarian: { hair: "bun", extras: ["glasses"] },
};

export type Eyes = "open" | "closed" | "left" | "right" | "happy";
export type Dir = "front" | "back" | "left" | "right";
export interface Variant { bob: 0 | 1 | 2 | 3; eyes: Eyes; arms?: "up"; dir?: Dir }

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
    p: mix(darken(shirt, 0.55), "#2B2F4A", 0.5),   // trousers
    P: mix(darken(shirt, 0.7), "#1C1F33", 0.5),    // shoes
  } as Record<string, string>;
}

type Painter = (x: number, y: number, col: string | undefined) => void;

/** The head (rows 0..11 of the base) and its hair and glasses, shifted down `shift` rows. Facing away shows hair only. */
function paintHead(px: Painter, pal: Record<string, string>, look: Look, v: { eyes: Eyes; dir: Dir; shift: number }) {
  const back = v.dir === "back";
  BASE.forEach((row, y) => {
    if (y > 11) return;
    for (let x = 0; x < SPRITE_W; x++) {
      const ch = row[x]!;
      if (ch === ".") continue;
      const key = back && "sSbme".includes(ch) ? "h" : ch === "e" ? "s" : ch;
      px(x, y + v.shift, pal[key]);
    }
  });
  if (!back) {
    // eyes: two pixels tall; closed is a lash line; a turn of the head moves the pupils and the mouth
    const turn = v.dir === "left" ? -2 : v.dir === "right" ? 2 : 0;
    const glance = v.eyes === "left" ? -1 : v.eyes === "right" ? 1 : 0;
    for (const ex of [5, 10]) {
      if (v.eyes === "closed") px(ex + turn, 7 + v.shift, pal.m);
      else if (v.eyes === "happy") { px(ex + turn - 1, 7 + v.shift, pal.m); px(ex + turn, 6 + v.shift, pal.m); px(ex + turn + 1, 7 + v.shift, pal.m); }
      else { px(ex + turn + glance, 6 + v.shift, pal.e); px(ex + turn + glance, 7 + v.shift, pal.e); }
    }
    if (turn) { px(7, 9 + v.shift, pal.s); px(8, 9 + v.shift, pal.s); px(7 + turn / 2, 9 + v.shift, pal.m); px(8 + turn / 2, 9 + v.shift, pal.m); }
  }
  const overlay = (rows: string[]) =>
    rows.forEach((row, y) => {
      for (let x = 0; x < Math.min(row.length, SPRITE_W); x++) {
        const ch = row[x]!;
        if (ch === "." || ch === " ") continue;
        px(x, y + v.shift, pal[ch]);
      }
    });
  overlay(HAIR[look.hair]!);
  if (back) {
    // from behind the hair covers the whole head
    for (let y = 3; y <= 10; y++) for (let x = 3; x <= 12; x++) px(x, y + v.shift, pal.h);
    for (let x = 4; x <= 11; x++) px(x, 11 + v.shift, pal.o);
  } else for (const ex of look.extras) overlay(EXTRAS[ex]!);
}

const cache = new Map<string, HTMLCanvasElement>();
const lookOf = (def: AgentDef): Look => LOOKS[def.id] ?? { hair: "short", extras: [] };

/** A 16×20 seated canvas for this agent and variant (cached). */
export function spriteCanvas(agentId: string, v: Variant): HTMLCanvasElement {
  const dir = v.dir ?? "front";
  const key = `${agentId}|${v.bob}|${v.eyes}|${v.arms ?? ""}|${dir}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = AGENTS.find((a) => a.id === agentId) ?? AGENTS[0]!;
  const pal = paletteFor(def);
  const c = document.createElement("canvas");
  c.width = SPRITE_W;
  c.height = SPRITE_H;
  const ctx = c.getContext("2d")!;
  const px: Painter = (x, y, col) => {
    if (!col) return;
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 1, 1);
  };
  // the torso stays; the head (rows 0..11) bobs down on breath frames, and further when someone nods off
  BASE.forEach((row, y) => {
    if (y <= 11) return;
    for (let x = 0; x < SPRITE_W; x++) { const ch = row[x]!; if (ch !== ".") px(x, y, pal[ch]); }
  });
  paintHead(px, pal, lookOf(def), { eyes: v.eyes, dir, shift: v.bob });
  if (v.arms === "up") raiseHands(px, pal);
  cache.set(key, c);
  return c;
}

function raiseHands(px: Painter, pal: Record<string, string>) {
  for (const [x, y] of [[0, 8], [1, 8], [0, 9], [1, 9], [14, 8], [15, 8], [14, 9], [15, 9]] as const) px(x, y, pal.s);
  for (const [x, y] of [[1, 10], [1, 11], [2, 12], [14, 10], [14, 11], [13, 12]] as const) px(x, y, pal.t);
}

export const WALKER_H = 26;
export interface WalkerVariant { dir: Dir; frame: 0 | 1 | 2; eyes?: Eyes; arms?: "up"; bob?: 0 | 1 }

/** A standing figure, 16×26, for walking around the office: four facings, two walking frames and a standing one. */
export function walkerCanvas(agentId: string, v: WalkerVariant): HTMLCanvasElement {
  const key = `w|${agentId}|${v.dir}|${v.frame}|${v.eyes ?? "open"}|${v.arms ?? ""}|${v.bob ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = AGENTS.find((a) => a.id === agentId) ?? AGENTS[0]!;
  const pal = paletteFor(def);
  const c = document.createElement("canvas");
  c.width = SPRITE_W;
  c.height = WALKER_H;
  const ctx = c.getContext("2d")!;
  const px: Painter = (x, y, col) => { if (col) { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); } };
  const rect = (x: number, y: number, w: number, h: number, col: string) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); };
  const side = v.dir === "left" || v.dir === "right";
  // torso: the seated body's shoulders and chest, then the hips and legs
  BASE.forEach((row, y) => {
    if (y <= 11 || y > 17) return;
    for (let x = 0; x < SPRITE_W; x++) {
      const ch = row[x]!;
      if (ch === ".") continue;
      if (side && (x < 3 || x > 12)) continue; // side-on: a narrower chest
      px(x, y, pal[ch]);
    }
  });
  const hipX0 = side ? 4 : 3, hipW = side ? 8 : 10;
  rect(hipX0, 18, hipW, 2, pal.p!);
  rect(hipX0, 18, hipW, 1, darken(pal.p!, 0.25));
  if (side) {
    const dirk = v.dir === "right" ? 1 : -1;
    const stride = v.frame === 0 ? 0 : 2;
    rect(6 + stride * dirk, 20, 3, 5, pal.p!); rect(6 + stride * dirk, 25, 4, 1, pal.P!);
    if (v.frame) { rect(6 - stride * dirk, 20, 3, 4, darken(pal.p!, 0.18)); rect(6 - stride * dirk, 24, 4, 1, pal.P!); }
    else { rect(7, 20, 3, 5, darken(pal.p!, 0.18)); rect(7, 25, 4, 1, pal.P!); }
  } else {
    const l = v.frame === 2 ? 5 : 6, r = v.frame === 1 ? 5 : 6;
    rect(4, 20, 3, l, pal.p!); rect(4, 20 + l, 3, 1, pal.P!);
    rect(9, 20, 3, r, pal.p!); rect(9, 20 + r, 3, 1, pal.P!);
    rect(7, 20, 2, 2, darken(pal.p!, 0.3));
  }
  paintHead(px, pal, lookOf(def), { eyes: v.eyes ?? "open", dir: v.dir, shift: v.bob ?? 0 });
  if (v.arms === "up") raiseHands(px, pal);
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
