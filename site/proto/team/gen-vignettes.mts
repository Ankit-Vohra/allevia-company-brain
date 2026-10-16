// Bakes the small illustration at the top of each person's card on the "Meet your team" page (issue #37), from the product's own
// drawing code (web/src/office/*), so the desks, chairs, boards, plants and rugs on the website are the ones in the app.
//
// One vignette per person: their team's board standing behind the desk, a rug (drawn the way the app draws them, in a warm tone), the
// chair and the desk, on transparent ground. The person (the app's pixel sprite) sits between the chair and the desk and is
// laid over by the page as real SVG, so it can wave. Writes
//   site/proto/team/assets/v-<person>-back.svg    board, rug, plant, chair (behind the person)
//   site/proto/team/assets/v-<person>-front.svg   the desk with its screen and lamp (in front of the person)
//   site/proto/shared/team-vignettes.generated.ts each person's team hue, where they sit, and the picture's size
//
//   node site/proto/team/gen-vignettes.mts          (from the repo root; Node 24 runs TypeScript directly)
import { createServer } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ASSETS = fileURLToPath(new URL("./assets/", import.meta.url));
const OUT = fileURLToPath(new URL("../shared/team-vignettes.generated.ts", import.meta.url));
mkdirSync(ASSETS, { recursive: true });

const server = await createServer({
  root: SITE, configFile: false, appType: "custom", logLevel: "error",
  resolve: { alias: { "@shared": `${ROOT}shared` } },
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
});
const rosterMod = await server.ssrLoadModule(`${ROOT}shared/roster.ts`);
const drawMod = await server.ssrLoadModule(`${ROOT}web/src/office/draw.ts`);
const layoutMod = await server.ssrLoadModule(`${ROOT}web/src/office/layout.ts`);
const paletteMod = await server.ssrLoadModule(`${ROOT}web/src/office/palette.ts`);
const { AGENTS, DEPARTMENTS } = rosterMod as { AGENTS: any[]; DEPARTMENTS: any[] };
const { drawChair, drawDesk, drawFloorItem, drawWallItem, drawScreen, R, P } = drawMod as Record<string, any>;
const { buildLayout, WALL_SIZE } = layoutMod as { buildLayout: (o: string) => any; WALL_SIZE: Record<string, [number, number]> };
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
  /** The pixels as an SVG of one path per colour (crisp edges, one unit per logical pixel). */
  toSvg(): string {
    const w = this.w, h = this.h;
    const key = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      const a = this.data[i + 3]!;
      if (a < 3) return "";
      const hex = [0, 1, 2].map((k) => Math.round(this.data[i + k]!).toString(16).padStart(2, "0")).join("");
      return a >= 252 ? hex : `${hex}/${(a / 255).toFixed(2)}`;
    };
    type Run = { x: number; y: number; w: number; h: number; k: string };
    let open = new Map<string, Run>();
    const done: Run[] = [];
    for (let y = 0; y < h; y++) {
      const next = new Map<string, Run>();
      let x = 0;
      while (x < w) {
        const k = key(x, y);
        let len = 1;
        while (x + len < w && key(x + len, y) === k) len++;
        if (k) {
          const id = `${x}:${len}:${k}`;
          const prev = open.get(id);
          if (prev) { prev.h++; next.set(id, prev); open.delete(id); } else next.set(id, { x, y, w: len, h: 1, k });
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

// ---------- the vignettes ----------

const VW = 64, VH = 58;
const base = buildLayout("landscape");
/** What stands behind each team's desk in the app (layout.ts KIT): the board. The Library has its shelves instead. */
const BOARD: Record<string, string> = { leadership: "whiteboard", coe: "chart", analytics: "screen-dash", marketing: "pinboard", content: "clapper", tech: "screen-code", ops: "kanban", sales: "pinboard" };

// the app's rug (scene.ts drawRugTinted, which is not exported)
function rugTinted(c: any, r: any, hue: number) {
  const edge = pal.rugEdge(hue), fill = pal.rugFill(hue);
  R(c, r.x + 1, r.y, r.w - 2, r.h, edge); R(c, r.x, r.y + 1, r.w, r.h - 2, edge); R(c, r.x + 1, r.y + 1, r.w - 2, r.h - 2, fill);
  R(c, r.x + 3, r.y + 3, r.w - 6, 1, edge); R(c, r.x + 3, r.y + r.h - 4, r.w - 6, 1, edge);
  for (let y = r.y + 3; y < r.y + r.h - 3; y += 2) { P(c, r.x - 1, y, edge); P(c, r.x + r.w, y, edge); }
}
interface Person { id: string; name: string; dept: string; hue: number; sprite: { x: number; y: number }; desk: { x: number; y: number; w: number; h: number }; kind: string }
const people: Person[] = [];
for (const a of AGENTS) {
  const dept = DEPARTMENTS.find((d: any) => d.id === a.department);
  const spot = base.desks[a.id];
  const desk = { x: 18, y: 34, w: 28, h: 14 };
  const d = { ...spot, desk, sprite: { x: desk.x + 6, y: desk.y - 15 } };
  const back = new Raster(VW, VH), front = new Raster(VW, VH);
  const kind = BOARD[a.department];
  if (kind) {
    const [bw, bh] = WALL_SIZE[kind] as [number, number];
    const it = { kind, rect: { x: Math.round((VW - bw) / 2), y: 3, w: bw, h: bh } };
    drawWallItem(back as any, it, pal);
    if (kind === "screen-dash" || kind === "screen-code") drawScreen(back as any, it, pal, true, 700);
    R(back as any, it.rect.x + 2, it.rect.y + it.rect.h, 1, 2, pal.metalDark); R(back as any, it.rect.x + it.rect.w - 3, it.rect.y + it.rect.h, 1, 2, pal.metalDark);
  }
  const rug = { x: 6, y: 16, w: 52, h: 38 };
  // the site has two colours (warm paper and one dark band), so every rug is a warm tone: the one sand gold
  rugTinted(back as any, rug, 85);
  if (!kind) drawFloorItem(back as any, { kind: "bookshelf", rect: { x: 3, y: 3, w: 26, h: 26 } }, pal);
  drawFloorItem(back as any, { kind: "plant", rect: { x: 49, y: 32, w: 10, h: 14 } }, pal);
  drawChair(back as any, d, pal);
  drawDesk(front as any, d, pal, { working: true, t: 0, lamp: true });
  writeFileSync(`${ASSETS}v-${a.id}-back.svg`, back.toSvg());
  writeFileSync(`${ASSETS}v-${a.id}-front.svg`, front.toSvg());
  people.push({ id: a.id, name: a.name, dept: a.department, hue: dept.hue, sprite: d.sprite, desk, kind: spot?.kind ?? "laptop" });
}

writeFileSync(OUT, `// GENERATED by site/proto/team/gen-vignettes.mts from the app's own office code (web/src/office/*). Do not edit by hand.
// The size of each person's picture and where the person sits in it, in the office's logical pixels (the page scales them with --px).
export const VIGNETTE_W = ${VW};
export const VIGNETTE_H = ${VH};
export interface VignettePerson { id: string; name: string; dept: string; hue: number; sprite: { x: number; y: number }; desk: { x: number; y: number; w: number; h: number }; kind: string }
export const PEOPLE: VignettePerson[] = ${JSON.stringify(people)};
`);
await server.close();
console.log(`wrote ${people.length} vignettes, ${VW}x${VH}`);
