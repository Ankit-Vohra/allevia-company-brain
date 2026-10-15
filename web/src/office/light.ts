// Lighting for the office, applied over the finished scene: the same sprites and furniture at every hour. A small
// light map (ambient colour, lamp pools) is multiplied over the picture, a soft wash is screened on top, and sun patches
// fall through the windows. Everything is interpolated by the minute (see lib/daylight.ts), so the light never jumps.
import type { Lighting } from "../lib/daylight";
import type { OfficeLayout } from "./layout";

type Ctx = CanvasRenderingContext2D;

export interface LightState {
  lighting: Lighting;
  /** Desks whose agent is busy: their lamp is on whatever the hour. */
  lit: ReadonlySet<string>;
  tvPlaying: boolean;
  /** An explicit dark theme dims the whole office a touch more. */
  dark: boolean;
}

export interface LightLayer {
  canvas: HTMLCanvasElement;
  key: string;
}

export const makeLightLayer = (L: OfficeLayout): LightLayer => {
  const canvas = document.createElement("canvas");
  canvas.width = L.w;
  canvas.height = L.h;
  return { canvas, key: "" };
};

const rgb = (c: [number, number, number], a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

const frac = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
};

/** Which desk lamps are on: busy desks always; at dusk and after, most of the rest, fewer deep in the night. */
export const lampOn = (agent: string, st: LightState) => st.lit.has(agent) || (st.lighting.lamps > 0.3 && frac(agent) < 0.5 + st.lighting.lamps * 0.3);

function renderMap(layer: LightLayer, L: OfficeLayout, st: LightState) {
  const g = layer.canvas.getContext("2d")!;
  const lt = st.lighting;
  g.globalCompositeOperation = "source-over";
  const dim = st.dark ? [0.8, 0.82, 0.94] : [1, 1, 1];
  g.fillStyle = rgb([lt.ambient[0] * dim[0]!, lt.ambient[1] * dim[1]!, lt.ambient[2] * dim[2]!]);
  g.fillRect(0, 0, L.w, L.h);
  g.globalCompositeOperation = "lighter";
  const pool = (x: number, y: number, r: number, a: number, col: [number, number, number]) => {
    if (a <= 0.01) return;
    const grad = g.createRadialGradient(x, y, 1, x, y, r);
    grad.addColorStop(0, rgb(col, Math.min(1, a)));
    grad.addColorStop(0.55, rgb(col, Math.min(1, a) * 0.45));
    grad.addColorStop(1, rgb(col, 0));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  for (const l of L.lights) {
    switch (l.kind) {
      case "lamp": if (l.agent && lampOn(l.agent, st)) pool(l.at.x + 6, l.at.y + 5, l.r, 0.62, [255, 196, 120]); break;
      case "pendant": if (lt.lamps > 0.25) pool(l.at.x, l.at.y + 4, l.r * 0.9, 0.62 * lt.lamps, [255, 198, 125]); break;
      case "tv": pool(l.at.x, l.at.y + 6, l.r, st.tvPlaying ? 0.7 : 0.18 * lt.lamps, st.tvPlaying ? [150, 190, 255] : [180, 200, 255]); break;
      case "screen": if (lt.lamps > 0.25) pool(l.at.x, l.at.y, l.r, 0.4 * lt.lamps, [150, 195, 255]); break;
      case "fridge": if (lt.lamps > 0.25) pool(l.at.x, l.at.y, l.r, 0.35, [210, 230, 255]); break;
    }
  }
  g.globalCompositeOperation = "source-over";
}

/** Draw the lighting over the whole scene. The context's transform is already the office's pixel scale. */
export function drawLighting(c: Ctx, layer: LightLayer, L: OfficeLayout, st: LightState) {
  const lt = st.lighting;
  const lampKey = [...L.lights].map((l) => (l.kind === "lamp" && l.agent ? (lampOn(l.agent, st) ? 1 : 0) : 0)).join("");
  const key = [lt.ambient.map((v) => Math.round(v / 2)).join(","), Math.round(lt.lamps * 20), lampKey, st.tvPlaying ? 1 : 0, st.dark ? 1 : 0].join("|");
  if (layer.key !== key) { renderMap(layer, L, st); layer.key = key; }

  c.save();
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "low";
  c.globalCompositeOperation = "multiply";
  c.drawImage(layer.canvas, 0, 0, L.w, L.h);

  // a soft wash of the hour's colour: warm in the morning, gold before sunset, indigo at night
  if (lt.washA > 0.004) {
    c.globalCompositeOperation = "screen";
    c.fillStyle = rgb(lt.wash, lt.washA);
    c.fillRect(0, 0, L.w, L.h);
  }

  // the glow of the lamps themselves, over the dimmed room
  c.globalCompositeOperation = "screen";
  for (const l of L.lights) {
    let a = 0, col: [number, number, number] = [255, 214, 150];
    if (l.kind === "lamp" && l.agent && lampOn(l.agent, st)) a = 0.14 * Math.max(lt.lamps, st.lit.has(l.agent) ? 0.35 : 0);
    else if (l.kind === "pendant") a = 0.16 * lt.lamps;
    else if (l.kind === "tv" && st.tvPlaying) { a = 0.18; col = [150, 190, 255]; }
    if (a <= 0.01) continue;
    const grad = c.createRadialGradient(l.at.x + 4, l.at.y + 4, 1, l.at.x + 4, l.at.y + 4, l.r * 0.8);
    grad.addColorStop(0, rgb(col, a));
    grad.addColorStop(1, rgb(col, 0));
    c.fillStyle = grad;
    c.fillRect(l.at.x - l.r, l.at.y - l.r, l.r * 2 + 12, l.r * 2 + 12);
  }

  // sun patches under every window, longer and more golden toward evening
  c.globalCompositeOperation = "screen";
  c.imageSmoothingEnabled = false;
  if (lt.sun > 0.03) {
    const top = L.topWall.y + L.topWall.h + 1;
    const len = Math.round(34 * lt.sunLen);
    for (const win of L.windows) {
      const r = win.rect;
      for (let y = 0; y < len; y += 2) {
        const fade = 1 - y / len;
        const x = r.x + Math.round(lt.sunSlant * y * 0.55) - 1;
        c.fillStyle = rgb(lt.sunColor, 0.62 * lt.sun * fade);
        c.fillRect(x, top + y, r.w + 2, 2);
      }
    }
  }
  // longer shadows toward the end of the day
  if (lt.shadow > 0.08) {
    c.fillStyle = `rgba(52,38,86,${0.13 * lt.shadow})`;
    for (const d of Object.values(L.desks)) {
      c.fillRect(d.desk.x + Math.round(-lt.sunSlant * 3), d.desk.y + d.desk.h, d.desk.w, 2 + Math.round(lt.shadow * 3));
    }
  }
  c.restore();
}
