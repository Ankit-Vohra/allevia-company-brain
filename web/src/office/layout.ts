// The office floor plan, in logical pixels: one open-plan floor, not closed rooms. Each team keeps a zone of its own,
// marked by a coloured rug, a hanging sign and its desks grouped together; low shelves and plants divide the zones.
// The cafeteria and the game room are open corners of the same floor. Two arrangements of the same plan: landscape (two
// rows of zones around a central avenue) and portrait (two columns around a walkway) for phones. Every desk comes from
// the roster; nothing here knows how many staff there are.
import { AGENTS, DEPARTMENTS, type DepartmentDef } from "@shared/roster";
import { type Grid, buildGrid, findPath } from "./path";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

/** Boards on stands and things on the back wall. */
export type WallKind = "whiteboard" | "chart" | "screen-dash" | "screen-code" | "pinboard" | "kanban" | "clock" | "window" | "clapper" | "frame" | "tv" | "menu" | "status" | "poster";
export type FloorKind =
  | "plant" | "plant-tall" | "bookshelf" | "cabinets" | "server" | "camera" | "cabinet" | "printer" | "rug" | "mat" | "sofa"
  | "cooler" | "bench" | "counter" | "fridge" | "cafe-table" | "pingpong" | "console" | "beanbag" | "board-table" | "dogbed"
  | "carpet" | "tiles" | "lowshelf" | "catbed" | "glassroom";

export interface Item<K extends string> { kind: K; rect: Rect; n?: number }

export type ZoneKind = "dept" | "cafe" | "lounge";

export interface RoomLayout {
  kind: ZoneKind;
  dept: DepartmentDef;  // for the shared corners, a stand-in with their name and tint
  rect: Rect;           // the zone's footprint on the floor
  inner: Rect;
  sign: Pt;             // centre of the hanging sign
  wall: Item<WallKind>[]; // boards on stands (the whiteboard, the code screen, the menu, the TV)
  floor: Item<FloorKind>[];
  label: Pt;            // = sign
  agents: string[];
}

export interface DeskSpot {
  agent: string;
  dept: string;
  desk: Rect;           // 28×14: top surface 9px + front face 5px
  sprite: Pt;           // top-left of the 16×20 seated character
  kind: "laptop" | "monitor" | "dual";
  label: Pt;            // top-centre of the name label
  bubble: Pt;           // bottom-centre of the speech bubble
  notes: Pt;            // where finding notes pin
  center: Pt;           // where files land on the desk
  seat: Pt;             // feet point when sitting (behind the desk)
  side: Pt;             // beside the desk: where its owner steps in and out of the chair
  drop: Pt;             // in front of the desk: where a dog delivers
}

export type Activity = "coffee" | "tea" | "fridge" | "table" | "pingpong" | "console" | "boardgame" | "nap" | "plant" | "window" | "chat";
export type Facing = "front" | "back" | "left" | "right";

/** A place where someone can do something: stand at the coffee machine, sit on a beanbag, hold a paddle. */
export interface Spot {
  id: string;
  activity: Activity;
  at: Pt;               // feet point
  face: Facing;
  pose: "stand" | "sit";
  group?: string;       // spots used together (both ends of the ping-pong table)
  zone: string;
}

export interface Light { at: Pt; r: number; kind: "lamp" | "pendant" | "tv" | "screen" | "fridge"; agent?: string }

export interface OfficeLayout {
  orientation: "landscape" | "portrait";
  w: number;
  h: number;
  floor: Rect;                // the whole walkable floor inside the outer wall
  topWall: Rect;              // the back wall's visible face
  windows: Item<WallKind>[];  // on the back wall: the daylight comes through these
  backWall: Item<WallKind>[]; // clock and posters
  rooms: RoomLayout[];
  desks: Record<string, DeskSpot>;
  walkways: Rect[];           // the lanes between zones, drawn lighter so the pets' routes read
  corridorItems: Item<FloorKind>[];
  entrance: Rect;
  spots: Spot[];
  lights: Light[];
  petHomes: { dogs: Pt[]; cats: Pt[]; ball: Pt; sun: Pt };
  grid: Grid;
  /** A walking route between two feet points, around furniture and desks. */
  walk: (from: Pt, to: Pt) => Pt[];
  /** A pleasant place to wander to, picked from two numbers in 0..1. */
  randomFloor: (r1: number, r2: number) => Pt;
}

export const WALL = 4;     // outer wall thickness
export const FACE = 12;    // visible height of the back wall
export const DESK_W = 28;
export const DESK_H = 14;

export const CAFE: DepartmentDef = { id: "cafe", name: "Cafeteria", blurb: "Coffee, chai and a fridge full of snacks.", hue: 62 };
export const LOUNGE: DepartmentDef = { id: "lounge", name: "Game room", blurb: "Ping-pong, a console and a board game.", hue: 305 };

const KIT: Record<string, { board: WallKind[]; floor: FloorKind[]; desk: DeskSpot["kind"] }> = {
  leadership: { board: ["whiteboard", "frame"], floor: ["rug", "bookshelf", "plant-tall", "plant"], desk: "monitor" },
  coe: { board: ["chart"], floor: ["cabinet", "plant"], desk: "laptop" },
  analytics: { board: ["screen-dash"], floor: ["printer", "plant"], desk: "dual" },
  marketing: { board: ["pinboard"], floor: ["sofa", "plant-tall"], desk: "laptop" },
  content: { board: ["clapper", "frame"], floor: ["camera", "plant"], desk: "laptop" },
  tech: { board: ["screen-code", "status"], floor: ["server", "plant"], desk: "monitor" },
  ops: { board: ["kanban"], floor: ["cabinet", "plant"], desk: "laptop" },
  knowledge: { board: [], floor: ["bookshelf", "cabinets", "plant"], desk: "laptop" },
};
const DEFAULT_KIT = { board: [] as WallKind[], floor: ["plant"] as FloorKind[], desk: "laptop" as const };

// a few desks have their own machine, as a UI touch (unknown agents use their department's)
const DESK_KIND: Record<string, DeskSpot["kind"]> = { "oncall-engineer": "dual", "data-analyst": "dual" };

export const WALL_SIZE: Record<WallKind, [number, number]> = {
  whiteboard: [44, 11], chart: [22, 10], "screen-dash": [30, 11], "screen-code": [28, 11], pinboard: [28, 10],
  kanban: [34, 11], clock: [7, 7], window: [24, 10], clapper: [12, 9], frame: [12, 9], tv: [28, 11], menu: [22, 10],
  status: [16, 9], poster: [12, 10],
};
export const FLOOR_SIZE: Record<FloorKind, [number, number]> = {
  plant: [10, 14], "plant-tall": [12, 22], bookshelf: [26, 26], cabinets: [24, 22], server: [13, 26], camera: [22, 24],
  cabinet: [12, 18], printer: [16, 12], rug: [0, 0], mat: [0, 0], sofa: [30, 14], cooler: [9, 18], bench: [26, 9],
  counter: [62, 14], fridge: [14, 26], "cafe-table": [14, 10], pingpong: [36, 18], console: [24, 6], beanbag: [12, 9],
  "board-table": [16, 9], dogbed: [18, 9], carpet: [0, 0], tiles: [0, 0], lowshelf: [20, 7], catbed: [12, 7], glassroom: [0, 0],
};

const deptById = (id: string) => DEPARTMENTS.find((d) => d.id === id)!;
const agentsIn = (dept: string) => AGENTS.filter((a) => a.department === dept).map((a) => a.id);
const kitOf = (dept: string) => KIT[dept] ?? DEFAULT_KIT;

const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

const GAP = 12;
const ZONE_H = 92;

/** The desks of a department in a zone: one row if they fit, else more. Returns the desk rects and the block's height. */
function placeDesks(dept: DepartmentDef, Z: Rect, desks: Record<string, DeskSpot>): Rect[] {
  const ids = agentsIn(dept.id);
  const kit = kitOf(dept.id);
  const iw = Z.w - 10;
  let perRow = Math.max(1, ids.length);
  while (perRow > 1 && perRow * DESK_W + (perRow - 1) * GAP > iw) perRow--;
  const unitH = 46;
  const out: Rect[] = [];
  ids.forEach((agent, i) => {
    const r = Math.floor(i / perRow);
    const inRow = Math.min(perRow, ids.length - r * perRow);
    const rowW = inRow * DESK_W + (inRow - 1) * GAP;
    const x0 = Math.round(Z.x + (Z.w - rowW) / 2);
    const c = i % perRow;
    const desk: Rect = { x: x0 + c * (DESK_W + GAP), y: Z.y + 38 + r * unitH, w: DESK_W, h: DESK_H };
    out.push({ x: desk.x - 2, y: desk.y - 18, w: desk.w + 4, h: desk.h + 30 });
    const sprite = { x: desk.x + 6, y: desk.y - 15 };
    desks[agent] = {
      agent, dept: dept.id, desk, sprite, kind: DESK_KIND[agent] ?? kit.desk,
      label: { x: desk.x + DESK_W / 2, y: desk.y + DESK_H + 2 },
      bubble: { x: sprite.x + 8, y: sprite.y - 1 },
      notes: { x: desk.x + DESK_W - 8, y: desk.y + 1 },
      center: { x: desk.x + DESK_W / 2, y: desk.y + 3 },
      seat: { x: sprite.x + 8, y: desk.y + 1 },
      side: { x: desk.x - 7, y: desk.y + 8 },
      drop: { x: desk.x + DESK_W + 5, y: desk.y + 22 },
    };
  });
  return out;
}

function placeBoards(kinds: WallKind[], Z: Rect, avoid: Rect[]): Item<WallKind>[] {
  const out: Item<WallKind>[] = [];
  kinds.forEach((kind, i) => {
    const [w, h] = WALL_SIZE[kind];
    let cx = i === 0 ? Z.x + Z.w / 2 : Z.x + Z.w * (i % 2 === 1 ? 0.2 : 0.8);
    if (kinds.length === 1) cx = Z.x + Z.w / 2;
    const x = Math.max(Z.x + 3, Math.min(Z.x + Z.w - w - 3, Math.round(cx - w / 2)));
    const rect = { x, y: Z.y + 11, w, h };
    if (out.some((o) => overlaps(o.rect, rect, 2)) || avoid.some((a) => overlaps(a, rect, 0))) return;
    out.push({ kind, rect });
  });
  return out;
}

function buildDeptZone(dept: DepartmentDef, Z: Rect, desks: Record<string, DeskSpot>): RoomLayout {
  const kit = kitOf(dept.id);
  const deskRects = placeDesks(dept, Z, desks);
  const floor: Item<FloorKind>[] = [];
  const taken: Rect[] = [...deskRects, { x: Z.x, y: Z.y, w: Z.w, h: 10 }];
  // the rug the team's desks stand on: the zone's colour, so each team is easy to spot
  if (deskRects.length) {
    const x0 = Math.min(...deskRects.map((d) => d.x)), x1 = Math.max(...deskRects.map((d) => d.x + d.w));
    const y0 = Math.min(...deskRects.map((d) => d.y)), y1 = Math.max(...deskRects.map((d) => d.y + d.h));
    const rug = { x: Math.max(Z.x + 2, x0 - 5), y: y0 + 4, w: Math.min(Z.w - 4, x1 - x0 + 10), h: y1 - y0 - 6 };
    floor.push({ kind: kit.floor.includes("rug") ? "rug" : "mat", rect: rug });
  }
  const boards = placeBoards(kit.board, Z, []);
  for (const b of boards) taken.push({ x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h + 2 });
  for (const kind of kit.floor) {
    if (kind === "rug") continue;
    const [w, h] = FLOOR_SIZE[kind];
    const tall = h > 16;
    const corners: Pt[] = [
      { x: Z.x + 4, y: Z.y + 12 + (tall ? 0 : 6) },
      { x: Z.x + Z.w - w - 4, y: Z.y + 12 + (tall ? 0 : 6) },
      { x: Z.x + 4, y: Z.y + Z.h - h - 6 },
      { x: Z.x + Z.w - w - 4, y: Z.y + Z.h - h - 6 },
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
  const sign = { x: Z.x + Z.w / 2, y: Z.y + 6 };
  return { kind: "dept", dept, rect: Z, inner: Z, sign, wall: boards, floor, agents: agentsIn(dept.id), label: sign };
}

/** The cafeteria: a counter with the coffee machine and the kettle, a fridge, small tables. An open corner of the floor. */
function buildCafe(Z: Rect, spots: Spot[], lights: Light[]): RoomLayout {
  const wide = Z.w >= 130;
  const floor: Item<FloorKind>[] = [{ kind: "tiles", rect: { x: Z.x + 1, y: Z.y + 11, w: Z.w - 2, h: Z.h - 12 } }];
  const counter: Rect = { x: Z.x + 6, y: Z.y + 14, w: Math.min(62, Math.round(Z.w * 0.55)), h: 14 };
  const fridge: Rect = { x: Z.x + Z.w - 20, y: Z.y + 6, w: 14, h: 26 };
  floor.push({ kind: "counter", rect: counter }, { kind: "fridge", rect: fridge });
  const ty = Z.y + Math.round(Z.h * 0.56);
  const tables: Rect[] = wide
    ? [{ x: Math.round(Z.x + Z.w * 0.22), y: ty, w: 14, h: 10 }, { x: Math.round(Z.x + Z.w * 0.56), y: ty, w: 14, h: 10 }]
    : [{ x: Math.round(Z.x + Z.w * 0.4), y: ty, w: 14, h: 10 }];
  tables.forEach((t, i) => {
    floor.push({ kind: "cafe-table", rect: t, n: i });
    spots.push(
      { id: `cafe-t${i}-l`, activity: "table", at: { x: t.x - 4, y: t.y + 10 }, face: "right", pose: "sit", group: `cafe-t${i}`, zone: "cafe" },
      { id: `cafe-t${i}-r`, activity: "table", at: { x: t.x + t.w + 4, y: t.y + 10 }, face: "left", pose: "sit", group: `cafe-t${i}`, zone: "cafe" },
    );
  });
  const plant: Rect = { x: Z.x + 5, y: Z.y + Z.h - 20, w: 10, h: 14 };
  floor.push({ kind: "plant", rect: plant });
  spots.push(
    { id: "coffee", activity: "coffee", at: { x: counter.x + 10, y: counter.y + counter.h + 6 }, face: "back", pose: "stand", zone: "cafe" },
    { id: "tea", activity: "tea", at: { x: counter.x + 28, y: counter.y + counter.h + 6 }, face: "back", pose: "stand", zone: "cafe" },
    { id: "fridge", activity: "fridge", at: { x: fridge.x + 7, y: fridge.y + fridge.h + 6 }, face: "back", pose: "stand", zone: "cafe" },
  );
  for (const t of tables) lights.push({ at: { x: t.x + t.w / 2, y: t.y + 2 }, r: 28, kind: "pendant" });
  lights.push({ at: { x: counter.x + counter.w / 2, y: counter.y + 8 }, r: 32, kind: "pendant" }, { at: { x: fridge.x + 7, y: fridge.y + fridge.h }, r: 10, kind: "fridge" });
  const menu: Item<WallKind> = { kind: "menu", rect: { x: counter.x + counter.w - 24, y: Z.y + 11, w: 22, h: 10 } };
  const sign = { x: Z.x + Z.w / 2, y: Z.y + 6 };
  return { kind: "cafe", dept: CAFE, rect: Z, inner: Z, sign, wall: [menu], floor, agents: [], label: sign };
}

/** The game room: ping-pong, a TV with a console and beanbags, a board game on a low table, the dog's bed. */
function buildLounge(Z: Rect, spots: Spot[], lights: Light[]): { room: RoomLayout; dogbed: Rect; catbed: Rect } {
  const wide = Z.w >= 130;
  const floor: Item<FloorKind>[] = [{ kind: "carpet", n: 1, rect: { x: Z.x - 3, y: Z.y + 11, w: Z.w + 1, h: Z.h - 12 } }];
  const tvCx = Math.round(Z.x + Z.w * (wide ? 0.62 : 0.5));
  const tv: Item<WallKind> = { kind: "tv", rect: { x: tvCx - 14, y: Z.y + 12, w: 28, h: 11 } };
  floor.push({ kind: "console", rect: { x: tvCx - 12, y: Z.y + 25, w: 24, h: 6 } });
  const nBags = wide ? 3 : 2;
  const bags: Rect[] = [];
  for (let i = 0; i < nBags; i++) {
    const cx = tvCx + (i - (nBags - 1) / 2) * 15;
    const r = { x: Math.round(cx - 6), y: Z.y + 36, w: 12, h: 9 };
    bags.push(r);
    floor.push({ kind: "beanbag", rect: r, n: i });
    spots.push({ id: `bag-${i}`, activity: i === nBags - 1 ? "nap" : "console", at: { x: r.x + 6, y: r.y + 8 }, face: "back", pose: "sit", group: i === nBags - 1 ? undefined : "console", zone: "lounge" });
  }
  const pp: Rect = wide
    ? { x: Z.x + 16, y: Z.y + Math.round(Z.h * 0.5), w: 36, h: 18 }
    : { x: Math.round(Z.x + (Z.w - 36) / 2), y: Z.y + Math.round(Z.h * 0.58), w: 36, h: 18 };
  floor.push({ kind: "pingpong", rect: pp });
  spots.push(
    { id: "pp-l", activity: "pingpong", at: { x: pp.x - 5, y: pp.y + 15 }, face: "right", pose: "stand", group: "pingpong", zone: "lounge" },
    { id: "pp-r", activity: "pingpong", at: { x: pp.x + pp.w + 5, y: pp.y + 15 }, face: "left", pose: "stand", group: "pingpong", zone: "lounge" },
  );
  if (wide) {
    const bt: Rect = { x: tvCx - 8, y: Z.y + Math.round(Z.h * 0.66), w: 16, h: 9 };
    floor.push({ kind: "board-table", rect: bt });
    spots.push(
      { id: "board-l", activity: "boardgame", at: { x: bt.x - 4, y: bt.y + 9 }, face: "right", pose: "sit", group: "board", zone: "lounge" },
      { id: "board-r", activity: "boardgame", at: { x: bt.x + bt.w + 4, y: bt.y + 9 }, face: "left", pose: "sit", group: "board", zone: "lounge" },
    );
  }
  const dogbed: Rect = { x: Z.x + Z.w - 24, y: Z.y + Z.h - 14, w: 18, h: 9 };
  const catbed: Rect = { x: Z.x + 6, y: Z.y + Z.h - 13, w: 12, h: 7 };
  floor.push({ kind: "dogbed", rect: dogbed }, { kind: "catbed", rect: catbed });
  lights.push({ at: { x: tvCx, y: Z.y + 22 }, r: 34, kind: "tv" });
  const sign = { x: Z.x + Math.round(Z.w * 0.86), y: Z.y + 6 }; // clear of the players and their speech
  return { room: { kind: "lounge", dept: LOUNGE, rect: Z, inner: Z, sign, wall: [tv], floor, agents: [], label: sign }, dogbed, catbed };
}

const widthFor = (dept: string) => {
  const n = agentsIn(dept).length;
  const base = dept === "leadership" ? 104 : 74;
  return Math.max(base, n * DESK_W + Math.max(0, n - 1) * GAP + 24);
};

const TOP = ["knowledge", "analytics", "leadership", "coe"];
const BOTTOM = ["marketing", "content", "tech", "ops"];
const PAIRS: [string, string][] = [["leadership", "coe"], ["knowledge", "analytics"], ["content", "marketing"], ["tech", "ops"]];

/** A run of low shelves and plants along a line, with gaps left for walking. */
function divider(from: Pt, to: Pt, gaps: [number, number][], out: Item<FloorKind>[], taken: Rect[]) {
  const horizontal = Math.abs(to.x - from.x) > Math.abs(to.y - from.y);
  const len = horizontal ? to.x - from.x : to.y - from.y;
  let t = 0, k = 0;
  while (t < len - 6) {
    const gap = gaps.find(([a, b]) => t + 8 > a && t < b);
    if (gap) { t = gap[1]; continue; }
    const plant = k % 2 === 1;
    const [sw, sh] = plant ? [10, 14] : [20, 7];
    // a shelf lying along the line: long side along the divider; vertical dividers use the shelf rotated (7 wide, 20 tall)
    const w = horizontal ? sw : plant ? 10 : 7, h = horizontal ? (plant ? 14 : sh) : plant ? 14 : 20;
    const pieceLen = horizontal ? w : h;
    if (t + pieceLen > len) break;
    const rect = horizontal ? { x: from.x + t, y: from.y - (plant ? 12 : 3), w, h } : { x: from.x - (plant ? 5 : 3), y: from.y + t, w, h };
    if (!taken.some((r) => overlaps(r, rect, 0))) out.push({ kind: plant ? "plant" : "lowshelf", rect, n: k });
    t += pieceLen + 3;
    k++;
  }
}

export function buildLayout(orientation: "landscape" | "portrait"): OfficeLayout {
  const desks: Record<string, DeskSpot> = {};
  const rooms: RoomLayout[] = [];
  const spots: Spot[] = [];
  const lights: Light[] = [];
  const dividers: Item<FloorKind>[] = [];
  const corridorItems: Item<FloorKind>[] = [];
  const walkways: Rect[] = [];
  let w: number, h: number, entrance: Rect;
  let dogbed: Rect, catbed: Rect;
  const present = DEPARTMENTS.map((d) => d.id);
  const floorTop = WALL + FACE;

  if (orientation === "landscape") {
    const top = TOP.filter((d) => present.includes(d));
    const bot = BOTTOM.filter((d) => present.includes(d));
    for (const d of present) {
      if (top.includes(d) || bot.includes(d)) continue;
      const tw = top.reduce((s, x) => s + widthFor(x), 0), bw = bot.reduce((s, x) => s + widthFor(x), 0);
      (tw <= bw ? top : bot).push(d);
    }
    const COMMON = 150;
    const rowW = (ids: string[]) => ids.reduce((s, x) => s + widthFor(x), 0) + COMMON;
    w = Math.max(rowW(top), rowW(bot)) + WALL * 2;
    const AH = 40;
    const aY = floorTop, bY = floorTop + ZONE_H + AH;
    h = bY + ZONE_H + WALL;
    const row = (ids: string[], y: number, common: "cafe" | "lounge") => {
      const avail = w - WALL * 2;
      const extra = avail - rowW(ids);
      const each = ids.length ? Math.floor(extra / (ids.length + 1)) : 0;
      let x = WALL;
      const bounds: number[] = [];
      ids.forEach((dept) => {
        const zw = widthFor(dept) + each;
        rooms.push(buildDeptZone(deptById(dept), { x, y, w: zw, h: ZONE_H }, desks));
        x += zw;
        bounds.push(x);
      });
      const Z = { x, y, w: w - WALL - x, h: ZONE_H };
      if (common === "cafe") rooms.push(buildCafe(Z, spots, lights));
      else {
        const L = buildLounge(Z, spots, lights);
        rooms.push(L.room); dogbed = L.dogbed; catbed = L.catbed;
      }
      for (const bx of bounds.slice(0, -1)) { // the last boundary is left open: the corner flows into the floor
        // a shelf and a plant on the boundary, with the middle left open to walk through
        divider({ x: bx, y: y + 12 }, { x: bx, y: y + ZONE_H - 4 }, [[26, 70]], dividers, []);
      }
    };
    row(top, aY, "cafe");
    row(bot, bY, "lounge");
    walkways.push({ x: WALL, y: aY + ZONE_H, w: w - WALL * 2, h: AH });
    entrance = { x: 0, y: aY + ZONE_H + 12, w: WALL, h: 18 };
    corridorItems.push(
      { kind: "cooler", rect: { x: Math.round(w * 0.46), y: aY + ZONE_H - 14, w: 9, h: 18 } },
      { kind: "bench", rect: { x: Math.round(w * 0.58), y: bY - 8, w: 26, h: 9 } },
    );
  } else {
    w = 232;
    const colW = 104, corW = 24;
    const pairs = PAIRS.map(([a, b]) => [a, b].filter((d) => present.includes(d))).filter((p) => p.length) as string[][];
    const loose = present.filter((d) => !pairs.flat().includes(d));
    for (let i = 0; i < loose.length; i += 2) pairs.push(loose.slice(i, i + 2));
    const need = (dept: string | undefined) => {
      if (!dept) return 0;
      const n = agentsIn(dept).length;
      const perRow = Math.max(1, Math.floor((colW - 10 + GAP) / (DESK_W + GAP)));
      return 78 + Math.ceil(Math.max(1, n) / perRow) * 46;
    };
    const rowsSpec = pairs.map((p) => ({ l: p[0], r: p[1], rh: Math.max(need(p[0]), need(p[1])) }));
    const commonH = 150;
    let y = floorTop;
    const xl = WALL, xr = colW + corW;
    rowsSpec.forEach(({ l, r, rh }) => {
      if (l) rooms.push(buildDeptZone(deptById(l), { x: xl, y, w: colW - WALL, h: rh }, desks));
      if (r) rooms.push(buildDeptZone(deptById(r), { x: xr, y, w: w - xr - WALL, h: rh }, desks));
      y += rh;
    });
    h = y + commonH + WALL;
    rooms.push(buildCafe({ x: xl, y, w: colW - WALL, h: commonH }, spots, lights));
    const L = buildLounge({ x: xr, y, w: w - xr - WALL, h: commonH }, spots, lights);
    rooms.push(L.room); dogbed = L.dogbed; catbed = L.catbed;
    walkways.push({ x: colW, y: floorTop, w: corW, h: h - WALL - floorTop });
    // shelves and plants along both sides of the walkway, open at every zone
    const gapsFor = (side: "l" | "r") => {
      const g: [number, number][] = [];
      let yy = floorTop;
      rowsSpec.forEach(({ rh }) => { g.push([yy - floorTop + 34, yy - floorTop + rh - 18]); yy += rh; });
      g.push([yy - floorTop + 20, yy - floorTop + commonH - 10]);
      return g.filter(() => side === "l" || true);
    };
    divider({ x: colW - 3, y: floorTop + 12 }, { x: colW - 3, y: h - WALL - 4 }, gapsFor("l").map(([a, b]) => [a - 12, b - 12] as [number, number]), dividers, []);
    // between stacked zones in a column: a shelf with a gap
    let yy = floorTop;
    rowsSpec.forEach(({ rh }, i) => {
      yy += rh;
      if (i < rowsSpec.length) {
        divider({ x: xl + 4, y: yy - 3 }, { x: colW - 8, y: yy - 3 }, [[34, 62]], dividers, []);
        divider({ x: xr + 6, y: yy - 3 }, { x: w - WALL - 4, y: yy - 3 }, [[34, 62]], dividers, []);
      }
    });
    entrance = { x: colW + 4, y: h - WALL, w: 16, h: WALL };
    corridorItems.push({ kind: "cooler", rect: { x: colW + 7, y: Math.round(h * 0.4), w: 9, h: 18 } });
  }

  // the room's dividers go in with the floor items, so they draw and block like any furniture
  const dividerRooms = rooms[0]!;
  void dividerRooms;
  const allDividers = dividers;

  const floorRect: Rect = { x: WALL, y: floorTop, w: w - WALL * 2, h: h - WALL - floorTop };
  const topWall: Rect = { x: WALL, y: WALL, w: w - WALL * 2, h: FACE };

  // the back wall: windows spread along it (the sun comes through these), a clock in the middle
  const windows: Item<WallKind>[] = [];
  const backWall: Item<WallKind>[] = [];
  const nWin = Math.max(3, Math.floor(w / 78));
  for (let i = 0; i < nWin; i++) {
    const cx = WALL + ((i + 0.5) / nWin) * (w - WALL * 2);
    windows.push({ kind: "window", rect: { x: Math.round(cx - 12), y: WALL + 1, w: 24, h: 10 } });
  }
  const mid = windows[Math.floor(nWin / 2)]!;
  backWall.push({ kind: "clock", rect: { x: Math.round(mid.rect.x + mid.rect.w + 8), y: WALL + 2, w: 7, h: 7 } });

  // the water cooler: two people can stand and chat; and two places to look out of the window
  const cooler = corridorItems.find((f) => f.kind === "cooler");
  if (cooler) {
    spots.push(
      { id: "cooler-l", activity: "chat", at: { x: cooler.rect.x - 6, y: cooler.rect.y + cooler.rect.h + 4 }, face: "right", pose: "stand", group: "cooler", zone: "walkway" },
      { id: "cooler-r", activity: "chat", at: { x: cooler.rect.x + cooler.rect.w + 6, y: cooler.rect.y + cooler.rect.h + 4 }, face: "left", pose: "stand", group: "cooler", zone: "walkway" },
    );
  }
  [windows[0], windows[windows.length - 1]].forEach((win, i) => {
    if (win) spots.push({ id: `window-${i}`, activity: "window", at: { x: win.rect.x + 12, y: floorTop + 7 }, face: "back", pose: "stand", zone: "wall" });
  });

  // plants anyone can water
  const plants = [
    ...rooms.flatMap((r) => r.floor.filter((f) => f.kind === "plant" || f.kind === "plant-tall").map((f) => ({ f, zone: r.dept.id }))),
    ...allDividers.filter((f) => f.kind === "plant").map((f) => ({ f, zone: "divider" })),
  ];
  plants.forEach(({ f, zone }, i) => spots.push({ id: `plant-${i}`, activity: "plant", at: { x: f.rect.x + f.rect.w + 4, y: f.rect.y + f.rect.h + 2 }, face: "left", pose: "stand", zone }));

  // desk lamps and screens: lit when someone works there, and at dusk
  for (const d of Object.values(desks)) lights.push({ at: { x: d.desk.x + 3, y: d.desk.y - 2 }, r: 24, kind: "lamp", agent: d.agent });
  for (const r of rooms) for (const it of r.wall) if (it.kind === "screen-code" || it.kind === "screen-dash" || it.kind === "status") lights.push({ at: { x: it.rect.x + it.rect.w / 2, y: it.rect.y + it.rect.h + 3 }, r: 18, kind: "screen" });

  // the walk grid: the open floor, minus desks (and the chair behind each), furniture and dividers
  const blocks: Rect[] = [];
  for (const r of rooms) for (const f of r.floor) if (!["rug", "mat", "carpet", "tiles", "dogbed", "catbed"].includes(f.kind)) blocks.push({ x: f.rect.x, y: f.rect.y + (f.rect.h > 12 ? Math.floor(f.rect.h * 0.35) : 0), w: f.rect.w, h: f.rect.h - (f.rect.h > 12 ? Math.floor(f.rect.h * 0.35) : 0) });
  for (const r of rooms) for (const b of r.wall) blocks.push({ x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h + 2 });
  for (const f of corridorItems) blocks.push(f.rect);
  for (const f of allDividers) blocks.push(f.rect);
  for (const d of Object.values(desks)) blocks.push({ x: d.desk.x - 1, y: d.sprite.y, w: d.desk.w + 2, h: d.desk.y + d.desk.h - d.sprite.y + 1 });
  const grid = buildGrid(w, h, floorRect, blocks);

  const cafe = rooms.find((r) => r.kind === "cafe")!;
  const lounge = rooms.find((r) => r.kind === "lounge")!;
  const petHomes = {
    dogs: [
      { x: dogbed!.x + 9, y: dogbed!.y + 7 },
      { x: lounge.rect.x + Math.round(lounge.rect.w * 0.52), y: lounge.rect.y + lounge.rect.h - 6 },
      { x: lounge.rect.x + Math.round(lounge.rect.w * 0.3), y: lounge.rect.y + lounge.rect.h - 6 },
    ],
    cats: [{ x: catbed!.x + 6, y: catbed!.y + 6 }, { x: cafe.rect.x + Math.round(cafe.rect.w * 0.7), y: cafe.rect.y + Math.round(cafe.rect.h * 0.8) }],
    ball: { x: lounge.rect.x + Math.round(lounge.rect.w * 0.3), y: lounge.rect.y + Math.round(lounge.rect.h * 0.82) },
    sun: { x: cafe.rect.x + Math.round(cafe.rect.w * 0.5), y: cafe.rect.y + 34 },
  };
  const walk = (from: Pt, to: Pt) => findPath(grid, from, to);
  const randomFloor = (r1: number, r2: number): Pt => {
    // walkways first, then the shared corners
    const areas: Rect[] = [...walkways, cafe.rect, lounge.rect, ...walkways];
    const a = areas[Math.floor(r1 * areas.length) % areas.length]!;
    for (let k = 0; k < 16; k++) {
      const x = a.x + 8 + ((r1 * 997 + r2 * 131 + k * 0.618) % 1) * Math.max(1, a.w - 16);
      const y = a.y + 14 + ((r2 * 787 + k * 0.382) % 1) * Math.max(1, a.h - 22);
      const cx = Math.floor(x / grid.cell), cy = Math.floor(y / grid.cell);
      if (grid.walk[cy * grid.cols + cx]) return { x: Math.round(x), y: Math.round(y) };
    }
    const wk = walkways[0]!;
    return { x: wk.x + wk.w / 2, y: wk.y + wk.h / 2 };
  };

  // dividers belong to the floor: hang them off the first zone so the static layer draws them with the rest
  rooms[0]!.floor.push(...allDividers);

  return { orientation, w, h, floor: floorRect, topWall, windows, backWall, rooms, desks, walkways, corridorItems, entrance, spots, lights, petHomes, grid, walk, randomFloor };
}
