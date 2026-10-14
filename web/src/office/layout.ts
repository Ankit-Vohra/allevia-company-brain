// The office floor plan, in logical pixels. Two arrangements of the same rooms: landscape (4 + corridor + 4) for wide
// screens, portrait (two columns around a vertical corridor) for phones. Furniture is placed by rules so both work.
import { AGENTS, DEPARTMENTS, type DepartmentDef } from "@shared/roster";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export type WallKind = "whiteboard" | "chart" | "screen-dash" | "screen-code" | "pinboard" | "kanban" | "clock" | "window" | "clapper" | "frame";
export type FloorKind = "plant" | "plant-tall" | "bookshelf" | "cabinets" | "server" | "camera" | "cabinet" | "printer" | "rug" | "mat" | "sofa" | "cooler" | "bench";

export interface Item<K extends string> { kind: K; rect: Rect }

export interface RoomLayout {
  dept: DepartmentDef;
  rect: Rect;          // full room incl. walls
  inner: Rect;         // floor area
  face: Rect;          // the top wall's visible face (3/4 view), where things hang
  door: { side: "top" | "bottom" | "left" | "right"; at: number; w: number; inside: Pt; outside: Pt };
  wall: Item<WallKind>[];
  floor: Item<FloorKind>[];
  label: Pt;           // centre of the floor-plan room label
  agents: string[];
}

export interface DeskSpot {
  agent: string;
  dept: string;
  desk: Rect;          // 28×14: top surface 9px + front face 5px
  sprite: Pt;          // top-left of the 16×20 character
  kind: "laptop" | "monitor" | "dual";
  label: Pt;           // top-centre of the name label
  bubble: Pt;          // bottom-centre of the speech bubble
  notes: Pt;           // where finding notes pin
  center: Pt;          // where flying files land
}

export interface OfficeLayout {
  orientation: "landscape" | "portrait";
  w: number;
  h: number;
  rooms: RoomLayout[];
  desks: Record<string, DeskSpot>;
  corridor: Rect;
  corridorItems: Item<FloorKind>[];
  entrance: Rect;
  route: (from: string, to: string) => Pt[];
}

export const WALL = 4;     // wall thickness
export const FACE = 12;    // visible height of a top wall's face
export const DESK_W = 28;
export const DESK_H = 14;

const KIT: Record<string, { wall: WallKind[]; floor: FloorKind[]; desk: DeskSpot["kind"] }> = {
  leadership: { wall: ["whiteboard", "frame"], floor: ["rug", "bookshelf", "plant-tall", "plant"], desk: "monitor" },
  coe: { wall: ["chart", "clock"], floor: ["cabinet", "plant"], desk: "laptop" },
  analytics: { wall: ["screen-dash", "window"], floor: ["printer", "plant"], desk: "dual" },
  marketing: { wall: ["pinboard", "window"], floor: ["sofa", "plant-tall"], desk: "laptop" },
  content: { wall: ["clapper", "window", "frame"], floor: ["camera", "plant"], desk: "laptop" },
  tech: { wall: ["screen-code", "clock"], floor: ["server", "plant"], desk: "monitor" },
  ops: { wall: ["kanban", "clock"], floor: ["cabinet", "plant"], desk: "laptop" },
  knowledge: { wall: ["window"], floor: ["bookshelf", "cabinets", "plant"], desk: "laptop" },
};

const WALL_SIZE: Record<WallKind, [number, number]> = {
  whiteboard: [44, 11], chart: [22, 10], "screen-dash": [30, 11], "screen-code": [28, 11], pinboard: [28, 10],
  kanban: [34, 11], clock: [7, 7], window: [22, 9], clapper: [12, 9], frame: [12, 9],
};
const FLOOR_SIZE: Record<FloorKind, [number, number]> = {
  plant: [10, 14], "plant-tall": [12, 22], bookshelf: [26, 26], cabinets: [24, 22], server: [13, 26], camera: [22, 24],
  cabinet: [12, 18], printer: [16, 12], rug: [0, 0], mat: [0, 0], sofa: [30, 14], cooler: [9, 18], bench: [26, 9],
};

const deptById = (id: string) => DEPARTMENTS.find((d) => d.id === id)!;
const agentsIn = (dept: string) => AGENTS.filter((a) => a.department === dept).map((a) => a.id);

const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

interface RoomSpec { dept: string; rect: Rect; doorSide: RoomLayout["door"]["side"]; corridorAt: number; outerLeft: boolean; outerRight: boolean; outerTop: boolean; outerBottom: boolean }

function buildRoom(spec: RoomSpec, desks: Record<string, DeskSpot>): RoomLayout {
  const { rect } = spec;
  const dept = deptById(spec.dept);
  const half = WALL / 2;
  const left = rect.x + (spec.outerLeft ? WALL : half);
  const right = rect.x + rect.w - (spec.outerRight ? WALL : half);
  const top = rect.y + (spec.outerTop ? WALL : half) + FACE;
  const bottom = rect.y + rect.h - (spec.outerBottom ? WALL : half);
  const inner: Rect = { x: left, y: top, w: right - left, h: bottom - top };
  const face: Rect = { x: left, y: top - FACE, w: inner.w, h: FACE };

  // door
  const doorW = 18;
  let door: RoomLayout["door"];
  if (spec.doorSide === "bottom" || spec.doorSide === "top") {
    const at = Math.round(inner.x + inner.w * (dept.id === "leadership" ? 0.5 : 0.78) - doorW / 2);
    const inside = { x: at + doorW / 2, y: spec.doorSide === "bottom" ? inner.y + inner.h - 8 : inner.y + 8 };
    door = { side: spec.doorSide, at, w: doorW, inside, outside: { x: inside.x, y: spec.corridorAt } };
  } else {
    const at = Math.round(inner.y + inner.h * 0.62 - doorW / 2);
    const inside = { x: spec.doorSide === "right" ? inner.x + inner.w - 8 : inner.x + 8, y: at + doorW / 2 };
    door = { side: spec.doorSide, at, w: doorW, inside, outside: { x: spec.corridorAt, y: inside.y } };
  }
  const doorZone: Rect =
    door.side === "bottom" ? { x: door.at - 2, y: inner.y + inner.h - 16, w: door.w + 4, h: 16 } :
    door.side === "top" ? { x: door.at - 2, y: face.y, w: door.w + 4, h: FACE + 16 } :
    door.side === "right" ? { x: inner.x + inner.w - 16, y: door.at - 2, w: 16, h: door.w + 4 } :
    { x: inner.x, y: door.at - 2, w: 16, h: door.w + 4 };

  // desks: one row if they fit (gap shrinks to 6), else two rows
  const ids = agentsIn(dept.id);
  const kit = KIT[dept.id]!;
  let gap = 14;
  let perRow = ids.length;
  while (perRow * DESK_W + (perRow - 1) * gap > inner.w - 12 && gap > 6) gap -= 2;
  while (perRow > 1 && perRow * DESK_W + (perRow - 1) * gap > inner.w - 12) perRow--;
  const rows = Math.ceil(ids.length / perRow);
  const unitH = 44;
  const blockH = rows * unitH;
  const deskTop0 = Math.round(inner.y + Math.max(20, (inner.h - blockH) * 0.42 + 18));
  const deskRects: Rect[] = [];
  ids.forEach((agent, i) => {
    const r = Math.floor(i / perRow);
    const inRow = Math.min(perRow, ids.length - r * perRow);
    const rowW = inRow * DESK_W + (inRow - 1) * gap;
    const shift = dept.id === "knowledge" || dept.id === "tech" ? -8 : dept.id === "coe" || dept.id === "ops" ? 6 : 0;
    const x0 = Math.round(inner.x + (inner.w - rowW) / 2) + (ids.length === 1 ? shift : 0);
    const c = i % perRow;
    const desk: Rect = { x: x0 + c * (DESK_W + gap), y: deskTop0 + r * unitH, w: DESK_W, h: DESK_H };
    deskRects.push({ x: desk.x - 2, y: desk.y - 18, w: desk.w + 4, h: desk.h + 30 });
    const sprite = { x: desk.x + 6, y: desk.y - 15 };
    desks[agent] = {
      agent, dept: dept.id, desk, sprite, kind: kit.desk,
      label: { x: desk.x + DESK_W / 2, y: desk.y + DESK_H + 2 },
      bubble: { x: sprite.x + 8, y: sprite.y - 1 },
      notes: { x: desk.x + DESK_W - 8, y: desk.y + 1 },
      center: { x: desk.x + DESK_W / 2, y: desk.y + 3 },
    };
  });

  // wall items: spread along the face, skipping the door gap
  const wall: Item<WallKind>[] = [];
  const blocked: [number, number][] = door.side === "top" ? [[door.at - 3, door.at + door.w + 3]] : [];
  const kinds = kit.wall;
  const slots = kinds.length;
  kinds.forEach((kind, i) => {
    const [w, h] = WALL_SIZE[kind];
    // first item centred over the desks (the room's "main" wall), the rest toward the edges
    let cx = i === 0 ? inner.x + inner.w / 2 : inner.x + (inner.w * (i % 2 === 1 ? 0.15 : 0.85));
    if (slots === 1) cx = inner.x + inner.w / 2;
    let x = Math.round(cx - w / 2);
    x = Math.max(inner.x + 3, Math.min(inner.x + inner.w - w - 3, x));
    for (const [a, b] of blocked) if (x < b && x + w > a) x = x + w / 2 < (a + b) / 2 ? a - w - 1 : b + 1;
    const rect = { x, y: face.y + Math.round((FACE - h) / 2) + (kind === "clock" ? -1 : 0), w, h };
    if (rect.x < inner.x + 2 || rect.x + w > inner.x + inner.w - 2) return;
    if (wall.some((o) => overlaps(o.rect, rect, 2))) return;
    wall.push({ kind, rect });
  });

  // floor items: corners first (top corners stand against the wall), never on desks or in the doorway
  const floor: Item<FloorKind>[] = [];
  // the floor-plan label is mono caps at ~4.6 art px: about 3.2 art px per character plus its colour dot
  const labelW = Math.min(inner.w - 4, dept.name.length * 3.2 + 12);
  const labelZone: Rect = { x: inner.x + (inner.w - labelW) / 2, y: inner.y + inner.h - 15, w: labelW, h: 13 };
  const taken: Rect[] = [...deskRects, doorZone, labelZone];
  // every desk group stands on a mat in the room's tint; the Chief's office gets the gold-edged rug
  if (!kit.floor.includes("rug") && deskRects.length) {
    const x0 = Math.min(...deskRects.map((d) => d.x)), x1 = Math.max(...deskRects.map((d) => d.x + d.w));
    const y0 = Math.min(...deskRects.map((d) => d.y)), y1 = Math.max(...deskRects.map((d) => d.y + d.h));
    floor.push({ kind: "mat", rect: { x: x0 - 3, y: y0 + 10, w: x1 - x0 + 6, h: y1 - y0 - 14 } });
  }
  for (const kind of kit.floor) {
    if (kind === "rug") {
      const d = deskRects[0]!;
      floor.push({ kind, rect: { x: d.x - 10, y: d.y + 12, w: d.w + 20, h: 26 } });
      continue;
    }
    const [w, h] = FLOOR_SIZE[kind];
    const tall = h > 16;
    const corners: Pt[] = [
      { x: inner.x + 3, y: inner.y - (tall ? 6 : 0) + 2 },
      { x: inner.x + inner.w - w - 3, y: inner.y - (tall ? 6 : 0) + 2 },
      { x: inner.x + 3, y: inner.y + inner.h - h - 3 },
      { x: inner.x + inner.w - w - 3, y: inner.y + inner.h - h - 3 },
    ];
    const order = kind === "plant" || kind === "sofa" || kind === "camera" ? [3, 2, 1, 0] : [0, 1, 3, 2];
    for (const ci of order) {
      const p = corners[ci]!;
      const rect = { x: p.x, y: p.y, w, h };
      if (taken.some((t) => overlaps(t, rect, 1))) continue;
      taken.push(rect);
      floor.push({ kind, rect });
      break;
    }
  }

  return {
    dept, rect, inner, face, door, wall, floor, agents: ids,
    label: { x: inner.x + inner.w / 2, y: inner.y + inner.h - 9 },
  };
}

export function buildLayout(orientation: "landscape" | "portrait"): OfficeLayout {
  const desks: Record<string, DeskSpot> = {};
  const rooms: RoomLayout[] = [];
  let w: number, h: number, corridor: Rect, entrance: Rect;
  const corridorItems: Item<FloorKind>[] = [];

  if (orientation === "landscape") {
    // 404×272 lets a 2× screen draw it at 5 device pixels per art pixel (2.5 CSS px)
    w = 404; h = 272;
    const topH = 116, corH = 40, botY = topH + corH;
    const midY = topH + corH / 2;
    corridor = { x: WALL, y: topH, w: w - WALL * 2, h: corH };
    const top: [string, number][] = [["knowledge", 96], ["analytics", 98], ["leadership", 116], ["coe", 94]];
    const bot: [string, number][] = [["marketing", 92], ["content", 128], ["tech", 92], ["ops", 92]];
    let x = 0;
    top.forEach(([dept, rw], i) => {
      rooms.push(buildRoom({ dept, rect: { x, y: 0, w: rw, h: topH }, doorSide: "bottom", corridorAt: midY, outerLeft: i === 0, outerRight: i === top.length - 1, outerTop: true, outerBottom: true }, desks));
      x += rw;
    });
    x = 0;
    bot.forEach(([dept, rw], i) => {
      rooms.push(buildRoom({ dept, rect: { x, y: botY, w: rw, h: h - botY }, doorSide: "top", corridorAt: midY, outerLeft: i === 0, outerRight: i === bot.length - 1, outerTop: true, outerBottom: true }, desks));
      x += rw;
    });
    entrance = { x: 0, y: midY - 9, w: WALL, h: 18 };
    corridorItems.push(
      { kind: "cooler", rect: { x: 214, y: topH + 2, w: 9, h: 18 } },
      { kind: "plant-tall", rect: { x: 386, y: topH - 4, w: 12, h: 22 } },
      { kind: "bench", rect: { x: 236, y: botY - 9, w: 26, h: 9 } },
      { kind: "plant", rect: { x: 79, y: botY - 15, w: 10, h: 14 } },
    );
  } else {
    // 214 wide: a 3× phone draws it at 5 device pixels per art pixel
    w = 214; h = 448;
    const colW = 96, corW = 22;
    const midX = colW + corW / 2;
    corridor = { x: colW, y: WALL, w: corW, h: h - WALL * 2 };
    const rowsSpec: [string, string, number][] = [["leadership", "coe", 104], ["knowledge", "analytics", 104], ["content", "marketing", 136], ["tech", "ops", 104]];
    let y = 0;
    rowsSpec.forEach(([l, r, rh], i) => {
      const last = i === rowsSpec.length - 1;
      const hh = last ? h - y : rh;
      rooms.push(buildRoom({ dept: l, rect: { x: 0, y, w: colW, h: hh }, doorSide: "right", corridorAt: midX, outerLeft: true, outerRight: true, outerTop: i === 0, outerBottom: last }, desks));
      rooms.push(buildRoom({ dept: r, rect: { x: colW + corW, y, w: w - colW - corW, h: hh }, doorSide: "left", corridorAt: midX, outerLeft: true, outerRight: true, outerTop: i === 0, outerBottom: last }, desks));
      y += rh;
    });
    entrance = { x: midX - 8, y: h - WALL, w: 16, h: WALL };
    corridorItems.push({ kind: "plant", rect: { x: colW + 6, y: 6, w: 10, h: 14 } }, { kind: "cooler", rect: { x: colW + 7, y: 214, w: 9, h: 18 } });
  }

  const roomOf = (agent: string) => rooms.find((r) => r.agents.includes(agent));
  const route = (from: string, to: string): Pt[] => {
    const a = desks[from], b = desks[to];
    if (!a || !b) return [];
    const ra = roomOf(from)!, rb = roomOf(to)!;
    if (ra === rb) return [a.center, { x: (a.center.x + b.center.x) / 2, y: Math.min(a.center.y, b.center.y) - 14 }, b.center];
    return [a.center, ra.door.inside, ra.door.outside, rb.door.outside, rb.door.inside, b.center];
  };

  return { orientation, w, h, rooms, desks, corridor, corridorItems, entrance, route };
}
