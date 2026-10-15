// Grid pathfinding for the office floor: A* over small cells, then straightened so people and pets walk in a few clean
// legs along the walkways instead of in stairs. Pure and deterministic.
import type { Pt, Rect } from "./layout";

export interface Grid {
  cell: number;
  cols: number;
  rows: number;
  walk: Uint8Array;           // 1 = can stand here
}

const CELL = 2;

const hitRect = (g: Grid, r: Rect, fill: number, pad = 0) => {
  const x0 = Math.max(0, Math.floor((r.x - pad) / g.cell)), x1 = Math.min(g.cols - 1, Math.floor((r.x + r.w + pad - 0.01) / g.cell));
  const y0 = Math.max(0, Math.floor((r.y - pad) / g.cell)), y1 = Math.min(g.rows - 1, Math.floor((r.y + r.h + pad - 0.01) / g.cell));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.walk[y * g.cols + x] = fill;
};

/** `floor` is the walkable area (the whole open floor); `blocks` are furniture, desks and dividers. */
export function buildGrid(w: number, h: number, floor: Rect, blocks: Rect[]): Grid {
  const g: Grid = { cell: CELL, cols: Math.ceil(w / CELL), rows: Math.ceil(h / CELL), walk: new Uint8Array(Math.ceil(w / CELL) * Math.ceil(h / CELL)) };
  hitRect(g, floor, 1);
  for (const b of blocks) hitRect(g, b, 0);
  return g;
}

const idx = (g: Grid, p: Pt) => Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell))) * g.cols + Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell)));

/** The nearest walkable cell to a point (spiral search). */
function snap(g: Grid, p: Pt): number {
  const cx = Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell)));
  const cy = Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell)));
  if (g.walk[cy * g.cols + cx]) return cy * g.cols + cx;
  for (let r = 1; r < 40; r++) {
    let best = -1, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= g.cols || y >= g.rows || !g.walk[y * g.cols + x]) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = y * g.cols + x; }
      }
    }
    if (best >= 0) return best;
  }
  return cy * g.cols + cx;
}

const centre = (g: Grid, i: number): Pt => ({ x: (i % g.cols) * g.cell + g.cell / 2, y: Math.floor(i / g.cols) * g.cell + g.cell / 2 });

/** Is the straight segment between two points clear of blocks? */
export function clear(g: Grid, a: Pt, b: Pt): boolean {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cell * 0.6));
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    if (!g.walk[idx(g, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })]) return false;
  }
  return true;
}

const cache = new WeakMap<Grid, Map<string, Pt[]>>();

class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(k: number, v: number) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0]![1];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

export function findPath(g: Grid, from: Pt, to: Pt): Pt[] {
  const key = `${Math.round(from.x)},${Math.round(from.y)}>${Math.round(to.x)},${Math.round(to.y)}`;
  let memo = cache.get(g);
  if (!memo) { memo = new Map(); cache.set(g, memo); }
  const hit = memo.get(key);
  if (hit) return hit.map((p) => ({ ...p }));

  const s = snap(g, from), t = snap(g, to);
  let out: Pt[];
  if (clear(g, from, to)) out = [from, to];
  else {
    const dist = new Float32Array(g.walk.length).fill(Infinity);
    const prev = new Int32Array(g.walk.length).fill(-1);
    const tp = centre(g, t);
    const h = (i: number) => { const p = centre(g, i); return Math.hypot(p.x - tp.x, p.y - tp.y); };
    const open = new Heap();
    dist[s] = 0;
    open.push(h(s), s);
    let found = false;
    const DIRS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]];
    while (open.size) {
      const cur = open.pop();
      if (cur === t) { found = true; break; }
      const cx = cur % g.cols, cy = (cur - cx) / g.cols;
      for (const [dx, dy, c] of DIRS) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) continue;
        const ni = y * g.cols + x;
        if (!g.walk[ni]) continue;
        if (dx && dy && (!g.walk[cy * g.cols + x] || !g.walk[y * g.cols + cx])) continue; // no cutting corners
        const nd = dist[cur]! + c;
        if (nd < dist[ni]!) { dist[ni] = nd; prev[ni] = cur; open.push(nd + h(ni), ni); }
      }
    }
    if (!found) out = [from, to];
    else {
      const cells: Pt[] = [];
      for (let i = t; i !== -1; i = prev[i]!) cells.push(centre(g, i));
      cells.reverse();
      // straighten: from each anchor jump to the furthest cell still in line of sight
      const pts: Pt[] = [from];
      let anchor = from, i = 0;
      while (i < cells.length) {
        let j = cells.length - 1;
        while (j > i && !clear(g, anchor, cells[j]!)) j--;
        anchor = cells[j]!;
        pts.push(anchor);
        i = j + 1;
      }
      pts.push(to);
      out = pts;
    }
  }
  memo.set(key, out);
  return out.map((p) => ({ ...p }));
}

export const pathLength = (p: Pt[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1]!.x, q.y - p[i - 1]!.y) : 0), 0);

/** The point `d` px along a path, and the heading of that leg. */
export function along(p: Pt[], d: number): { x: number; y: number; dx: number; dy: number } {
  let left = Math.max(0, d);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!, b = p[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || i === p.length - 1) {
      const u = len ? Math.min(1, left / len) : 1;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, dx: b.x - a.x, dy: b.y - a.y };
    }
    left -= len;
  }
  const e = p[p.length - 1] ?? { x: 0, y: 0 };
  return { x: e.x, y: e.y, dx: 0, dy: 1 };
}
