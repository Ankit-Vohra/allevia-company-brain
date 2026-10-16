// Bakes the pixel office for the "Meet your team" page (issue #37) from the product's own drawing code (web/src/office/*), so the
// floor, rugs, boards, shelves, plants, desks and chairs on the website are the ones in the app, not look-alikes.
//
// What it does: builds the app's landscape floor plan (layout.ts), takes each team's zone, draws it with drawStatic (scene.ts)
// into a recording "canvas" that keeps final pixels, adds the chairs, the lit screens and the desks (draw.ts), and writes
//   site/proto/team/assets/<piece>-back.svg    floor, rug, boards, shelves, chairs (behind the people)
//   site/proto/team/assets/<piece>-front.svg   the desks (in front of the people, so each person sits behind theirs)
//   site/proto/shared/team-office.generated.ts the pieces' sizes and where each desk, person and sign sits (logical pixels)
// The pieces are an entrance, the nine teams in the order of the story, and the game room where the dogs live. The people, the
// signs and the name tags are not in the pictures: they are real HTML laid over them.
//
//   node site/proto/team/gen-office.mts          (from the repo root; Node 24 runs TypeScript directly)
import { createServer } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ASSETS = fileURLToPath(new URL("./assets/", import.meta.url));
const OUT = fileURLToPath(new URL("../shared/team-office.generated.ts", import.meta.url));
mkdirSync(ASSETS, { recursive: true });

const server = await createServer({
  root: SITE, configFile: false, appType: "custom", logLevel: "error",
  resolve: { alias: { "@shared": `${ROOT}shared` } },
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
});
const layoutMod = await server.ssrLoadModule(`${ROOT}web/src/office/layout.ts`);
const sceneMod = await server.ssrLoadModule(`${ROOT}web/src/office/scene.ts`);
const drawMod = await server.ssrLoadModule(`${ROOT}web/src/office/draw.ts`);
const paletteMod = await server.ssrLoadModule(`${ROOT}web/src/office/palette.ts`);
const { buildLayout, WALL, FACE, DESK_W } = layoutMod as { buildLayout: (o: string) => any; WALL: number; FACE: number; DESK_W: number };
const { drawStatic, drawWindows, drawTv, drawStatus } = sceneMod as Record<string, any>;
const { drawChair, drawDesk, drawScreen, drawServerLeds } = drawMod as Record<string, any>;
const pal = (paletteMod as { officePalette: () => any }).officePalette();

// ---------- a canvas that keeps its pixels ----------

class Raster {
  data: Uint8ClampedArray;
  fillStyle = "#000000";
  w: number;
  h: number;
  constructor(w: number, h: number) { this.w = w; this.h = h; this.data = new Uint8ClampedArray(w * h * 4); }
  private parse(s: string): [number, number, number, number] {
    if (s.startsWith("#")) { const n = parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) throw new Error(`colour not understood: ${s}`);
    const p = m[1]!.split(",").map((x) => parseFloat(x));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b, a] = this.parse(this.fillStyle);
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x) + Math.round(w)), y1 = Math.min(this.h, Math.round(y) + Math.round(h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * this.w + xx) * 4;
      const da = this.data[i + 3]! / 255;
      const oa = a + da * (1 - a);
      if (oa <= 0) continue;
      this.data[i] = (r * a + this.data[i]! * da * (1 - a)) / oa;
      this.data[i + 1] = (g * a + this.data[i + 1]! * da * (1 - a)) / oa;
      this.data[i + 2] = (b * a + this.data[i + 2]! * da * (1 - a)) / oa;
      this.data[i + 3] = oa * 255;
    }
  }
  /** The pixels from [x0, x1) × [y0, y1) as an SVG of one path per colour (crisp edges, one unit per logical pixel). */
  toSvg(x0: number, x1: number, y0: number, y1: number): string {
    const w = x1 - x0, h = y1 - y0;
    const key = (x: number, y: number) => {
      const i = (y * this.w + x) * 4;
      const a = this.data[i + 3]!;
      if (a < 3) return "";
      const hex = [0, 1, 2].map((k) => Math.round(this.data[i + k]!).toString(16).padStart(2, "0")).join("");
      return a >= 252 ? hex : `${hex}/${(a / 255).toFixed(2)}`;
    };
    // runs along each row, then runs of identical rows merged into one taller rectangle
    type Run = { x: number; y: number; w: number; h: number; k: string };
    let open = new Map<string, Run>();
    const done: Run[] = [];
    for (let y = y0; y < y1; y++) {
      const next = new Map<string, Run>();
      let x = x0;
      while (x < x1) {
        const k = key(x, y);
        let len = 1;
        while (x + len < x1 && key(x + len, y) === k) len++;
        if (k) {
          const id = `${x}:${len}:${k}`;
          const prev = open.get(id);
          if (prev) { prev.h++; next.set(id, prev); open.delete(id); } else next.set(id, { x: x - x0, y: y - y0, w: len, h: 1, k });
        }
        x += len;
      }
      for (const r of open.values()) done.push(r);
      open = next;
    }
    for (const r of open.values()) done.push(r);
    const byColour = new Map<string, string[]>();
    for (const r of done) (byColour.get(r.k) ?? byColour.set(r.k, []).get(r.k)!).push(`M${r.x} ${r.y}h${r.w}v${r.h}h-${r.w}z`);
    const paths = [...byColour].map(([k, d]) => {
      const [hex, a] = k.split("/");
      return `<path fill="#${hex}"${a ? ` fill-opacity="${a}"` : ""} d="${d.join("")}"/>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">${paths}</svg>\n`;
  }
}

// ---------- the pieces ----------

const base = buildLayout("landscape");
const FLOOR_TOP = WALL + FACE;       // 16
const ZONE_H = 92;
const LANE_H = 40;
const H = FLOOR_TOP + ZONE_H + LANE_H + WALL;   // the picture is this tall for every piece: 152

/** The story's order: the founder's list (Chief of Staff, Numbers, Analytics, Marketing, Content Studio, Sales, Tech, Ops, Library). */
const ORDER = ["leadership", "coe", "analytics", "marketing", "content", "sales", "tech", "ops", "knowledge"];

const moveRect = (r: any, dx: number, dy: number) => ({ ...r, x: r.x + dx, y: r.y + dy });

interface PieceOut {
  id: string; kind: "entrance" | "zone" | "lounge"; dept: string; name: string; w: number; h: number;
  sign: { x: number; y: number };
  agents: { id: string; sprite: { x: number; y: number }; desk: { x: number; y: number; w: number; h: number }; kind: string }[];
  dogbed?: { x: number; y: number; w: number; h: number };
  tv?: { x: number; y: number; w: number; h: number };
}
const pieces: PieceOut[] = [];

function makePiece(id: string, kind: PieceOut["kind"], roomIn: any | null, widthIn: number) {
  const zw = roomIn ? roomIn.rect.w : widthIn;
  const dx = roomIn ? WALL - roomIn.rect.x : 0;
  const dy = roomIn ? FLOOR_TOP - roomIn.rect.y : 0;
  const W = WALL + zw + WALL;
  const inZone = (it: any) => it.rect.x >= roomIn.rect.x - 1 && it.rect.x + it.rect.w <= roomIn.rect.x + roomIn.rect.w + 1;
  const room = roomIn && {
    ...roomIn,
    rect: moveRect(roomIn.rect, dx, dy), inner: moveRect(roomIn.inner, dx, dy),
    sign: { x: roomIn.sign.x + dx, y: FLOOR_TOP + 4 },       // the cords are drawn in HTML with the sign, so the picture keeps only a stub
    label: { x: roomIn.sign.x + dx, y: FLOOR_TOP + 4 },
    wall: roomIn.wall.map((it: any) => ({ ...it, rect: moveRect(it.rect, dx, dy) })),
    floor: roomIn.floor.filter(inZone).map((it: any) => ({ ...it, rect: moveRect(it.rect, dx, dy) })),
  };
  const winX = WALL + Math.round((zw - 24) / 2);
  const L = {
    orientation: "landscape", w: W, h: H,
    floor: { x: WALL, y: FLOOR_TOP, w: zw, h: ZONE_H + LANE_H },
    topWall: { x: WALL, y: WALL, w: zw, h: FACE },
    windows: [{ kind: "window", rect: { x: winX, y: WALL + 1, w: 24, h: 10 } }],
    backWall: [] as any[],
    rooms: room ? [room] : [],
    walkways: [{ x: WALL, y: FLOOR_TOP + ZONE_H, w: zw, h: LANE_H }],
    corridorItems: [] as any[],
    entrance: kind === "entrance" ? { x: 0, y: FLOOR_TOP + ZONE_H + 12, w: WALL, h: 18 } : { x: 0, y: 0, w: 0, h: 0 },
  };
  const back = new Raster(W, H);
  drawStatic(back as any, L, pal);
  drawWindows(back as any, L, 10 * 60 + 30);
  for (const it of L.rooms.flatMap((r: any) => r.wall)) {
    if (it.kind === "screen-dash" || it.kind === "screen-code") drawScreen(back as any, it, pal, true, 700);
    if (it.kind === "status") drawStatus(back as any, it.rect, pal, 0, false);
    if (it.kind === "tv") drawTv(back as any, it.rect, pal, true, 400);
  }
  for (const it of L.rooms.flatMap((r: any) => r.floor)) if (it.kind === "server") drawServerLeds(back as any, it.rect, pal, true, 300);

  const front = new Raster(W, H);
  const agents: PieceOut["agents"] = [];
  if (roomIn) {
    for (const agentId of roomIn.agents as string[]) {
      const d0 = base.desks[agentId];
      const d = { ...d0, desk: moveRect(d0.desk, dx, dy), sprite: { x: d0.sprite.x + dx, y: d0.sprite.y + dy } };
      drawChair(back as any, d, pal);
      drawDesk(front as any, d, pal, { working: true, t: 0, lamp: true });
      agents.push({ id: agentId, sprite: { x: d.sprite.x, y: d.sprite.y }, desk: { x: d.desk.x, y: d.desk.y, w: d.desk.w, h: d.desk.h }, kind: d.kind });
    }
  }
  const x0 = kind === "entrance" ? 0 : WALL;
  const x1 = kind === "lounge" ? W : WALL + zw;
  writeFileSync(`${ASSETS}${id}-back.svg`, back.toSvg(x0, x1, 0, H));
  if (agents.length) writeFileSync(`${ASSETS}${id}-front.svg`, front.toSvg(x0, x1, 0, H));
  const offX = x0;   // local x = canvas x - offX
  const out: PieceOut = {
    id, kind, dept: roomIn?.dept.id ?? id, name: roomIn?.dept.name ?? "",
    w: x1 - x0, h: H,
    sign: room ? { x: room.sign.x - offX, y: FLOOR_TOP + 6 } : { x: 0, y: 0 },
    agents: agents.map((a) => ({ ...a, sprite: { x: a.sprite.x - offX, y: a.sprite.y }, desk: { ...a.desk, x: a.desk.x - offX } })),
  };
  const bed = room?.floor.find((f: any) => f.kind === "dogbed");
  if (bed) out.dogbed = { x: bed.rect.x - offX, y: bed.rect.y, w: bed.rect.w, h: bed.rect.h };
  const tv = room?.wall.find((f: any) => f.kind === "tv");
  if (tv) out.tv = { x: tv.rect.x - offX, y: tv.rect.y, w: tv.rect.w, h: tv.rect.h };
  pieces.push(out);
}

makePiece("entrance", "entrance", null, 44);
for (const dept of ORDER) makePiece(`zone-${dept}`, "zone", base.rooms.find((r: any) => r.kind === "dept" && r.dept.id === dept), 0);
makePiece("lounge", "lounge", base.rooms.find((r: any) => r.kind === "lounge"), 0);
pieces[pieces.length - 1]!.name = "Game room";

const body = `// GENERATED by site/proto/team/gen-office.mts from the app's own office code (web/src/office/*). Do not edit by hand.
// Sizes and positions are in the office's logical pixels (one pixel of the app's canvas); the page scales them with --px.
export interface OfficePiece {
  id: string; kind: "entrance" | "zone" | "lounge"; dept: string; name: string; w: number; h: number;
  sign: { x: number; y: number };
  agents: { id: string; sprite: { x: number; y: number }; desk: { x: number; y: number; w: number; h: number }; kind: string }[];
  dogbed?: { x: number; y: number; w: number; h: number };
  tv?: { x: number; y: number; w: number; h: number };
}
export const OFFICE_H = ${H};
export const FLOOR_TOP = ${FLOOR_TOP};
export const LANE_TOP = ${FLOOR_TOP + ZONE_H};
export const LANE_BOTTOM = ${FLOOR_TOP + ZONE_H + LANE_H};
export const DESK_WIDTH = ${DESK_W};
export const PIECES: OfficePiece[] = ${JSON.stringify(pieces, null, 1)};
`;
writeFileSync(OUT, body);
await server.close();
console.log(`wrote ${pieces.length} pieces, ${pieces.reduce((s, p) => s + p.w, 0)} logical px wide, ${H} tall`);
