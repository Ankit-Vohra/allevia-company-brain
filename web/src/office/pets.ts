// The office pets, drawn pixel by pixel (no third-party art): three dogs who carry the documents and two cats who nap and
// wander. Sprites face right and are mirrored for left; every one is a handful of rectangles, so a breed is a palette and
// a few shape choices.
import { oklch } from "../lib/color";

type Ctx = CanvasRenderingContext2D;

export type PetId = "fluffy" | "jj" | "zoe" | "mochi" | "pepper";
export type PetPose = "walk" | "sit" | "lie" | "carry";

export interface PetDef {
  id: PetId;
  name: string;
  kind: "dog" | "cat";
  breed: string;
  blurb: string;
}

export const PETS: PetDef[] = [
  { id: "fluffy", name: "Fluffy", kind: "dog", breed: "golden retriever", blurb: "office dog" },
  { id: "jj", name: "JJ", kind: "dog", breed: "chow chow", blurb: "office dog" },
  { id: "zoe", name: "Zoe", kind: "dog", breed: "poodle", blurb: "office dog" },
  { id: "mochi", name: "Mochi", kind: "cat", breed: "ginger cat", blurb: "office cat" },
  { id: "pepper", name: "Pepper", kind: "cat", breed: "grey cat", blurb: "office cat" },
];
export const petById = (id: PetId) => PETS.find((p) => p.id === id)!;

interface Breed { body: string; light: string; dark: string; nose: string; tongue: string; ear: "floppy" | "round" | "curly"; tail: "feather" | "curl" | "pom" }
const BREEDS: Record<string, Breed> = {
  fluffy: { body: "#D9A441", light: "#F2D68F", dark: "#B27B20", nose: "#2B1B12", tongue: "#E8737A", ear: "floppy", tail: "feather" },
  jj: { body: "#CC7B40", light: "#F1D3A6", dark: "#8E4C24", nose: "#1E1919", tongue: "#5B3A6E", ear: "round", tail: "curl" },
  zoe: { body: "#4B3025", light: "#6E4938", dark: "#33201A", nose: "#161010", tongue: "#E8737A", ear: "curly", tail: "pom" },
};

export const DOG_W = 22;
export const DOG_H = 14;
export const CAT_W = 12;
export const CAT_H = 8;

/** One dog. (x, y) is the top-left of a 22×14 box; `frame` flips the stride; `breath` lifts the body a pixel when asleep. */
export function drawDog(c: Ctx, id: PetId, pose: PetPose, frame: number, x: number, y: number, facing: "left" | "right", opts: { panting?: boolean; blink?: boolean } = {}) {
  const b = BREEDS[id]!;
  const W = DOG_W;
  const mir = facing === "left";
  const rr = (rx: number, ry: number, w: number, h: number, col: string) => {
    c.fillStyle = col;
    c.fillRect(Math.round(x + (mir ? W - rx - w : rx)), Math.round(y + ry), w, h);
  };
  const eye = "#1E140F";
  const shadow = "rgba(40,30,60,0.16)";
  if (pose === "lie") {
    rr(2, 12, 17, 1, shadow);
    rr(2, 6, 13, 6, b.body); rr(3, 5, 10, 1, b.body);
    rr(3, 11, 10, 1, b.dark);
    rr(14, 7, 6, 5, b.body); rr(15, 6, 4, 1, b.body);
    rr(14, 7, 2, 4, b.ear === "round" ? b.dark : b.dark);
    rr(18, 9, 4, 3, b.light); P(rr, 21, 9, b.nose);
    P(rr, 17, 8, eye); rr(16, 8, 2, 1, eye);
    rr(15, 11, 5, 1, b.light);
    if (b.tail === "feather") rr(0, 9, 3, 2, b.body); else if (b.tail === "pom") rr(0, 8, 3, 3, b.light); else rr(0, 8, 3, 3, b.body);
    if (b.ear === "round") { rr(15, 5, 2, 2, b.dark); }
    if (b.ear === "curly") rr(13, 8, 2, 4, b.dark);
    return;
  }
  if (pose === "sit") {
    rr(2, 13, 16, 1, shadow);
    rr(3, 7, 7, 6, b.body); rr(4, 6, 5, 1, b.body);          // haunch
    rr(8, 3, 4, 10, b.body);                                  // upright chest and back
    rr(10, 9, 2, 4, b.light);
    rr(11, 6, 2, 7, b.body); rr(13, 6, 2, 7, b.light);        // front legs
    rr(11, 0, 6, 5, b.body); rr(10, 1, 1, 3, b.body);          // head
    rr(16, 2, 4, 3, b.light); P(rr, 19, 2, b.nose);
    P(rr, 15, 1, eye);
    if (b.ear === "floppy") rr(11, 0, 2, 4, b.dark); else if (b.ear === "round") rr(12, -1 + 1, 2, 1, b.dark); else rr(10, 1, 2, 5, b.dark);
    if (b.ear === "curly") rr(11, 0, 4, 1, b.light);
    if (opts.panting) rr(18, 5, 2, 1, b.tongue);
    if (b.tail === "feather") rr(0, 11, 4, 2, b.body); else if (b.tail === "pom") rr(0, 10, 3, 3, b.light); else rr(0, 10, 3, 3, b.body);
    return;
  }
  // walking, or carrying something in its mouth: the same stride, the head up
  const f = frame % 2;
  const bob = f ? 1 : 0;
  rr(3, 13, 16, 1, shadow);
  // legs: diagonal pairs swing
  const legs: [number, number][] = [[5, f ? 4 : 3], [8, f ? 3 : 4], [13, f ? 3 : 4], [16, f ? 4 : 3]];
  const legW = id === "zoe" ? 1 : 2;
  for (const [lx, len] of legs) {
    rr(lx, 13 - len, legW, len, id === "zoe" ? b.dark : b.body);
    if (id === "zoe") rr(lx - 1, 12, 3, 1, b.light);  // the poodle's pom-pom ankles
    else rr(lx, 12, legW, 1, b.light);
  }
  if (id === "zoe") {
    rr(5, 4 + bob, 11, 5, b.body); rr(5, 5 + bob, 9, 3, b.body);
    for (let px = 6; px < 15; px += 2) P(rr, px, 5 + bob + (px % 4 === 0 ? 1 : 0), b.light);
    rr(15, 3 + bob, 2, 5, b.body);
  } else if (id === "jj") {
    rr(4, 3 + bob, 12, 6, b.body); rr(5, 8 + bob, 10, 1, b.light);
    rr(14, 2 + bob, 3, 7, b.light); // the ruff
  } else {
    rr(4, 4 + bob, 12, 5, b.body); rr(5, 8 + bob, 10, 1, b.light);
    rr(15, 3 + bob, 2, 6, b.body);
  }
  // head
  const hy = (id === "jj" ? 1 : 1) + bob;
  if (id === "jj") {
    rr(15, hy - 1, 7, 7, b.light); rr(16, hy - 1, 5, 7, b.body); rr(15, hy + 1, 2, 4, b.light);
    rr(19, hy + 2, 3, 3, b.dark); P(rr, 21, hy + 2, b.nose);
    P(rr, 18, hy + 1, eye);
    rr(16, hy - 2, 2, 2, b.dark); rr(19, hy - 2, 2, 1, b.dark);
    rr(19, hy + 5, 2, 1, b.tongue);
  } else if (id === "zoe") {
    rr(15, hy, 5, 5, b.body); rr(15, hy - 2, 5, 3, b.light); rr(16, hy - 3, 3, 1, b.light);
    rr(19, hy + 2, 3, 2, b.light); P(rr, 21, hy + 2, b.nose);
    P(rr, 18, hy + 1, eye);
    rr(14, hy + 1, 2, 5, b.dark);
  } else {
    rr(15, hy, 5, 5, b.body);
    rr(19, hy + 2, 3, 3, b.light); P(rr, 21, hy + 2, b.nose);
    P(rr, 18, hy + 1, eye);
    rr(15, hy, 2, 4, b.dark);
  }
  if (pose === "walk" && (opts.panting || f)) rr(id === "jj" ? 19 : 20, hy + (id === "jj" ? 5 : 5), 2, 1, b.tongue);
  // the tail
  if (b.tail === "feather") { rr(1, 3 + bob, 4, 2, b.body); rr(0, 2 + bob, 2, 2, b.body); rr(1, 5 + bob, 3, 1, b.light); }
  else if (b.tail === "curl") { rr(2, 1 + bob, 4, 2, b.body); rr(1, 2 + bob, 2, 3, b.body); rr(3, 0 + bob, 3, 1, b.light); }
  else { rr(2, 3 + bob, 3, 2, b.dark); rr(0, 2 + bob, 3, 3, b.light); }
}

// P(rr, …) paints one pixel through a rectangle painter
function P(rr: (x: number, y: number, w: number, h: number, col: string) => void, x: number, y: number, col: string) { rr(x, y, 1, 1, col); }

// ---------------------------------------------------------------- cats (the same ASCII style as before, two coats)

const CAT = {
  walkA: ["........k.k.", "........kkk.", "k.......kek.", ".k.kskskkkk.", "..kkkkkkkk..", "..k.k..k.k.."],
  walkB: ["........k.k.", "........kkk.", "k.......kek.", ".k.kskskkkk.", "..kkkkkkkk..", "...kk..kk..."],
  sit: ["......k.k...", "......kkk...", "......kek...", ".....kkkk...", "k...kskkk...", ".kkkkkkkk..."],
  lie: ["............", "............", "...kkkk.....", "..kskskkk.k.", ".kkkkkkkkk..", "..kkkkkkk..."],
};
const COAT: Record<string, { fur: string; stripe: string; eye: string }> = {
  mochi: { fur: oklch(0.72, 0.13, 58), stripe: oklch(0.55, 0.12, 50), eye: "#2A2418" },
  pepper: { fur: oklch(0.52, 0.015, 270), stripe: oklch(0.38, 0.015, 270), eye: "#E8E070" },
};

/** One cat in a 12×8 box (the bottom row is where the paws land). */
export function drawCat(c: Ctx, id: PetId, pose: PetPose, frame: number, x: number, y: number, facing: "left" | "right") {
  const coat = COAT[id]!;
  const tpl = pose === "lie" ? CAT.lie : pose === "sit" ? CAT.sit : frame % 2 ? CAT.walkA : CAT.walkB;
  c.fillStyle = "rgba(40,30,60,0.14)";
  c.fillRect(Math.round(x + 2), Math.round(y + 6), 8, 1);
  tpl.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx]!;
      if (ch === ".") continue;
      c.fillStyle = ch === "e" ? coat.eye : ch === "s" ? coat.stripe : coat.fur;
      const px = facing === "right" ? rx : row.length - 1 - rx;
      c.fillRect(Math.round(x + px), Math.round(y + ry), 1, 1);
    }
  });
}

/** A biscuit-shaped dog treat (5×3). */
export function drawTreat(c: Ctx, x: number, y: number, scale = 1) {
  const X = Math.round(x), Y = Math.round(y);
  c.fillStyle = "#A8672E";
  c.fillRect(X, Y, 5 * scale, 3 * scale);
  c.fillStyle = "#D9A25F";
  c.fillRect(X + 1, Y, 3 * scale, 2 * scale);
  c.fillStyle = "#F0C892";
  c.fillRect(X + 1, Y, 1, 1);
}

/** A tiny heart (5×4). */
export function drawHeart(c: Ctx, x: number, y: number, alpha = 1) {
  const X = Math.round(x), Y = Math.round(y);
  c.fillStyle = `rgba(226,84,110,${alpha})`;
  c.fillRect(X, Y, 2, 2); c.fillRect(X + 3, Y, 2, 2); c.fillRect(X, Y + 1, 5, 2); c.fillRect(X + 1, Y + 3, 3, 1); c.fillRect(X + 2, Y + 4, 1, 1);
  c.fillStyle = `rgba(255,190,200,${alpha})`;
  c.fillRect(X + 1, Y, 1, 1);
}
