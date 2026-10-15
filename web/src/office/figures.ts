// Drawing the office's moving parts: people away from their desks, the dogs and cats, and the little effects (the treat
// arcing across, hearts, "z z z"). Reads the simulation in life.ts; draws nothing itself that the sim has to know about.
import { drawFile } from "./draw";
import { type Fx, type Person, type Pet } from "./life";
import { CAT_H, CAT_W, DOG_H, DOG_W, drawCat, drawDog, drawHeart, drawTreat } from "./pets";
import type { OfficePalette } from "./palette";
import { spriteCanvas, walkerCanvas } from "./sprites";

type Ctx = CanvasRenderingContext2D;

const R = (c: Ctx, x: number, y: number, w: number, h: number, col: string) => { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), w, h); };

/** "z z z", drifting up and growing, in the colour of ink at low alpha. */
export function drawZzz(c: Ctx, x: number, y: number, t: number, still = false) {
  const phase = still ? 0.5 : (t / 1500) % 1;
  for (let i = 0; i < 3; i++) {
    const u = still ? 0.2 + i * 0.3 : (phase + i / 3) % 1;
    const s = 2 + Math.floor(u * 3);
    const a = still ? 0.7 : Math.sin(u * Math.PI) * 0.85;
    const zx = Math.round(x + u * 7 + i), zy = Math.round(y - u * 12);
    c.fillStyle = `rgba(60,72,150,${a})`;
    c.fillRect(zx, zy, s, 1); c.fillRect(zx + s - 1, zy + 1, 1, 1); c.fillRect(zx + Math.max(0, s - 2), zy + 2, 1, 1); c.fillRect(zx, zy + s - 1, s, 1);
  }
}

/** Draw one person who is not seated at their desk: walking, standing at something, or sitting somewhere else. */
export function drawPerson(c: Ctx, p: Person, t: number, rm: boolean, shirtGlow?: string) {
  void shirtGlow;
  const act = p.act;
  const hopping = !rm && t - p.jumpAt < 800;
  const hop = hopping ? Math.round(Math.abs(Math.sin(((t - p.jumpAt) / 800) * Math.PI * 2)) * 3) : 0;
  const happy = t < p.happyUntil;
  // soft shadow
  R(c, p.x - 5, p.y, 10, 1, "rgba(40,30,70,0.16)");

  if (act?.seated) {
    // sitting on a beanbag, a stool or a chair: the seated figure, facing the way the spot does
    const napping = act.kind === "nap" || p.sleepy;
    const dir = p.dir === "back" ? "back" : "front";
    const bob = napping && !rm ? (2 + (Math.floor(t / 900) % 2)) : rm ? 0 : Math.floor((t + p.nextAt) / 1100) % 2;
    const spr = spriteCanvas(p.id, { bob: Math.min(3, Math.max(0, bob)) as 0 | 1 | 2 | 3, eyes: napping ? "closed" : happy ? "happy" : "open", dir });
    c.drawImage(spr, Math.round(p.x - 8), Math.round(p.y - 17 - hop));
    drawProp(c, p, t, rm, true);
    if (napping) drawZzz(c, p.x + 5, p.y - 20, t, rm);
    return;
  }

  const moving = p.mode === "walk" && p.frame !== 0;
  const bob: 0 | 1 = moving && p.frame === 1 ? 1 : 0;
  const arms = act?.kind === "stretch" && !rm && Math.floor(t / 700) % 2 === 0 ? "up" : act?.kind === "stretch" ? "up" : undefined;
  const dir = p.dir;
  const spr = walkerCanvas(p.id, { dir, frame: p.mode === "walk" ? p.frame : 0, eyes: happy ? "happy" : "open", arms, bob });
  c.drawImage(spr, Math.round(p.x - 8), Math.round(p.y - 25 - hop));
  drawProp(c, p, t, rm, false);
}

function drawProp(c: Ctx, p: Person, t: number, rm: boolean, seated: boolean) {
  const a = p.act;
  if (!a) return;
  const right = p.dir === "right" || p.dir === "front";
  const hx = Math.round(p.x + (right ? 5 : -8)), hy = Math.round(p.y - (seated ? 7 : 13));
  switch (a.prop) {
    case "mug":
    case "tea": {
      const sip = !rm && Math.floor(t / 2600) % 3 === 2;
      const my = sip ? hy - 5 : hy;
      R(c, hx, my, 3, 3, a.prop === "tea" ? "#5FB3A8" : "#E8C6A0");
      R(c, hx, my, 3, 1, a.prop === "tea" ? "#8DD3C8" : "#FFF3E0");
      if (!rm && !sip) { c.fillStyle = "rgba(255,255,255,0.75)"; c.fillRect(hx + 1 + (Math.floor(t / 400) % 2), my - 2 - (Math.floor(t / 700) % 2), 1, 1); }
      break;
    }
    case "snack": R(c, hx, hy - 2, 2, 2, "#D9453B"); R(c, hx + 1, hy - 3, 1, 1, "#4E9A4E"); break;
    case "paddle": {
      const swing = rm ? 0 : Math.floor(t / 260 + p.nextAt) % 2;
      const px = Math.round(p.x + (p.dir === "left" ? -9 : 7));
      R(c, px, hy - 3 + swing * 2, 3, 3, "#D9453B"); R(c, px + 1, hy + swing * 2, 1, 2, "#8A5A32");
      break;
    }
    case "pad": R(c, Math.round(p.x - 3), Math.round(p.y - 9), 6, 2, "#2B2F4A"); R(c, Math.round(p.x - 2), Math.round(p.y - 9), 1, 1, "#E0707A"); R(c, Math.round(p.x + 1), Math.round(p.y - 9), 1, 1, "#7CC7FF"); break;
    case "can": {
      const tilt = !rm && Math.floor(t / 500) % 2;
      const cx = Math.round(p.x + 6);
      R(c, cx, hy - 2, 4, 3, "#5E8FB8"); R(c, cx + 4, hy - 3 + (tilt ? 1 : 0), 2, 1, "#5E8FB8"); R(c, cx + 1, hy - 4, 2, 1, "#5E8FB8");
      if (tilt) { c.fillStyle = "rgba(140,200,255,0.9)"; c.fillRect(cx + 6, hy + 0, 1, 2); c.fillRect(cx + 7, hy + 3, 1, 2); }
      break;
    }
    default: break;
  }
}

/** A dog or a cat, standing, sitting, lying down or carrying the gold file. */
export function drawPet(c: Ctx, p: Pet, t: number, rm: boolean, pal: OfficePalette) {
  const pose = p.mode === "sleep" ? "lie" : p.mode === "sit" || p.mode === "treat" || p.mode === "idle" ? "sit" : p.carrying ? "carry" : "walk";
  const frame = rm ? 0 : p.frame;
  if (p.kind === "dog") {
    const x = p.x - DOG_W / 2, y = p.y - DOG_H + 1;
    const breathe = p.mode === "sleep" && !rm && Math.floor(t / 1300) % 2 ? 0 : 0;
    drawDog(c, p.id, pose === "carry" ? "walk" : pose, frame, x, y + breathe, p.facing, { panting: p.panting });
    if (p.carrying) {
      // the gold file in the dog's mouth
      const mx = p.facing === "right" ? x + DOG_W - 1 : x + 1;
      drawFile(c, mx + (p.facing === "right" ? 1 : -1), y + 8 + (frame % 2), pal, "handoff");
    }
    if (p.mode === "sleep") drawZzz(c, p.x + (p.facing === "right" ? 6 : -9), y - 1, t + p.nextAt, rm);
  } else {
    const x = p.x - CAT_W / 2, y = p.y - CAT_H + 1;
    drawCat(c, p.id, pose === "carry" ? "walk" : pose, frame, x, y, p.facing);
    if (p.mode === "sleep") drawZzz(c, p.x + 3, y - 2, t + p.nextAt, rm);
  }
}

/** The treat arcing from a hand to a dog, and the hearts that follow. */
export function drawFx(c: Ctx, f: Fx, now: number) {
  const u = (now - f.t0) / f.dur;
  if (u < 0 || u > 1) return;
  if (f.kind === "treat") {
    const x = f.x + (f.toX - f.x) * u;
    const y = f.y + (f.toY - f.y) * u - Math.sin(u * Math.PI) * 9;
    drawTreat(c, x - 2, y);
  } else {
    drawHeart(c, f.x + Math.sin(u * 6) * 1.5, f.y - u * 12, 1 - u * u);
  }
}
