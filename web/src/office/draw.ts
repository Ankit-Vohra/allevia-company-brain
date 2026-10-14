// Pixel drawing for the office: the static floor plan (floors, walls, wall-hung things, furniture) and the per-frame
// pieces (desks, screens, whiteboard, notes, flying files). Everything is fillRect on integer logical pixels.
import { DEPARTMENTS } from "@shared/roster";
import { oklch, withAlpha } from "../lib/color";
import { type DeskSpot, FACE, type FloorKind, type Item, type OfficeLayout, type Rect, type RoomLayout, WALL, type WallKind } from "./layout";
import type { OfficePalette } from "./palette";

type Ctx = CanvasRenderingContext2D;

export const R = (c: Ctx, x: number, y: number, w: number, h: number, col: string) => {
  c.fillStyle = col;
  c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};
const P = (c: Ctx, x: number, y: number, col: string) => R(c, x, y, 1, 1, col);
const box = (c: Ctx, r: Rect, fill: string, edge: string) => {
  R(c, r.x, r.y, r.w, r.h, edge);
  R(c, r.x + 1, r.y + 1, r.w - 2, r.h - 2, fill);
};

const hueOf = (dept: string) => DEPARTMENTS.find((d) => d.id === dept)?.hue ?? 265;

// ---------------------------------------------------------------- static layer

export function drawStatic(c: Ctx, L: OfficeLayout, pal: OfficePalette) {
  R(c, 0, 0, L.w, L.h, pal.bg);

  // corridor: ledger paper, ruled, with a margin line
  const cr = L.corridor;
  R(c, cr.x, cr.y, cr.w, cr.h, pal.corridor);
  if (L.orientation === "landscape") {
    for (let y = cr.y + 5; y < cr.y + cr.h; y += 7) R(c, cr.x, y, cr.w, 1, pal.corridorRule);
    R(c, cr.x + 14, cr.y, 1, cr.h, pal.corridorMargin);
    R(c, cr.x + 16, cr.y, 1, cr.h, pal.corridorMargin);
  } else {
    for (let y = cr.y + 5; y < cr.y + cr.h; y += 7) R(c, cr.x, y, cr.w, 1, pal.corridorRule);
  }

  for (const room of L.rooms) drawRoomFloor(c, room, pal);
  for (const room of L.rooms) {
    for (const it of room.floor) {
      if (it.kind === "rug") drawRug(c, it.rect, pal);
      if (it.kind === "mat") {
        R(c, it.rect.x, it.rect.y, it.rect.w, it.rect.h, pal.roomEdge(room.dept.hue));
        R(c, it.rect.x + 1, it.rect.y + 1, it.rect.w - 2, it.rect.h - 2, pal.floorAlt(room.dept.hue));
      }
    }
  }
  for (const room of L.rooms) drawWalls(c, room, pal);
  // entrance: a gap in the outer wall, door frame and a coir doormat
  const en = L.entrance;
  R(c, en.x, en.y, en.w, en.h, pal.corridor);
  const mat = L.orientation === "landscape" ? { x: en.x + WALL + 1, y: en.y + 2, w: 6, h: en.h - 4 } : { x: en.x + 2, y: en.y - 7, w: en.w - 4, h: 6 };
  R(c, mat.x, mat.y, mat.w, mat.h, pal.woodDark);
  R(c, mat.x + 1, mat.y + 1, mat.w - 2, mat.h - 2, pal.wood);
  if (L.orientation === "landscape") {
    R(c, en.x, en.y - 1, WALL, 1, pal.ink2); R(c, en.x, en.y + en.h, WALL, 1, pal.ink2);
    for (let y = mat.y + 2; y < mat.y + mat.h - 1; y += 2) R(c, mat.x + 1, y, mat.w - 2, 1, pal.woodDark);
  } else {
    R(c, en.x - 1, en.y, 1, WALL, pal.ink2); R(c, en.x + en.w, en.y, 1, WALL, pal.ink2);
    for (let x = mat.x + 2; x < mat.x + mat.w - 1; x += 2) R(c, x, mat.y + 1, 1, mat.h - 2, pal.woodDark);
  }

  for (const room of L.rooms) {
    for (const it of room.wall) drawWallItem(c, it, pal);
    for (const it of room.floor) if (it.kind !== "rug" && it.kind !== "mat") drawFloorItem(c, it, pal);
  }
  for (const it of L.corridorItems) drawFloorItem(c, it, pal);
}

function drawRoomFloor(c: Ctx, room: RoomLayout, pal: OfficePalette) {
  const h = room.dept.hue;
  const r = room.inner;
  R(c, r.x, r.y, r.w, r.h, pal.floor(h));
  // graph-paper floor: a faint grid every 8px
  for (let x = r.x + 7; x < r.x + r.w; x += 8) R(c, x, r.y, 1, r.h, pal.floorAlt(h));
  for (let y = r.y + 7; y < r.y + r.h; y += 8) R(c, r.x, y, r.w, 1, pal.floorAlt(h));
  // soft shadow under the top wall
  R(c, r.x, r.y, r.w, 2, pal.wallShadow);
}

function drawWalls(c: Ctx, room: RoomLayout, pal: OfficePalette) {
  const { rect, inner, face, door } = room;
  const cap = pal.wallCap;
  // caps: everything between rect and the floor/face is wall seen from above
  R(c, rect.x, rect.y, rect.w, face.y - rect.y, cap);                                   // top cap
  R(c, rect.x, rect.y, inner.x - rect.x, rect.h, cap);                                  // left
  R(c, inner.x + inner.w, rect.y, rect.x + rect.w - inner.x - inner.w, rect.h, cap);    // right
  R(c, rect.x, inner.y + inner.h, rect.w, rect.y + rect.h - inner.y - inner.h, cap);    // bottom
  // face of the top wall, with a skirting line and a dado rail in the room's tint
  R(c, face.x, face.y, face.w, face.h, pal.wallFace);
  R(c, face.x, face.y + face.h - 2, face.w, 1, pal.wallFaceLine);
  R(c, face.x, face.y + face.h - 1, face.w, 1, pal.roomEdge(room.dept.hue));
  // door gaps
  const floor = pal.floor(room.dept.hue);
  if (door.side === "bottom") {
    R(c, door.at, inner.y + inner.h, door.w, rect.y + rect.h - inner.y - inner.h, floor);
    R(c, door.at - 1, inner.y + inner.h, 1, rect.y + rect.h - inner.y - inner.h, pal.ink2);
    R(c, door.at + door.w, inner.y + inner.h, 1, rect.y + rect.h - inner.y - inner.h, pal.ink2);
  } else if (door.side === "top") {
    R(c, door.at, rect.y, door.w, face.y + face.h - rect.y, floor);
    R(c, door.at - 1, rect.y, 1, face.y + face.h - rect.y, pal.ink2);
    R(c, door.at + door.w, rect.y, 1, face.y + face.h - rect.y, pal.ink2);
    // the door itself, swung open against the wall face
    R(c, door.at + door.w + 1, face.y, 2, face.h, pal.woodDark);
  } else {
    const x0 = door.side === "right" ? inner.x + inner.w : rect.x;
    const ww = door.side === "right" ? rect.x + rect.w - inner.x - inner.w : inner.x - rect.x;
    R(c, x0, door.at, ww, door.w, floor);
    R(c, x0, door.at - 1, ww, 1, pal.ink2);
    R(c, x0, door.at + door.w, ww, 1, pal.ink2);
  }
}

function drawRug(c: Ctx, r: Rect, pal: OfficePalette) {
  R(c, r.x, r.y, r.w, r.h, pal.rug);
  R(c, r.x + 1, r.y + 1, r.w - 2, 1, pal.gold);
  R(c, r.x + 1, r.y + r.h - 2, r.w - 2, 1, pal.gold);
  R(c, r.x + 1, r.y + 1, 1, r.h - 2, pal.gold);
  R(c, r.x + r.w - 2, r.y + 1, 1, r.h - 2, pal.gold);
  for (let x = r.x + 4; x < r.x + r.w - 4; x += 4) P(c, x, r.y + Math.floor(r.h / 2), pal.goldDark);
}

function drawWallItem(c: Ctx, it: Item<WallKind>, pal: OfficePalette) {
  const r = it.rect;
  switch (it.kind) {
    case "whiteboard":
      box(c, r, pal.paper, pal.metalDark);
      R(c, r.x + 2, r.y + r.h - 1, r.w - 4, 1, pal.metal); // tray
      break;
    case "chart":
      box(c, r, pal.paper, pal.ink2);
      R(c, r.x + 3, r.y + 6, 2, 3, pal.ink2);
      R(c, r.x + 7, r.y + 4, 2, 5, pal.ink2);
      R(c, r.x + 11, r.y + 5, 2, 4, pal.ink2);
      R(c, r.x + 15, r.y + 2, 2, 7, pal.gold);
      break;
    case "screen-dash":
    case "screen-code":
      box(c, r, pal.screenOff, pal.ink);
      break;
    case "pinboard":
      box(c, r, pal.wood, pal.woodDark);
      for (const [dx, dy, col] of [[2, 2, pal.paper], [8, 3, pal.goldLight], [14, 2, pal.paper], [20, 3, oklch(0.8, 0.08, 25)], [5, 6, oklch(0.82, 0.07, 230)], [16, 6, pal.paper]] as const) {
        if (dx + 5 > r.w) continue;
        R(c, r.x + dx, r.y + dy, 5, 3, col);
      }
      break;
    case "kanban":
      box(c, r, pal.paper, pal.ink2);
      for (let col = 0; col < 3; col++) {
        const x = r.x + 2 + col * 11;
        R(c, x + 9, r.y + 1, 1, r.h - 2, pal.metal);
        for (let k = 0; k < 3 - col; k++) R(c, x, r.y + 2 + k * 3, 6, 2, col === 2 ? oklch(0.78, 0.1, 150) : col === 1 ? pal.goldLight : oklch(0.84, 0.06, 230));
      }
      break;
    case "clock":
      box(c, r, pal.paper, pal.ink);
      break;
    case "window":
      box(c, r, pal.dark ? oklch(0.2, 0.06, 265) : pal.glass, pal.ink2);
      R(c, r.x + Math.floor(r.w / 2), r.y + 1, 1, r.h - 2, pal.ink2);
      if (pal.dark) {
        P(c, r.x + 3, r.y + 2, pal.goldLight); P(c, r.x + 7, r.y + 5, pal.paper); P(c, r.x + 15, r.y + 3, pal.paper); P(c, r.x + 18, r.y + 6, pal.goldLight);
      } else {
        R(c, r.x + 2, r.y + 2, 3, 1, "#FFFFFF"); R(c, r.x + 14, r.y + 4, 4, 1, "#FFFFFF");
      }
      break;
    case "clapper":
      R(c, r.x, r.y + 3, r.w, r.h - 3, pal.ink);
      for (let x = 0; x < r.w; x += 4) R(c, r.x + x, r.y, 2, 3, pal.paper);
      R(c, r.x, r.y, r.w, 3, withAlpha(pal.ink.length === 7 ? pal.ink : "#222244", 0.25));
      R(c, r.x + 2, r.y + 5, r.w - 4, 1, pal.paperShade);
      break;
    case "frame":
      box(c, r, pal.dark ? oklch(0.35, 0.06, 330) : oklch(0.86, 0.05, 330), pal.goldDark);
      R(c, r.x + 3, r.y + 5, r.w - 6, 2, pal.dark ? oklch(0.45, 0.08, 150) : oklch(0.7, 0.09, 150));
      P(c, r.x + r.w - 4, r.y + 2, pal.gold);
      break;
  }
}

function drawFloorItem(c: Ctx, it: Item<FloorKind>, pal: OfficePalette) {
  const r = it.rect;
  const shadow = (w: number) => R(c, r.x + 1, r.y + r.h, w - 1, 1, pal.wallShadow);
  switch (it.kind) {
    case "plant":
    case "plant-tall": {
      const tall = it.kind === "plant-tall";
      const potH = tall ? 6 : 5;
      const cx = r.x + Math.floor(r.w / 2);
      // leaves
      const leaves: [number, number, number, number][] = tall
        ? [[-2, 0, 4, 3], [-5, 3, 4, 3], [1, 3, 5, 3], [-4, 7, 3, 3], [1, 7, 4, 3], [-3, 10, 6, 3], [-5, 12, 3, 2], [2, 12, 3, 2]]
        : [[-2, 0, 4, 2], [-4, 2, 3, 3], [1, 2, 4, 3], [-3, 5, 6, 3]];
      for (const [dx, dy, w, h] of leaves) R(c, cx + dx, r.y + dy, w, h, pal.leaf);
      const veins: [number, number][] = tall ? [[-1, 2], [3, 5], [-3, 9], [0, 12]] : [[0, 1], [-2, 4], [2, 4]];
      for (const [dx, dy] of veins) R(c, cx + dx, r.y + dy, 1, 2, pal.leafDark);
      R(c, cx - 4, r.y + r.h - potH, 8, potH, pal.pot);
      R(c, cx - 4, r.y + r.h - potH, 8, 1, pal.ink2);
      R(c, cx - 3, r.y + r.h - 1, 6, 1, pal.ink2);
      shadow(r.w);
      break;
    }
    case "bookshelf": {
      box(c, r, pal.woodDark, pal.ink2);
      const shelves = 3;
      const sh = Math.floor((r.h - 2) / shelves);
      const spine = [oklch(0.5, 0.11, 25), oklch(0.45, 0.09, 270), oklch(0.62, 0.11, 85), oklch(0.5, 0.08, 160), pal.paper, oklch(0.55, 0.1, 330)];
      for (let s = 0; s < shelves; s++) {
        const y = r.y + 1 + s * sh;
        R(c, r.x + 1, y + sh - 1, r.w - 2, 1, pal.wood);
        let x = r.x + 2;
        let k = s * 3;
        while (x < r.x + r.w - 3) {
          const w = 2 + ((k * 7) % 2);
          const h = sh - 3 - ((k * 5) % 2);
          R(c, x, y + sh - 1 - h, w, h, spine[k % spine.length]!);
          x += w + ((k % 4 === 3) ? 2 : 0);
          k++;
        }
      }
      shadow(r.w);
      break;
    }
    case "cabinets":
    case "cabinet": {
      const n = it.kind === "cabinets" ? 2 : 1;
      const w = Math.floor(r.w / n);
      for (let i = 0; i < n; i++) {
        const cr = { x: r.x + i * w, y: r.y, w: w - (n > 1 ? 1 : 0), h: r.h };
        box(c, cr, pal.metal, pal.ink2);
        for (let d = 0; d < 3; d++) {
          const y = cr.y + 2 + d * Math.floor((cr.h - 3) / 3);
          R(c, cr.x + 1, y + Math.floor((cr.h - 3) / 3) - 1, cr.w - 2, 1, pal.metalDark);
          R(c, cr.x + Math.floor(cr.w / 2) - 1, y + 2, 3, 1, pal.ink2);
        }
      }
      shadow(r.w);
      break;
    }
    case "server":
      box(c, r, pal.dark ? oklch(0.18, 0.03, 265) : oklch(0.3, 0.03, 265), pal.ink);
      for (let y = r.y + 3; y < r.y + r.h - 2; y += 4) R(c, r.x + 2, y, r.w - 4, 2, pal.dark ? oklch(0.26, 0.03, 265) : oklch(0.4, 0.03, 265));
      shadow(r.w);
      break;
    case "camera": {
      // tripod + camera, and a ring light beside it
      const cx = r.x + 6;
      R(c, cx - 3, r.y + 4, 7, 5, pal.ink);
      R(c, cx + 4, r.y + 5, 2, 3, pal.ink2);
      P(c, cx, r.y + 6, pal.screenGlow);
      R(c, cx, r.y + 9, 1, 10, pal.ink2);
      R(c, cx - 4, r.y + 19, 1, 4, pal.ink2); R(c, cx + 4, r.y + 19, 1, 4, pal.ink2);
      R(c, cx - 3, r.y + 18, 7, 1, pal.ink2);
      const lx = r.x + 16;
      R(c, lx - 3, r.y, 7, 1, pal.paper); R(c, lx - 3, r.y + 6, 7, 1, pal.paper);
      R(c, lx - 4, r.y + 1, 1, 5, pal.paper); R(c, lx + 4, r.y + 1, 1, 5, pal.paper);
      R(c, lx, r.y + 7, 1, 14, pal.ink2);
      R(c, lx - 3, r.y + 21, 7, 1, pal.ink2);
      shadow(r.w);
      break;
    }
    case "printer":
      box(c, r, pal.metal, pal.ink2);
      R(c, r.x + 3, r.y - 2, r.w - 6, 3, pal.paper);
      R(c, r.x + 2, r.y + 4, r.w - 4, 2, pal.ink2);
      P(c, r.x + r.w - 3, r.y + 2, pal.ok);
      shadow(r.w);
      break;
    case "sofa": {
      const col = pal.dark ? oklch(0.38, 0.08, 25) : oklch(0.62, 0.1, 25);
      R(c, r.x, r.y, r.w, r.h, pal.ink2);
      R(c, r.x + 1, r.y + 1, r.w - 2, 5, col);
      R(c, r.x + 1, r.y + 6, r.w - 2, r.h - 7, oklch(pal.dark ? 0.32 : 0.55, 0.1, 25));
      R(c, r.x + Math.floor(r.w / 2), r.y + 6, 1, r.h - 7, pal.ink2);
      shadow(r.w);
      break;
    }
    case "cooler":
      R(c, r.x + 1, r.y, r.w - 2, 6, pal.dark ? oklch(0.45, 0.06, 230) : oklch(0.86, 0.06, 230));
      R(c, r.x, r.y + 6, r.w, r.h - 6, pal.paper);
      R(c, r.x, r.y + 6, r.w, 1, pal.ink2);
      R(c, r.x + 3, r.y + 9, 3, 1, pal.ink2);
      shadow(r.w);
      break;
    case "bench":
      R(c, r.x, r.y, r.w, 3, pal.wood);
      R(c, r.x, r.y + 3, r.w, 1, pal.woodDark);
      R(c, r.x + 2, r.y + 4, 1, r.h - 4, pal.ink2);
      R(c, r.x + r.w - 3, r.y + 4, 1, r.h - 4, pal.ink2);
      shadow(r.w);
      break;
    case "rug":
    case "mat":
      break;
  }
}

// ---------------------------------------------------------------- per-frame pieces

export function drawChair(c: Ctx, d: DeskSpot, pal: OfficePalette) {
  const x = d.sprite.x, y = d.sprite.y;
  R(c, x + 1, y + 10, 14, 8, pal.chair);
  R(c, x + 2, y + 9, 12, 1, pal.chair);
  R(c, x + 1, y + 10, 1, 8, pal.chairShade);
  R(c, x + 14, y + 10, 1, 8, pal.chairShade);
}

export function drawDesk(c: Ctx, d: DeskSpot, pal: OfficePalette, opts: { working: boolean; t: number; lamp: boolean }) {
  const r = d.desk;
  // shadow, front face, top surface
  R(c, r.x + 1, r.y + r.h, r.w - 1, 1, pal.wallShadow);
  R(c, r.x, r.y, r.w, r.h, pal.deskEdge);
  R(c, r.x + 1, r.y + 1, r.w - 2, 8, pal.deskTop);
  R(c, r.x + 1, r.y + 9, r.w - 2, r.h - 10, pal.deskFront);
  R(c, r.x + 1, r.y + 9, r.w - 2, 1, pal.deskEdge);
  // drawer handle
  R(c, r.x + r.w - 7, r.y + 11, 3, 1, pal.deskEdge);

  // lamp on the left: gold when someone is working at this desk
  if (opts.lamp) {
    R(c, r.x + 2, r.y - 2, 1, 4, pal.ink2);
    R(c, r.x + 1, r.y - 4, 4, 2, opts.working ? pal.gold : pal.metalDark);
    if (opts.working) P(c, r.x + 2, r.y - 2, pal.goldLight);
  }

  // the machine
  if (d.kind === "laptop") {
    const lx = r.x + 9, ly = r.y - 3;
    R(c, lx, ly, 10, 6, pal.deskEdge);
    R(c, lx + 1, ly + 1, 8, 4, pal.metal);
    P(c, lx + 4, ly + 2, pal.paper);
    P(c, lx + 5, ly + 2, pal.paper);
    if (opts.working) R(c, lx + 1, ly - 1, 8, 1, withAlpha(pal.screenGlow.startsWith("#") ? pal.screenGlow : "#AACCFF", 0.85));
    R(c, lx - 1, ly + 6, 12, 1, pal.metalDark);
  } else {
    const monitors = d.kind === "dual" ? [r.x + 1, r.x + r.w - 10] : [r.x + r.w - 11];
    for (const mx of monitors) {
      R(c, mx, r.y - 8, 9, 8, pal.deskEdge);
      R(c, mx + 1, r.y - 7, 7, 6, pal.screenOff);
      if (opts.working) R(c, mx + 1, r.y - 9, 7, 1, pal.screenGlow);
      R(c, mx + 4, r.y, 1, 2, pal.deskEdge);
      R(c, mx + 2, r.y + 2, 5, 1, pal.deskEdge);
    }
    R(c, r.x + 9, r.y + 3, 10, 2, pal.metal);
    R(c, r.x + 9, r.y + 5, 10, 1, pal.metalDark);
  }
  // mug
  if (d.kind !== "dual") {
    R(c, r.x + r.w - 4, r.y + 3, 2, 3, pal.paper);
    P(c, r.x + r.w - 2, r.y + 4, pal.paper);
    const steam = Math.floor(opts.t / 400) % 3;
    if (opts.working) P(c, r.x + r.w - 4 + (steam % 2), r.y + 1 - (steam === 2 ? 1 : 0), withAlpha("#FFFFFF", 0.7));
  }
}

export function drawHands(c: Ctx, d: DeskSpot, skin: string, shirt: string, frame: number) {
  const x = d.sprite.x, y = d.desk.y;
  const l = frame % 2 === 0 ? 0 : 1;
  const rr = frame % 2 === 0 ? 1 : 0;
  // forearms reaching onto the desk, hands tapping
  R(c, x + 2, y - 1, 2, 2, shirt);
  R(c, x + 12, y - 1, 2, 2, shirt);
  R(c, x + 2, y + 1 - l, 3, 2, skin);
  R(c, x + 11, y + 1 - rr, 3, 2, skin);
}

export function drawNotes(c: Ctx, d: DeskSpot, notes: { verdict?: "ok" | "fix" | "reject" | "pending" }[], pal: OfficePalette) {
  notes.slice(-3).forEach((n, i) => {
    const x = d.notes.x - i * 5, y = d.notes.y + (i % 2);
    R(c, x, y, 5, 5, pal.paperShade);
    R(c, x, y, 5, 4, pal.paper);
    R(c, x + 1, y + 2, 3, 1, pal.metalDark);
    P(c, x + 2, y, pal.gold);
    if (n.verdict === "ok") { P(c, x + 3, y - 1, pal.ok); P(c, x + 4, y - 2, pal.ok); P(c, x + 2, y - 2, pal.ok); }
    if (n.verdict === "reject" || n.verdict === "fix") { P(c, x + 2, y - 2, pal.bad); P(c, x + 4, y - 2, pal.bad); P(c, x + 3, y - 1, pal.bad); }
  });
}

export function drawFileStack(c: Ctx, d: DeskSpot, n: number, pal: OfficePalette) {
  for (let i = 0; i < Math.min(n, 5); i++) {
    const y = d.desk.y + 6 - i * 2;
    R(c, d.desk.x + 3, y, 6, 2, i % 2 ? pal.gold : pal.goldDark);
    R(c, d.desk.x + 4, y, 4, 1, pal.paper);
  }
}

/** A gold folder: the "file" handed from desk to desk. */
export function drawFile(c: Ctx, x: number, y: number, pal: OfficePalette, kind: "handoff" | "finding") {
  const X = Math.round(x) - 4, Y = Math.round(y) - 3;
  R(c, X, Y + 1, 8, 6, pal.goldDark);
  R(c, X + 1, Y + 2, 6, 4, kind === "finding" ? pal.goldLight : pal.gold);
  R(c, X, Y, 4, 2, pal.goldDark);
  R(c, X + 2, Y + 1, 4, 1, pal.paper);
}

export function drawClock(c: Ctx, r: Rect, pal: OfficePalette, now: Date) {
  const cx = r.x + 3, cy = r.y + 3;
  const h = (now.getHours() % 12) / 12, m = now.getMinutes() / 60;
  const hand = (frac: number, len: number, col: string) => {
    const a = frac * Math.PI * 2 - Math.PI / 2;
    for (let i = 1; i <= len; i++) P(c, Math.round(cx + Math.cos(a) * i), Math.round(cy + Math.sin(a) * i), col);
  };
  P(c, cx, cy, pal.ink);
  hand(m, 2, pal.ink2);
  hand(h, 1, pal.ink);
}

export function drawScreen(c: Ctx, it: Item<WallKind>, pal: OfficePalette, active: boolean, t: number) {
  const r = it.rect;
  const inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
  if (!active) {
    R(c, inner.x, inner.y, inner.w, inner.h, pal.screenOff);
    P(c, inner.x + inner.w - 2, inner.y + inner.h - 2, pal.ok);
    return;
  }
  R(c, inner.x, inner.y, inner.w, inner.h, pal.screen);
  if (it.kind === "screen-dash") {
    const n = Math.floor(inner.w / 3);
    for (let i = 0; i < n; i++) {
      const v = 0.35 + 0.6 * Math.abs(Math.sin(i * 1.7 + t / 380));
      const h = Math.max(1, Math.round(v * (inner.h - 2)));
      R(c, inner.x + 1 + i * 3, inner.y + inner.h - 1 - h, 2, h, i === n - 2 ? pal.gold : pal.screenGlow);
    }
  } else {
    const off = Math.floor(t / 220);
    for (let row = 0; row < inner.h - 1; row += 2) {
      const k = row / 2 + off;
      const indent = (k * 3) % 5;
      const len = 5 + ((k * 7) % (inner.w - 8));
      R(c, inner.x + 1 + indent, inner.y + 1 + row, Math.min(len, inner.w - 2 - indent), 1, k % 4 === 0 ? pal.gold : pal.screenGlow);
    }
  }
}

export function drawServerLeds(c: Ctx, r: Rect, pal: OfficePalette, active: boolean, t: number) {
  for (let i = 0, y = r.y + 3; y < r.y + r.h - 2; y += 4, i++) {
    const on = active ? (Math.floor(t / 150) + i * 3) % 4 !== 0 : (Math.floor(t / 900) + i) % 5 === 0;
    P(c, r.x + r.w - 4, y, on ? pal.ok : pal.metalDark);
    P(c, r.x + r.w - 6, y, active && (i + Math.floor(t / 300)) % 3 === 0 ? pal.gold : pal.metalDark);
  }
}

export function drawDrawerOpen(c: Ctx, r: Rect, pal: OfficePalette, t: number) {
  // the top drawer of the first cabinet slides out and back while the Librarian files
  const w = Math.floor(r.w / 2) - 1;
  const out = 2 + Math.round(Math.abs(Math.sin(t / 500)) * 3);
  R(c, r.x, r.y + r.h, w, out, pal.metalDark);
  R(c, r.x + 1, r.y + r.h, w - 2, out - 1, pal.paper);
  R(c, r.x + 2, r.y + r.h + 1, 1, 1, pal.goldDark);
}

/** The plan drawn on the Chief's whiteboard: one marker dot per step, by stage, tied to the steps they wait on. */
export function drawPlan(
  c: Ctx, r: Rect, pal: OfficePalette,
  steps: { agent: string; depth: number; after: string[]; phase: "planned" | "working" | "done" | "failed"; hue: number }[],
  t: number,
) {
  if (!steps.length) {
    // idle scribbles
    R(c, r.x + 4, r.y + 3, 14, 1, pal.metal);
    R(c, r.x + 4, r.y + 6, 22, 1, pal.metal);
    return;
  }
  const maxDepth = Math.max(...steps.map((s) => s.depth));
  const cols = maxDepth;
  const pos = new Map<string, { x: number; y: number }>();
  const byDepth = new Map<number, typeof steps>();
  for (const s of steps) byDepth.set(s.depth, [...(byDepth.get(s.depth) ?? []), s]);
  const innerW = r.w - 8, innerH = r.h - 3;
  for (const [d, list] of byDepth) {
    const x = r.x + 4 + Math.round(cols <= 1 ? innerW / 2 : ((d - 1) / (cols - 1)) * (innerW - 3));
    list.forEach((s, i) => {
      const y = r.y + 1 + Math.round(((i + 0.5) / list.length) * innerH) - 1;
      pos.set(s.agent, { x, y });
    });
  }
  // links
  for (const s of steps) {
    const b = pos.get(s.agent)!;
    for (const a of s.after) {
      const p = pos.get(a);
      if (!p) continue;
      const done = steps.find((x) => x.agent === a)?.phase === "done";
      const n = Math.max(Math.abs(b.x - p.x), Math.abs(b.y - p.y));
      for (let i = 1; i < n; i++) {
        const x = Math.round(p.x + 1 + ((b.x - p.x) * i) / n), y = Math.round(p.y + 1 + ((b.y - p.y) * i) / n);
        if (i % 2 === 0 || done) P(c, x, y, done ? pal.goldDark : pal.metalDark);
      }
    }
  }
  for (const s of steps) {
    const p = pos.get(s.agent)!;
    const col = oklch(0.62, 0.13, s.hue);
    if (s.phase === "done") { R(c, p.x, p.y, 3, 3, col); P(c, p.x + 1, p.y + 1, pal.paper); }
    else if (s.phase === "working") {
      const blink = Math.floor(t / 300) % 2 === 0;
      R(c, p.x - (blink ? 1 : 0), p.y - (blink ? 1 : 0), blink ? 5 : 3, blink ? 5 : 3, pal.gold);
      R(c, p.x, p.y, 3, 3, col);
    } else {
      R(c, p.x, p.y, 3, 1, col); R(c, p.x, p.y + 2, 3, 1, col); P(c, p.x, p.y + 1, col); P(c, p.x + 2, p.y + 1, col);
    }
  }
}

export function drawBadge(c: Ctx, x: number, y: number, kind: "ok" | "bad", pal: OfficePalette, s = 1) {
  const col = kind === "ok" ? pal.ok : pal.bad;
  const X = Math.round(x) - 4, Y = Math.round(y) - 4;
  R(c, X + 1, Y, 7, 9, pal.paper);
  R(c, X, Y + 1, 9, 7, pal.paper);
  R(c, X + 1, Y + 1, 7, 7, col);
  if (s <= 0) return;
  if (kind === "ok") {
    P(c, X + 2, Y + 4, pal.paper); P(c, X + 3, Y + 5, pal.paper); P(c, X + 4, Y + 4, pal.paper); P(c, X + 5, Y + 3, pal.paper); P(c, X + 6, Y + 2, pal.paper);
  } else {
    for (let i = 0; i < 5; i++) { P(c, X + 2 + i, Y + 2 + i, pal.paper); P(c, X + 6 - i, Y + 2 + i, pal.paper); }
  }
}

export function drawSparkle(c: Ctx, x: number, y: number, k: number, pal: OfficePalette) {
  const r = 2 + k * 3;
  P(c, x, y - r, pal.gold); P(c, x, y + r, pal.gold); P(c, x - r, y, pal.gold); P(c, x + r, y, pal.gold);
  if (k > 0.4) { P(c, x - r + 1, y - r + 1, pal.goldLight); P(c, x + r - 1, y + r - 1, pal.goldLight); }
}

export function drawLampGlow(c: Ctx, d: DeskSpot, pal: OfficePalette) {
  const cx = d.desk.x + d.desk.w / 2, cy = d.desk.y + 2;
  const g = c.createRadialGradient(cx, cy, 2, cx, cy, 30);
  g.addColorStop(0, withAlpha(pal.lampGlow.startsWith("#") ? pal.lampGlow : "#9C8A55", pal.dark ? 0.32 : 0.22));
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(cx - 30, cy - 30, 60, 60);
}

export { hueOf, FACE };
