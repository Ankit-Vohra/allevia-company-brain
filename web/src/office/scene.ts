// The office's static scene: the open floor, the back wall, the walkways, the coloured rugs, the furniture of the
// cafeteria and the game room. Drawn once per layout into a cached canvas; everything that moves or changes with the
// hour (sky in the windows, lamps, screens, people, pets) is drawn per frame over it.
import { oklch } from "../lib/color";
import { R, P, box, drawFloorItem, drawWallItem } from "./draw";
import type { FloorKind, Item, OfficeLayout, Rect, RoomLayout } from "./layout";
import { FACE, WALL } from "./layout";
import type { OfficePalette } from "./palette";

type Ctx = CanvasRenderingContext2D;

const hash = (a: number, b = 0) => {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const FLAT: FloorKind[] = ["rug", "mat", "carpet", "tiles", "dogbed", "catbed"];

export function drawStatic(c: Ctx, L: OfficeLayout, pal: OfficePalette) {
  R(c, 0, 0, L.w, L.h, pal.wallCap);
  drawPlanks(c, L.floor, pal);
  drawBackWall(c, L, pal);

  // the shared corners' own floors, then each team's rug
  for (const room of L.rooms) for (const it of room.floor) if (it.kind === "tiles") drawTiles(c, it.rect, pal);
  for (const room of L.rooms) for (const it of room.floor) if (it.kind === "carpet") drawCarpet(c, it.rect, pal, room.dept.hue);
  drawWalkways(c, L, pal);
  for (const room of L.rooms) {
    for (const it of room.floor) {
      if (it.kind === "mat") drawRugTinted(c, it.rect, pal, room.dept.hue);
      if (it.kind === "rug") drawRugGold(c, it.rect, pal);
    }
  }
  for (const room of L.rooms) for (const it of room.floor) if (it.kind === "dogbed" || it.kind === "catbed") drawBed(c, it, pal);
  for (const room of L.rooms) drawSignCords(c, room, pal);

  // entrance: a gap in the outer wall with a doormat
  const en = L.entrance;
  R(c, en.x, en.y, en.w, en.h, pal.lane);
  if (L.orientation === "landscape") {
    R(c, en.x + WALL + 1, en.y + 2, 6, en.h - 4, pal.woodDark);
    R(c, en.x + WALL + 2, en.y + 3, 4, en.h - 6, pal.wood);
    R(c, en.x, en.y - 1, WALL, 1, pal.ink2); R(c, en.x, en.y + en.h, WALL, 1, pal.ink2);
  } else {
    R(c, en.x + 2, en.y - 7, en.w - 4, 6, pal.woodDark);
    R(c, en.x + 3, en.y - 6, en.w - 6, 4, pal.wood);
    R(c, en.x - 1, en.y, 1, WALL, pal.ink2); R(c, en.x + en.w, en.y, 1, WALL, pal.ink2);
  }

  // furniture and boards, back to front so a taller thing in front covers what is behind it
  type Solid = { y: number; draw: () => void };
  const solids: Solid[] = [];
  for (const room of L.rooms) {
    for (const it of room.floor) {
      if (FLAT.includes(it.kind)) continue;
      solids.push({ y: it.rect.y + it.rect.h, draw: () => drawSolid(c, it, pal) });
    }
    for (const it of room.wall) {
      solids.push({ y: it.rect.y + it.rect.h, draw: () => { drawWallItem(c, it, pal); drawLegs(c, it.rect, pal); } });
    }
  }
  for (const it of L.corridorItems) solids.push({ y: it.rect.y + it.rect.h, draw: () => drawSolid(c, it, pal) });
  solids.sort((a, b) => a.y - b.y).forEach((s) => s.draw());
}

function drawPlanks(c: Ctx, f: Rect, pal: OfficePalette) {
  R(c, f.x, f.y, f.w, f.h, pal.plank);
  const ph = 6;
  for (let row = 0, y = f.y; y < f.y + f.h; y += ph, row++) {
    const h = Math.min(ph, f.y + f.h - y);
    // planks run the width of the room in lengths of 40–80px, a slightly different tone each
    let x = f.x - Math.floor(hash(row, 7) * 48);
    let k = 0;
    while (x < f.x + f.w) {
      const len = 40 + Math.floor(hash(row, k + 11) * 40);
      const x0 = Math.max(f.x, x), x1 = Math.min(f.x + f.w, x + len);
      if (x1 > x0 && hash(row, k + 3) > 0.62) R(c, x0, y, x1 - x0, h, pal.plankAlt);
      if (x >= f.x) R(c, x, y, 1, h, pal.plankLine);
      x += len;
      k++;
    }
    R(c, f.x, y, f.w, 1, pal.plankLine);
  }
}

function drawBackWall(c: Ctx, L: OfficeLayout, pal: OfficePalette) {
  const f = L.topWall;
  R(c, f.x, f.y, f.w, f.h, pal.wallFace);
  R(c, f.x, f.y + f.h - 2, f.w, 1, pal.wallFaceLine);
  R(c, f.x, f.y + f.h - 1, f.w, 1, pal.woodDark);
  for (const win of L.windows) {
    const r = win.rect;
    R(c, r.x - 1, r.y - 1, r.w + 2, r.h + 2, pal.ink2);
    R(c, r.x + Math.floor(r.w / 2), r.y, 1, r.h, pal.ink2);
    R(c, r.x - 2, r.y + r.h + 1, r.w + 4, 1, pal.metalDark); // sill
  }
  for (const it of L.backWall) drawWallItem(c, it, pal);
  // the wall's shadow on the floor under it
  R(c, f.x, f.y + f.h, f.w, 2, pal.wallShadow);
}

function drawWalkways(c: Ctx, L: OfficeLayout, pal: OfficePalette) {
  for (const w of L.walkways) {
    R(c, w.x, w.y, w.w, w.h, pal.lane);
    if (w.w > w.h) {
      R(c, w.x, w.y, w.w, 1, pal.laneEdge); R(c, w.x, w.y + w.h - 1, w.w, 1, pal.laneEdge);
      for (let x = w.x + 6; x < w.x + w.w - 6; x += 10) R(c, x, w.y + Math.floor(w.h / 2), 5, 1, pal.laneDash);
    } else {
      R(c, w.x, w.y, 1, w.h, pal.laneEdge); R(c, w.x + w.w - 1, w.y, 1, w.h, pal.laneEdge);
      for (let y = w.y + 6; y < w.y + w.h - 6; y += 10) R(c, w.x + Math.floor(w.w / 2), y, 1, 5, pal.laneDash);
    }
  }
}

function drawTiles(c: Ctx, r: Rect, pal: OfficePalette) {
  for (let y = 0; y < r.h; y += 4) for (let x = 0; x < r.w; x += 4) R(c, r.x + x, r.y + y, Math.min(4, r.w - x), Math.min(4, r.h - y), ((x + y) / 4) % 2 ? pal.tileB : pal.tileA);
  R(c, r.x, r.y, r.w, 1, pal.laneEdge); R(c, r.x, r.y + r.h - 1, r.w, 1, pal.laneEdge);
}

function drawCarpet(c: Ctx, r: Rect, pal: OfficePalette, hue: number) {
  R(c, r.x, r.y, r.w, r.h, pal.carpet(hue));
  R(c, r.x, r.y, r.w, 1, pal.rugEdge(hue)); R(c, r.x, r.y + r.h - 1, r.w, 1, pal.rugEdge(hue));
  R(c, r.x, r.y, 1, r.h, pal.rugEdge(hue)); R(c, r.x + r.w - 1, r.y, 1, r.h, pal.rugEdge(hue));
  for (let y = r.y + 3; y < r.y + r.h - 3; y += 4) for (let x = r.x + 3 + ((y / 4) % 2) * 2; x < r.x + r.w - 3; x += 4) P(c, x, y, pal.rugFill(hue));
}

function drawRugTinted(c: Ctx, r: Rect, pal: OfficePalette, hue: number) {
  const edge = pal.rugEdge(hue), fill = pal.rugFill(hue);
  R(c, r.x + 1, r.y, r.w - 2, r.h, edge);
  R(c, r.x, r.y + 1, r.w, r.h - 2, edge);
  R(c, r.x + 1, r.y + 1, r.w - 2, r.h - 2, fill);
  // a border stripe and a fringe, so it reads as a rug and not as a patch of floor
  R(c, r.x + 3, r.y + 3, r.w - 6, 1, edge);
  R(c, r.x + 3, r.y + r.h - 4, r.w - 6, 1, edge);
  for (let y = r.y + 3; y < r.y + r.h - 3; y += 2) { P(c, r.x - 1, y, edge); P(c, r.x + r.w, y, edge); }
}

function drawRugGold(c: Ctx, r: Rect, pal: OfficePalette) {
  R(c, r.x, r.y, r.w, r.h, pal.rug);
  R(c, r.x + 1, r.y + 1, r.w - 2, 1, pal.gold);
  R(c, r.x + 1, r.y + r.h - 2, r.w - 2, 1, pal.gold);
  R(c, r.x + 1, r.y + 1, 1, r.h - 2, pal.gold);
  R(c, r.x + r.w - 2, r.y + 1, 1, r.h - 2, pal.gold);
  for (let x = r.x + 4; x < r.x + r.w - 4; x += 4) P(c, x, r.y + Math.floor(r.h / 2), pal.goldDark);
}

function drawBed(c: Ctx, it: Item<FloorKind>, _pal: OfficePalette) {
  const r = it.rect;
  const rim = oklch(0.6, 0.08, 55), inner = oklch(0.84, 0.07, 75), pillow = oklch(0.7, 0.1, 25);
  if (it.kind === "dogbed") {
    R(c, r.x + 2, r.y, r.w - 4, r.h, rim); R(c, r.x, r.y + 1, r.w, r.h - 2, rim);
    R(c, r.x + 3, r.y + 1, r.w - 6, r.h - 3, inner); R(c, r.x + 1, r.y + 2, r.w - 2, r.h - 5, inner);
    R(c, r.x + 3, r.y + 2, 4, 2, pillow);
  } else {
    R(c, r.x + 1, r.y, r.w - 2, r.h, rim); R(c, r.x, r.y + 1, r.w, r.h - 2, rim);
    R(c, r.x + 2, r.y + 1, r.w - 4, r.h - 3, oklch(0.9, 0.05, 90));
  }
}

function drawSignCords(c: Ctx, room: RoomLayout, pal: OfficePalette) {
  const hw = Math.round(room.dept.name.length * 1.7 + 5);
  const x = Math.round(room.sign.x), top = room.rect.y, y = Math.round(room.sign.y) - 3;
  const n = Math.max(1, y - top);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    P(c, Math.round(x - hw * u), top + i, pal.metalDark);
    P(c, Math.round(x + hw * u), top + i, pal.metalDark);
  }
  P(c, x, top - 1 < 0 ? 0 : top - 1, pal.gold);
}

function drawLegs(c: Ctx, r: Rect, pal: OfficePalette) {
  R(c, r.x + 2, r.y + r.h, 1, 2, pal.metalDark);
  R(c, r.x + r.w - 3, r.y + r.h, 1, 2, pal.metalDark);
}

function drawSolid(c: Ctx, it: Item<FloorKind>, pal: OfficePalette) {
  switch (it.kind) {
    case "lowshelf": return lowShelf(c, it.rect, pal);
    case "counter": return counter(c, it.rect, pal);
    case "fridge": return fridge(c, it.rect, pal);
    case "cafe-table": return cafeTable(c, it.rect, pal);
    case "pingpong": return pingPong(c, it.rect, pal);
    case "console": return consoleStand(c, it.rect, pal);
    case "beanbag": return beanbag(c, it.rect, pal, it.n ?? 0);
    case "board-table": return boardTable(c, it.rect, pal);
    default: return drawFloorItem(c, it, pal);
  }
}

function lowShelf(c: Ctx, r: Rect, pal: OfficePalette) {
  const vertical = r.h > r.w;
  box(c, r, pal.woodDark, pal.ink2);
  const books = [oklch(0.55, 0.11, 25), oklch(0.5, 0.09, 250), oklch(0.65, 0.11, 85), oklch(0.55, 0.08, 160)];
  if (vertical) {
    R(c, r.x + 1, r.y + 1, r.w - 2, 3, pal.wood);
    for (let y = r.y + 5, k = 0; y < r.y + r.h - 2; y += 3, k++) { R(c, r.x + 1, y, r.w - 2, 2, books[k % books.length]!); }
  } else {
    R(c, r.x + 1, r.y + 1, r.w - 2, 2, pal.wood);
    for (let x = r.x + 2, k = 0; x < r.x + r.w - 2; x += 3, k++) R(c, x, r.y + 3, 2, r.h - 4, books[k % books.length]!);
  }
  R(c, r.x + 1, r.y + r.h, r.w - 1, 1, pal.wallShadow);
}

function counter(c: Ctx, r: Rect, pal: OfficePalette) {
  // front face and the worktop
  R(c, r.x, r.y, r.w, r.h, pal.ink2);
  R(c, r.x + 1, r.y + 1, r.w - 2, 5, pal.paper);
  R(c, r.x + 1, r.y + 6, r.w - 2, r.h - 7, pal.wood);
  for (let x = r.x + 10; x < r.x + r.w - 2; x += 14) R(c, x, r.y + 7, 1, r.h - 8, pal.woodDark);
  R(c, r.x + 1, r.y + r.h, r.w - 1, 1, pal.wallShadow);
  // coffee machine
  const mx = r.x + 5;
  R(c, mx, r.y - 7, 11, 9, pal.ink2);
  R(c, mx + 1, r.y - 6, 9, 3, oklch(0.55, 0.02, 265));
  R(c, mx + 1, r.y - 2, 9, 3, pal.screenOff);
  R(c, mx + 3, r.y, 5, 1, pal.paper);
  P(c, mx + 8, r.y - 5, pal.bad); P(c, mx + 8, r.y - 4, pal.ok);
  R(c, mx + 4, r.y + 1, 3, 2, pal.paper); // the cup under the spout
  // kettle
  const kx = r.x + 22;
  R(c, kx, r.y - 5, 6, 6, oklch(0.62, 0.06, 200));
  R(c, kx + 1, r.y - 6, 4, 1, pal.ink2);
  R(c, kx + 6, r.y - 4, 2, 1, oklch(0.62, 0.06, 200)); P(c, kx + 8, r.y - 5, oklch(0.62, 0.06, 200));
  // mugs, a fruit bowl, a tea tin
  R(c, r.x + 34, r.y - 2, 3, 3, oklch(0.7, 0.13, 25)); R(c, r.x + 38, r.y - 2, 3, 3, oklch(0.72, 0.1, 190));
  R(c, r.x + 46, r.y - 1, 9, 2, pal.woodDark);
  R(c, r.x + 47, r.y - 3, 3, 2, oklch(0.72, 0.16, 55)); R(c, r.x + 50, r.y - 3, 3, 2, oklch(0.62, 0.17, 27));
  R(c, r.x + 57, r.y - 3, 4, 4, pal.gold); P(c, r.x + 58, r.y - 2, pal.goldDark);
}

function fridge(c: Ctx, r: Rect, pal: OfficePalette) {
  box(c, r, pal.paper, pal.ink2);
  R(c, r.x + 1, r.y + 9, r.w - 2, 1, pal.metalDark);
  R(c, r.x + r.w - 4, r.y + 3, 1, 4, pal.metalDark);
  R(c, r.x + r.w - 4, r.y + 12, 1, 7, pal.metalDark);
  R(c, r.x + 3, r.y + 13, 2, 2, pal.bad); R(c, r.x + 6, r.y + 16, 2, 2, oklch(0.72, 0.12, 230)); R(c, r.x + 3, r.y + 19, 3, 2, pal.gold);
  R(c, r.x + 1, r.y + r.h, r.w - 1, 1, pal.wallShadow);
}

function cafeTable(c: Ctx, r: Rect, pal: OfficePalette) {
  const stool = oklch(0.62, 0.12, 25);
  for (const sx of [r.x - 6, r.x + r.w + 2]) { R(c, sx, r.y + 6, 4, 3, stool); R(c, sx + 1, r.y + 9, 2, 3, pal.ink2); }
  // pedestal and the round top
  R(c, r.x + 6, r.y + 5, 2, 5, pal.ink2); R(c, r.x + 4, r.y + 10, 6, 1, pal.ink2);
  R(c, r.x + 3, r.y, r.w - 6, 1, pal.ink2);
  R(c, r.x + 1, r.y + 1, r.w - 2, 4, pal.ink2);
  R(c, r.x + 2, r.y + 1, r.w - 4, 3, pal.paper);
  R(c, r.x + 3, r.y + 4, r.w - 6, 1, pal.woodDark);
  R(c, r.x + 5, r.y + 1, 2, 2, oklch(0.7, 0.13, 25)); P(c, r.x + 9, r.y + 2, pal.goldDark);
}

function pingPong(c: Ctx, r: Rect, pal: OfficePalette) {
  const green = oklch(0.5, 0.1, 165), line = oklch(0.95, 0.01, 90);
  R(c, r.x + 2, r.y + 12, 2, r.h - 12, pal.ink2); R(c, r.x + r.w - 4, r.y + 12, 2, r.h - 12, pal.ink2);
  R(c, r.x, r.y, r.w, 13, pal.ink2);
  R(c, r.x + 1, r.y + 1, r.w - 2, 10, green);
  R(c, r.x + 1, r.y + 11, r.w - 2, 1, oklch(0.4, 0.09, 165));
  R(c, r.x + 2, r.y + 2, r.w - 4, 1, line); R(c, r.x + 2, r.y + 9, r.w - 4, 1, line);
  R(c, r.x + 2, r.y + 2, 1, 8, line); R(c, r.x + r.w - 3, r.y + 2, 1, 8, line);
  R(c, r.x + 3, r.y + 5, r.w - 6, 1, oklch(0.62, 0.08, 165));
  // the net
  R(c, r.x + Math.floor(r.w / 2), r.y - 2, 1, 14, line);
  for (let y = r.y - 1; y < r.y + 11; y += 2) P(c, r.x + Math.floor(r.w / 2) - 1, y, pal.metalDark);
}

function consoleStand(c: Ctx, r: Rect, pal: OfficePalette) {
  box(c, r, pal.wood, pal.ink2);
  R(c, r.x + 3, r.y + 1, 9, 3, pal.ink);
  P(c, r.x + 10, r.y + 2, pal.ok);
  R(c, r.x + 15, r.y + 2, 3, 2, oklch(0.62, 0.15, 25)); R(c, r.x + 19, r.y + 2, 3, 2, oklch(0.62, 0.12, 230));
}

function beanbag(c: Ctx, r: Rect, _pal: OfficePalette, n: number) {
  const hues: [number, number][] = [[0.7, 25], [0.68, 190], [0.78, 85]];
  const [l, h] = hues[n % hues.length]!;
  const body = oklch(l, 0.13, h), dark = oklch(l - 0.14, 0.12, h), light = oklch(l + 0.1, 0.1, h);
  R(c, r.x + 3, r.y, r.w - 6, 1, dark);
  R(c, r.x + 1, r.y + 1, r.w - 2, 1, body);
  R(c, r.x, r.y + 2, r.w, 5, body);
  R(c, r.x + 1, r.y + 7, r.w - 2, 1, dark);
  R(c, r.x + 3, r.y + 8, r.w - 6, 1, dark);
  R(c, r.x + 2, r.y + 2, 4, 1, light); P(c, r.x + 2, r.y + 3, light);
  R(c, r.x + r.w - 2, r.y + 3, 1, 4, dark);
  P(c, r.x + Math.floor(r.w / 2), r.y + 1, dark);
}

function boardTable(c: Ctx, r: Rect, pal: OfficePalette) {
  R(c, r.x + 2, r.y + 6, 1, r.h - 6, pal.ink2); R(c, r.x + r.w - 3, r.y + 6, 1, r.h - 6, pal.ink2);
  box(c, { x: r.x, y: r.y, w: r.w, h: 7 }, pal.wood, pal.ink2);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) R(c, r.x + 4 + x * 1.3, r.y + 1 + y, 1, 1, (x + y) % 2 ? pal.paper : pal.ink2);
  P(c, r.x + 6, r.y + 2, pal.bad); P(c, r.x + 9, r.y + 3, oklch(0.62, 0.12, 230));
}

// ---------------------------------------------------------------- per-frame pieces that depend on the hour

const SKY: { at: number; top: [number, number, number]; bot: [number, number, number]; stars: number }[] = [
  { at: 0, top: [14, 18, 52], bot: [30, 38, 86], stars: 1 },
  { at: 330, top: [34, 40, 90], bot: [120, 96, 140], stars: 0.5 },
  { at: 390, top: [120, 150, 210], bot: [255, 176, 120], stars: 0 },
  { at: 480, top: [120, 180, 240], bot: [190, 225, 250], stars: 0 },
  { at: 750, top: [100, 170, 245], bot: [170, 215, 250], stars: 0 },
  { at: 1005, top: [120, 170, 235], bot: [255, 215, 150], stars: 0 },
  { at: 1080, top: [140, 120, 190], bot: [255, 150, 100], stars: 0 },
  { at: 1140, top: [60, 60, 130], bot: [200, 100, 120], stars: 0.2 },
  { at: 1230, top: [24, 28, 78], bot: [60, 56, 120], stars: 0.7 },
  { at: 1320, top: [14, 18, 52], bot: [30, 38, 86], stars: 1 },
  { at: 1440, top: [14, 18, 52], bot: [30, 38, 86], stars: 1 },
];

export function skyAt(min: number) {
  const m = ((min % 1440) + 1440) % 1440;
  let i = 0;
  while (i < SKY.length - 2 && SKY[i + 1]!.at <= m) i++;
  const a = SKY[i]!, b = SKY[i + 1]!;
  const t = Math.min(1, Math.max(0, (m - a.at) / (b.at - a.at)));
  const mixc = (x: number[], y: number[]) => `rgb(${Math.round(x[0]! + (y[0]! - x[0]!) * t)},${Math.round(x[1]! + (y[1]! - x[1]!) * t)},${Math.round(x[2]! + (y[2]! - x[2]!) * t)})`;
  return { top: mixc(a.top, b.top), bot: mixc(a.bot, b.bot), stars: a.stars + (b.stars - a.stars) * t, m };
}

/** The sky in each window: day blue with a few clouds, the sun low and gold at the ends of the day, the moon and stars at night. */
export function drawWindows(c: Ctx, L: OfficeLayout, min: number) {
  const sky = skyAt(min);
  for (const win of L.windows) {
    const r = win.rect;
    const half = Math.floor(r.w / 2);
    for (const [x0, w] of [[r.x, half], [r.x + half + 1, r.w - half - 1]] as const) {
      R(c, x0, r.y, w, Math.ceil(r.h / 2), sky.top);
      R(c, x0, r.y + Math.ceil(r.h / 2), w, Math.floor(r.h / 2), sky.bot);
    }
    const m = sky.m;
    if (sky.stars > 0.15) {
      c.fillStyle = `rgba(255,250,220,${Math.min(1, sky.stars)})`;
      for (const [dx, dy] of [[3, 1], [8, 4], [15, 2], [19, 5], [21, 1]] as const) c.fillRect(r.x + dx, r.y + dy, 1, 1);
    }
    if (m >= 330 && m <= 1140) {
      const u = (m - 330) / 810;
      const sx = Math.round(r.x + 2 + u * (r.w - 6));
      const sy = Math.round(r.y + 1 + (1 - Math.sin(u * Math.PI)) * (r.h - 5));
      R(c, sx, sy, 3, 3, m < 480 || m > 1000 ? "#FFB066" : "#FFF1B0");
    } else if (sky.stars > 0.4) {
      const mx = r.x + 5 + ((r.x * 7) % 9);
      R(c, mx, r.y + 2, 3, 3, "#F4F0DC"); P(c, mx + 1, r.y + 2, sky.top);
    }
    if (m > 420 && m < 1050) { c.fillStyle = "rgba(255,255,255,0.9)"; c.fillRect(r.x + 2, r.y + 4, 5, 1); c.fillRect(r.x + 3, r.y + 3, 3, 1); c.fillRect(r.x + 14, r.y + 6, 6, 1); c.fillRect(r.x + 16, r.y + 5, 3, 1); }
    R(c, r.x + half, r.y, 1, r.h, "#3F4670");
  }
}

/** The TV in the game room: a game while someone plays, a slow screensaver otherwise. */
export function drawTv(c: Ctx, r: Rect, pal: OfficePalette, playing: boolean, t: number) {
  const ix = r.x + 1, iy = r.y + 1, iw = r.w - 2, ih = r.h - 2;
  R(c, ix, iy, iw, ih, pal.ink);
  if (!playing) {
    const x = ix + 2 + Math.floor(((t / 90) % (iw - 8)));
    R(c, x, iy + 3, 5, 2, pal.screenGlow);
    return;
  }
  R(c, ix, iy, iw, ih, oklch(0.45, 0.09, 250));
  R(c, ix, iy + ih - 3, iw, 3, oklch(0.5, 0.1, 150)); // the ground
  const hop = Math.abs(Math.sin(t / 220)) * 4;
  R(c, ix + 5, Math.round(iy + ih - 6 - hop), 3, 3, pal.bad);
  const ox = ix + iw - ((Math.floor(t / 60) % (iw + 6)));
  R(c, ox, iy + ih - 6, 2, 3, pal.gold);
  R(c, ix + 2, iy + 1, 6, 1, pal.paper);
}

/** The tech wall's status board: a row of lights, all green. */
export function drawStatus(c: Ctx, r: Rect, pal: OfficePalette, t: number, busy: boolean) {
  R(c, r.x + 1, r.y + 1, r.w - 2, r.h - 2, pal.screen);
  for (let i = 0; i < 4; i++) {
    const warn = busy && i === 2 && Math.floor(t / 400) % 2 === 0;
    R(c, r.x + 3 + i * 3, r.y + 3, 2, 2, warn ? pal.warn : pal.ok);
    R(c, r.x + 3 + i * 3, r.y + 6, 2, 1, pal.screenGlow);
  }
}

export { FACE };
