// The office cat. Sleeps on the corridor bench, wakes, strolls, sits, strolls back. Purely a function of time.
import { oklch } from "../lib/color";
import type { OfficeLayout } from "./layout";

const WALK_A = [
  "........k.k",
  "........kkk",
  "k.......kek",
  ".k.kskskkkk",
  "..kkkkkkkk.",
  "..k.k..k.k.",
];
const WALK_B = [
  "........k.k",
  "........kkk",
  "k.......kek",
  ".k.kskskkkk",
  "..kkkkkkkk.",
  "...kk..kk..",
];
const SIT = [
  "......k.k..",
  "......kkk..",
  "......kek..",
  ".....kkkk..",
  "k...kskkk..",
  ".kkkkkkkk..",
];
const SLEEP = [
  "...........",
  "...........",
  "...kkkk....",
  "..kskskkk.k",
  ".kkkkkkkkk.",
  "..kkkkkkk..",
];

export function drawCat(c: CanvasRenderingContext2D, L: OfficeLayout, t: number, dark: boolean, still: boolean) {
  const bench = L.corridorItems.find((i) => i.kind === "bench");
  const home = bench ? { x: bench.rect.x + 8, y: bench.rect.y - 5 } : { x: L.corridor.x + 5, y: L.corridor.y + L.corridor.h - 30 };
  const walkY = bench ? bench.rect.y + 4 : home.y;
  const cycle = 34000;
  const k = still ? 0 : t % cycle;
  const n = Math.floor(t / cycle);
  const span = L.orientation === "landscape" ? [L.corridor.x + 30, L.corridor.x + L.corridor.w - 30] : [home.x, home.x];
  const target = span[0]! + (((n * 9301 + 49297) % 233280) / 233280) * (span[1]! - span[0]!);

  let x = home.x, y = home.y, pose = SLEEP, facing = 1;
  if (k < 16000) { pose = SLEEP; }
  else if (k < 17500) { pose = SIT; }
  else if (k < 25000) {
    const u = (k - 17500) / 7500;
    x = home.x + (target - home.x) * u; y = walkY; facing = target >= home.x ? 1 : -1;
    pose = Math.floor(k / 180) % 2 ? WALK_A : WALK_B;
  } else if (k < 28000) { x = target; y = walkY; pose = SIT; facing = target >= home.x ? -1 : 1; }
  else {
    const u = (k - 28000) / 6000;
    x = target + (home.x - target) * u; y = walkY; facing = home.x >= target ? 1 : -1;
    pose = Math.floor(k / 180) % 2 ? WALK_A : WALK_B;
    if (u > 0.9) { y = home.y; pose = SIT; }
  }
  if (L.orientation === "portrait" && pose !== SLEEP && pose !== SIT) { x = home.x; y = home.y; pose = SIT; }

  const fur = dark ? oklch(0.62, 0.11, 55) : oklch(0.7, 0.12, 55);
  const stripe = dark ? oklch(0.48, 0.1, 50) : oklch(0.55, 0.11, 50);
  const eye = oklch(0.25, 0.05, 270);
  const X = Math.round(x), Y = Math.round(y);
  c.fillStyle = "rgba(0,0,0,0.12)";
  c.fillRect(X + 2, Y + 6, 8, 1);
  pose.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx]!;
      if (ch === ".") continue;
      c.fillStyle = ch === "e" ? eye : ch === "s" ? stripe : fur;
      const px = facing === 1 ? rx : row.length - 1 - rx;
      c.fillRect(X + px, Y + ry, 1, 1);
    }
  });
  // a slow "z" above the sleeping cat
  if (pose === SLEEP && !still && Math.floor(t / 1200) % 3 === 0) {
    c.fillStyle = dark ? "rgba(255,255,255,0.55)" : "rgba(30,40,90,0.4)";
    c.fillRect(X + 9, Y - 1, 3, 1); c.fillRect(X + 10, Y, 1, 1); c.fillRect(X + 9, Y + 1, 3, 1);
  }
}
